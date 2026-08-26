import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { performance } from "node:perf_hooks";
import { env } from "../config/env.js";
import { attachRedisErrorHandler } from "../core/redis-events.js";
import type { JobProgress, WorkerContext } from "./job-contracts.js";
import {
  LinkBucketStore,
  GLOBAL_VALIDATOR_SCOPE,
  type LinkRecord,
} from "../links/link-bucket-store.js";
import { claimValidatorMainLinks } from "../links/validator-operations.js";
import {
  canonicalizeHttpUrl,
  isWhatsAppGroupInviteUrl,
} from "../links/url-canonicalization.js";
import {
  getWhatsAppSocket,
  waitForWhatsAppSessionReady,
} from "../whatsapp/session-manager.js";
import {
  queueWorkloadCommand,
  waitForWorkloadCommand,
} from "../workload/service.js";
import {
  getBroadcastProgress,
  requestBroadcastCancellation,
} from "../workload/broadcast-progress.js";
import {
  getSession,
  getSessionJoinSettings,
  listAllSessions,
  listSessions,
  refreshSessionRegistry,
  updateSession,
} from "../core/session-registry.js";
import {
  listGroups,
  getGroupModerationSnapshot,
  updateGroupParticipantRole,
  updateGroupParticipantBatch,
  updateGroupJoinRequests,
  updateParticipantBlockStatus,
  sendGroupMentions,
  sendGroupStatus,
  sendGroupColorStatus,
  sendGroupText,
  sendDirectText,
  type GroupMediaPayload,
  validateInviteLink,
} from "../whatsapp/transport-adapter.js";
import {
  readJobMedia,
  type JobMediaReference,
} from "../whatsapp/job-media-store.js";
import {
  listHealthyWhatsAppSessions,
  selectHealthyWhatsAppSession,
} from "../whatsapp/session-allocator.js";
import { runBoundedBatch } from "./bounded-batch.js";
import { JobOrchestrator } from "./job-orchestrator.js";
import { getInceptor, startInceptor } from "./inceptor.js";
import {
  joinFailureIsTemporary,
  joinRestrictionStopReached,
  joinWhatsAppInvite,
  remixJoinRecords,
  selectJoinInventoryRecords,
  type JoinAttemptResult,
} from "./join-operation.js";
import { downloadPlay, withMediaDownloadSlot, type PlayMode } from "../whatsapp/play-media.js";
import {
  purgeAutoPromoteSession,
  recordAutoPromoteChildCompletion,
  recordAutoPromoteProgress,
} from "../autopromote/service.js";
import {
  acquireSessionOperationLock,
  type SessionLock,
} from "../core/session-lock.js";
import {
  JoinResultStore,
  joinOutcomeFromClassification,
  type JoinResultOutcome,
} from "./join-result-store.js";

interface LinkValidationPayload {
  urls?: string[];
  sourceUserId?: string;
  sourceSessionId?: string;
  validationLeaseToken?: string;
}

interface PlayDownloadPayload {
  query?: string;
  mode?: PlayMode;
  sourceChatJid?: string;
  metadata?: import("../whatsapp/play-media.js").PlayMetadata;
}

interface GroupControlPayload {
  groupJid: string;
  operation: "approve" | "reject" | "participant";
  participants: string[];
  participantAction?: "promote" | "demote" | "remove" | "block" | "demote-remove";
}

type JoinFailureClass =
  | "already-member"
  | "invalid-invite"
  | "expired"
  | "group-unavailable"
  | "permission-denied"
  | "rate-limit"
  | "timeout"
  | "network-error"
  | "internal-error";
function isConfirmedInaccessibleGroupError(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "group is locked",
    "group locked",
    "group banned",
    "group was banned",
    "group does not exist",
    "group not found",
    "not a participant",
    "not in the group",
    "you were removed",
    "you were kicked",
    "kicked from the group",
    "revoked group",
    "invalid group",
  ].some((marker) => lower.includes(marker));
}

function classifyJoinFailure(error: unknown): {
  classification: JoinFailureClass;
  retryable: boolean;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  if (lower.includes("already") || lower.includes("409"))
    return { classification: "already-member", retryable: false, message };
  if (/expired|revoked|invite.*expired/.test(lower))
    return { classification: "expired", retryable: false, message };
  if (/invalid invite|invalid group|group (?:is )?not found|group does not exist/.test(lower))
    return { classification: "invalid-invite", retryable: false, message };
  if (/group unavailable|group locked|group banned|not a participant|kicked|removed/.test(lower))
    return { classification: "group-unavailable", retryable: false, message };
  if (statusCode === 401 || statusCode === 403 || /forbidden|not allowed|unauthorized|permission denied/.test(lower))
    return { classification: "permission-denied", retryable: false, message };
  if (/rate.?limit|too many requests|\b429\b|flood|throttl|temporarily banned|try again later|spam.?limit/.test(lower))
    return { classification: "rate-limit", retryable: false, message };
  if (statusCode === 408 || statusCode === 504 || /timeout|timed out/.test(lower))
    return { classification: "timeout", retryable: true, message };
  if (/network|econn|socket|closed|not connected|dns|fetch failed/.test(lower))
    return { classification: "network-error", retryable: true, message };
  return { classification: "internal-error", retryable: false, message };
}

function classifyJoinAttempt(result: JoinAttemptResult): {
  classification: JoinFailureClass;
  retryable: boolean;
  message: string;
} {
  if (result.linkUnavailable)
    return { classification: "invalid-invite", retryable: false, message: result.error ?? "Invite is unavailable." };
  if (result.groupFull)
    return { classification: "group-unavailable", retryable: false, message: result.error ?? "Group is full." };
  if (result.accountRestricted)
    return { classification: "rate-limit", retryable: false, message: result.error ?? "WhatsApp restricted this account." };
  if (result.rateLimited)
    return { classification: "rate-limit", retryable: true, message: result.error ?? "This join endpoint is temporarily throttled." };
  return classifyJoinFailure(result.error ?? "Join failed");
}

let activeRuntime: JobOrchestrator | undefined;
let jobCompletionNotifier:
  ((job: import("./job-contracts.js").JobRecord) => Promise<void>) | undefined;
let activeBuckets: LinkBucketStore | undefined;
let activeJoinResults: JoinResultStore | undefined;
let validatorSweepTimer: NodeJS.Timeout | undefined;
let validatorGuardTimer: NodeJS.Timeout | undefined;
let validatorGuardBusy = false;
const VALIDATOR_GUARD_INTERVAL_MS = 15_000;
const VALIDATOR_RETIRE_MS = 15 * 60_000;
// validatorRetiredUntil: Date.now() + VALIDATOR_RETIRE_MS
const VALIDATING_STALE_MS = 10 * 60_000;
const validatorGuardStartedAt = Date.now();

function isInviteValidationRateLimited(message: string): boolean {
  return /growth[- ]locked|rate.?limit|429|flood|throttl|spam.?limit|temporarily banned|try again later/i.test(
    message,
  );
}

function isInviteValidationPermanentFailure(message: string): boolean {
  // Only link-specific, confirmed invalidity may enter Dead. Generic
  // authorization, network, timeout, and session errors remain retryable.
  return /invalid whatsapp group invite|unknown invite|group not found|invite not found|expired invite|revoked invite|gone/i.test(
    message,
  );
}

export function getWorkerRuntime(): JobOrchestrator | undefined {
  return activeRuntime;
}

export function getInceptorSnapshot() {
  return getInceptor()?.getSnapshot();
}

export async function runInceptorSweep() {
  return getInceptor()?.sweep();
}

export async function runValidatorSweepNow(): Promise<void> {
  if (activeRuntime && activeBuckets)
    await sweepPendingMainValidation(activeRuntime, activeBuckets);
}

export function setJobCompletionNotifier(
  notifier: (job: import("./job-contracts.js").JobRecord) => Promise<void>,
): void {
  jobCompletionNotifier = notifier;
}

export async function purgeRuntimeSessionData(
  workspaceId: string,
  sessionId: string,
): Promise<{
  jobs: number;
  links: number;
  autoPromoteConfigs: number;
  autoPromoteRuns: number;
}> {
  const jobs = activeRuntime
    ? await activeRuntime.purgeSession(workspaceId, sessionId)
    : 0;
  const links = activeBuckets
    ? await activeBuckets.removeSourceSession(workspaceId, sessionId)
    : 0;
  const autoPromote = await purgeAutoPromoteSession(
    sessionId,
    activeRuntime ?? undefined,
  );
  return {
    jobs,
    links,
    autoPromoteConfigs: autoPromote.configs,
    autoPromoteRuns: autoPromote.runs,
  };
}

export function startWorkerRuntime(): JobOrchestrator {
  if (activeRuntime) return activeRuntime;
  const orchestrator = new JobOrchestrator(
    env.PROCESS_ROLE === "worker"
      ? env.WORKER_CONCURRENCY
      : env.QUEUE_CONCURRENCY,
  );
  activeRuntime = orchestrator;
  orchestrator.addCompletionHook(async (job) => {
    await recordAutoPromoteChildCompletion(job).catch((error) => {
      console.error(
        "[pappy-omega-mini] Auto Promote completion persistence failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    if (jobCompletionNotifier) await jobCompletionNotifier(job);
  });
  const redis = attachRedisErrorHandler(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    "job-runtime",
  );
  const buckets = new LinkBucketStore(redis);
  const markBroadcastDelivered = async (
    jobId: string,
    kind: string,
    jid: string,
    repeatIndex: number,
  ): Promise<boolean> => {
    const key = `pappy-omega-mini:broadcast-done:${jobId}:${kind}:${encodeURIComponent(jid)}:${repeatIndex}`;
    try {
      return (await redis.get(key)) !== "done";
    } catch {
      return true;
    }
  };
  const recordBroadcastDelivered = async (
    jobId: string,
    kind: string,
    jid: string,
    repeatIndex: number,
  ): Promise<void> => {
    const key = `pappy-omega-mini:broadcast-done:${jobId}:${kind}:${encodeURIComponent(jid)}:${repeatIndex}`;
    await redis
      .set(key, "done", "EX", 60 * 60 * 24 * 30)
      .catch(() => undefined);
  };
  const notifyBroadcastReady = async (
    context: WorkerContext,
    kind: "allstatus" | "allchat",
    totalGroups: number,
    repeat: number,
    delayMs: number,
  ): Promise<void> => {
    const payload = context.job.payload as { sourceChatJid?: unknown };
    const sourceChatJid =
      typeof payload.sourceChatJid === "string" ? payload.sourceChatJid : "";
    const code = context.job.jobCode;
    if (!sourceChatJid || !code || !context.job.sessionId) return;
    const marker = `pappy-omega-mini:broadcast-ready:${context.job.jobId}`;
    const claimed = await redis
      .set(marker, "1", "EX", 60 * 60 * 24 * 30, "NX")
      .catch(() => null);
    if (claimed !== "OK") return;
    const expectedPosts = totalGroups * repeat;
    const expectedSeconds = Math.max(
      0,
      Math.ceil((Math.max(0, expectedPosts - 1) * delayMs) / 1000),
    );
    const minutes = Math.floor(expectedSeconds / 60);
    const seconds = expectedSeconds % 60;
    const label = kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT";
    const action =
      kind === "allstatus"
        ? "Status delivery is now posting to every resolved group."
        : "Hidden-member mention delivery is now posting to every resolved group.";
    void sendDirectText(
      context.job.workspaceId,
      context.job.sessionId,
      sourceChatJid,
      [
        `✦ PAPPY OMEGA MINI · ${label} READY`,
        "─────────────────────",
        `Total groups  · ${totalGroups}`,
        `Expected posts · ${expectedPosts}`,
        `Delay         · ${Math.max(1, Math.round(delayMs / 1000))}s`,
        `Expected time · ${minutes}m ${seconds}s`,
        `Live code     · ${code}`,
        `Action        · ${action}`,
      ].join("\n"),
    ).catch((error) =>
      console.error(
        `[pappy-omega-mini] WhatsApp READY report failed job=${code}:`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  };
  const joinResults = new JoinResultStore(redis);
  activeBuckets = buckets;
  activeJoinResults = joinResults;
  orchestrator.addCloseHook(async () => {
    if (validatorSweepTimer) clearInterval(validatorSweepTimer);
    if (validatorGuardTimer) clearInterval(validatorGuardTimer);
    validatorSweepTimer = undefined;
    validatorGuardTimer = undefined;
    await redis.quit();
  });

  orchestrator.register("play-download", async (context) => {
    const sessionId = context.job.sessionId;
    const payload = context.job.payload as PlayDownloadPayload;
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    const mode = payload.mode === "video" ? "video" : payload.mode === "audio" ? "audio" : undefined;
    const sourceChatJid = typeof payload.sourceChatJid === "string" ? payload.sourceChatJid.trim() : "";
    const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : undefined;
    if (!sessionId || !query || !mode || !sourceChatJid)
      throw new Error("Play download payload is incomplete.");
    if (context.isCancellationRequested()) return { success: 0, failed: 0, skipped: 1 };
    await waitForWhatsAppSessionReady(context.job.workspaceId, sessionId, 60_000);
    await context.report({ total: 1, currentAction: `downloading ${mode}`, lastResult: "Media source accepted; download is isolated from command handling." });
    const result = await withMediaDownloadSlot(() => downloadPlay(query, mode, metadata));
    if (context.isCancellationRequested()) return { success: 0, failed: 0, skipped: 1 };
    await sendGroupText(context.job.workspaceId, sessionId, sourceChatJid, `${mode === "audio" ? "🎵 Audio" : "🎬 Video"} ready · ${result.metadata.title}`, result.media);
    await context.report({ completed: 1, success: 1, failed: 0, skipped: 0, currentAction: "delivered", lastResult: "Media delivered." });
    return { success: 1, failed: 0, skipped: 0 };
  });

  orchestrator.register("link-validation", async (context) => {
    const payload = context.job.payload as LinkValidationPayload;
    const urls = payload.urls ?? [];
    let stopBatchForRateLimit = false;
    return runBoundedBatch({
      items: urls,
      // One validation request at a time per WhatsApp socket. Separate
      // sessions are isolated by their independent validator jobs.
      concurrency: 1,
      context,
      shouldStop: () => stopBatchForRateLimit,
      processItem: async (url) => {
        const raw = url.trim();
        await context.report({
          currentLink: raw,
          currentAction: "validating",
        });
        try {
          const parsed = new URL(raw);
          if (!["http:", "https:"].includes(parsed.protocol))
            return { status: "failed" as const };
          const canonicalUrl = canonicalizeHttpUrl(raw);
          const inviteCode = canonicalUrl.match(
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/,
          )?.[1];
          if (!inviteCode)
            throw new Error("Invalid WhatsApp group invite link.");
          const candidates = listHealthyWhatsAppSessions(
            context.job.workspaceId,
            payload.sourceSessionId,
          );
          const sourceSession =
            candidates[0] ??
            selectHealthyWhatsAppSession(
              context.job.workspaceId,
              payload.sourceSessionId,
              canonicalUrl,
            );
          if (!sourceSession)
            throw new Error(
              "No healthy WhatsApp validation session is available yet.",
            );
          const existing = await buckets.get(
            GLOBAL_VALIDATOR_SCOPE,
            canonicalUrl,
          );
          if (!existing || existing.bucket !== "validating")
            return { status: "skipped" as const };
          const leaseToken = payload.validationLeaseToken;
          if (!leaseToken) return { status: "skipped" as const };
          if (
            existing.metadata?.validationLeaseToken &&
            payload.validationLeaseToken &&
            existing.metadata.validationLeaseToken !==
              payload.validationLeaseToken
          )
            return { status: "skipped" as const };
          if (existing.metadata?.validationLeaseToken !== leaseToken) {
            await buckets.move(
              GLOBAL_VALIDATOR_SCOPE,
              canonicalUrl,
              "validating",
              {
                sourceSessionId: sourceSession.sessionId,
                metadata: {
                  ...(existing.metadata ?? {}),
                  inviteCode,
                  validationLeaseToken: leaseToken,
                  needsValidation: false,
                  validationState: "validating",
                },
              },
            );
          }
          let metadata:
            Awaited<ReturnType<typeof validateInviteLink>> | undefined;
          let sourceSessionId: string | undefined;
          let lastValidationError: unknown;
          for (const candidate of candidates.length
            ? candidates
            : [sourceSession]) {
            try {
              metadata = await validateInviteLink(
                context.job.workspaceId,
                candidate.sessionId,
                inviteCode,
              );
              sourceSessionId = candidate.sessionId;
              break;
            } catch (error) {
              lastValidationError = error;
              const validationMessage =
                error instanceof Error ? error.message : String(error);
              if (isInviteValidationRateLimited(validationMessage)) {
                const currentSession = getSession(
                  context.job.workspaceId,
                  candidate.sessionId,
                );
                const consecutiveRateLimitCount =
                  (currentSession.validatorConsecutiveRateLimitCount ?? 0) + 1;
                updateSession(context.job.workspaceId, candidate.sessionId, {
                  validatorFailureCount:
                    (currentSession.validatorFailureCount ?? 0) + 1,
                  validatorRateLimitCount:
                    (currentSession.validatorRateLimitCount ?? 0) + 1,
                  validatorConsecutiveRateLimitCount: consecutiveRateLimitCount,
                  validatorRetiredUntil: Date.now() - 1,
                  validatorRetireReason:
                    "per-link rate-limit; session retained for validation",
                });
              }
              if (isInviteValidationPermanentFailure(validationMessage)) break;
            }
          }
          if (!metadata || !sourceSessionId)
            throw lastValidationError instanceof Error
              ? lastValidationError
              : new Error("Invite validation failed on all healthy sessions.");
          const currentRecord = await buckets.get(
            GLOBAL_VALIDATOR_SCOPE,
            canonicalUrl,
          );
          if (
            !currentRecord ||
            currentRecord.bucket !== "validating" ||
            currentRecord.metadata?.validationLeaseToken !== leaseToken
          )
            return { status: "skipped" as const };
          const movedActive = await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            canonicalUrl,
            "active",
            {
              originalUrl: raw,
              sourceUserId: payload.sourceUserId ?? currentRecord.sourceUserId,
              sourceSessionId,
              metadata: {
                ...(currentRecord.metadata ?? {}),
                ...(metadata.subject ? { title: metadata.subject } : {}),
                ...(metadata.participantCount !== undefined
                  ? { memberCount: metadata.participantCount }
                  : {}),
                inviteCode,
                needsValidation: false,
                validationState: "active",
              },
            },
          );
          if (!movedActive) return { status: "skipped" as const };
          await buckets.clearValidationError(
            GLOBAL_VALIDATOR_SCOPE,
            canonicalUrl,
          );
          const currentSession = getSession(
            context.job.workspaceId,
            sourceSessionId,
          );
          updateSession(context.job.workspaceId, sourceSessionId, {
            validatedLinkCount: (currentSession.validatedLinkCount ?? 0) + 1,
            lastLinkValidatedAt: Date.now(),
            validatorConsecutiveRateLimitCount: 0,
            validatorLastSuccessAt: Date.now(),
            validatorRetiredUntil: Date.now() - 1,
            validatorRetireReason:
              "recovered after successful invite validation",
          });
          await context.report({
            currentLink: canonicalUrl,
            currentAction: "validated",
            lastResult: `Active: ${metadata.subject ?? canonicalUrl}`,
          });
          if (currentSession.autoJoinEnabled && activeRuntime) {
            const defaults = getSessionJoinSettings(
              context.job.workspaceId,
              sourceSessionId,
            );
            const autoJoinHash = createHash("sha256")
              .update(
                `${context.job.workspaceId}:${sourceSessionId}:${canonicalUrl}`,
              )
              .digest("hex");
            await activeRuntime.enqueue({
              workspaceId: context.job.workspaceId,
              sessionId: sourceSessionId,
              kind: "join-manager",
              payload: {
                targetCount: 1,
                delayMs: defaults.delayMs,
                minDelayMs: defaults.minDelayMs,
                maxDelayMs: defaults.maxDelayMs,
                retryLimit: defaults.retryLimit,
                retryBaseMs: defaults.retryBaseMs,
                sessionCooldownMs: defaults.sessionCooldownMs,
                restrictionThreshold: defaults.restrictionThreshold,
                requestMode: defaults.mode,
                sourceSessionId,
                selectedLinks: [canonicalUrl],
              },
              idempotencyKey: `auto-join:${context.job.workspaceId}:${sourceSessionId}:${autoJoinHash}`,
            });
          }
          return { status: "success" as const };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const parsed = (() => {
            try {
              return canonicalizeHttpUrl(raw);
            } catch {
              return raw;
            }
          })();
          await context.report({
            currentLink: parsed,
            currentAction: "validation failed",
            lastResult: message.slice(0, 240),
          });
          const lower = message.toLowerCase();
          const isRateLimited = isInviteValidationRateLimited(lower);
          const isDead = isInviteValidationPermanentFailure(lower);
          if (isRateLimited) {
            stopBatchForRateLimit = true;
            await Promise.all(
              urls
                .filter((batchUrl) => batchUrl.trim() !== raw)
                .map(async (batchUrl) => {
                  const batchCanonical = (() => {
                    try {
                      return canonicalizeHttpUrl(batchUrl);
                    } catch {
                      return batchUrl.trim();
                    }
                  })();
                  const batchRecord = await buckets.get(
                    GLOBAL_VALIDATOR_SCOPE,
                    batchCanonical,
                  );
                  if (
                    batchRecord?.bucket === "validating" &&
                    batchRecord.metadata?.validationLeaseToken ===
                      payload.validationLeaseToken
                  )
                    await buckets.move(
                      GLOBAL_VALIDATOR_SCOPE,
                      batchCanonical,
                      "error",
                      {
                        validationError: message.slice(0, 240),
                        metadata: {
                          ...(batchRecord.metadata ?? {}),
                          needsValidation: false,
                          validationState: "retryable-error",
                        },
                      },
                    );
                }),
            );
          }
          const existing = await buckets.get(GLOBAL_VALIDATOR_SCOPE, parsed);
          if (
            !existing ||
            existing.bucket !== "validating" ||
            !payload.validationLeaseToken ||
            existing.metadata?.validationLeaseToken !==
              payload.validationLeaseToken
          )
            return { status: "skipped" as const };
          await buckets
            .move(GLOBAL_VALIDATOR_SCOPE, parsed, isDead ? "dead" : "error", {
              validationError: message.slice(0, 240),
              metadata: {
                ...(existing?.metadata ?? {}),
                needsValidation: false,
                validationState: isDead ? "dead" : "retryable-error",
              },
            })
            .catch(() => undefined);
          return { status: "failed" as const };
        }
      },
    });
  });

  orchestrator.register("link-collection", async (context) => {
    const payload = context.job.payload as LinkValidationPayload;
    return runBoundedBatch({
      items: payload.urls ?? [],
      concurrency: env.QUEUE_CONCURRENCY,
      context,
      processItem: async (url) => {
        try {
          const raw = url.trim();
          if (!isWhatsAppGroupInviteUrl(raw))
            return { status: "skipped" as const };
          const parsed = new URL(raw);
          const canonicalUrl = canonicalizeHttpUrl(raw);
          await buckets.upsert({
            canonicalUrl,
            originalUrl: url,
            bucket: "main",
            workspaceId: context.job.workspaceId,
            sourceUserId: payload.sourceUserId ?? "collector",
            ...(payload.sourceSessionId
              ? { sourceSessionId: payload.sourceSessionId }
              : {}),
            metadata: { needsValidation: true },
          });
          return { status: "success" as const };
        } catch {
          return { status: "failed" as const };
        }
      },
    });
  });

  orchestrator.register("group-control", async (context) => {
    const sessionId = context.job.sessionId;
    if (!sessionId) throw new Error("Group Control requires a selected WhatsApp session.");
    const payload = context.job.payload as Partial<GroupControlPayload>;
    const groupJid = typeof payload.groupJid === "string" ? payload.groupJid : "";
    const operation = payload.operation;
    const participants = Array.isArray(payload.participants)
      ? payload.participants.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (!groupJid || !operation || participants.length === 0)
      throw new Error("Group Control payload is incomplete.");
    if (operation === "participant" && !payload.participantAction)
      throw new Error("Participant Group Control requires an action.");
    const participantAction = payload.participantAction;
    await waitForWhatsAppSessionReady(context.job.workspaceId, sessionId, 90_000);
    const snapshot = await getGroupModerationSnapshot(
      context.job.workspaceId,
      sessionId,
      groupJid,
    );
    if (!snapshot.isAdmin)
      throw new Error("This WhatsApp identity is no longer an administrator in the selected group.");
    let completed = 0;
    let failed = 0;
    await context.report({
      total: participants.length,
      currentGroup: groupJid,
      currentAction: `processing ${operation} batch`,
      lastResult: `Admin access confirmed for ${snapshot.subject}.`,
    });
    if (operation === "approve" || operation === "reject") {
      let remaining = [...participants];
      let batchAttempts = 0;
      while (remaining.length > 0 && !context.isCancellationRequested()) {
        await context.waitIfPaused();
        try {
          const result = await updateGroupJoinRequests(
            context.job.workspaceId,
            sessionId,
            groupJid,
            remaining,
            operation,
            false,
          );
          const returnedSuccessful = new Set(result.succeededJids);
          const returnedFailed = new Set(
            result.failures
              .map((failure) => failure.jid)
              .filter((jid): jid is string => Boolean(jid)),
          );
          const nextRemaining = remaining.filter(
            (jid) => !returnedSuccessful.has(jid) && !returnedFailed.has(jid),
          );
          completed += result.succeeded;
          failed += result.failures.filter((failure) => failure.status !== "not-returned").length;
          remaining = nextRemaining;
          batchAttempts += 1;
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: `${operation} batch progress`,
            lastResult: `${completed}/${participants.length} requests confirmed; ${remaining.length} remaining.`,
          });
          if (remaining.length === 0) break;
          if (batchAttempts >= 2) {
            // Some deployed Baileys/WhatsApp combinations return only the
            // first participant from a multi-participant action. Preserve the
            // one-command/batch UX, but finish the unreturned tail safely.
            for (const participant of remaining) {
              if (context.isCancellationRequested()) break;
              try {
                const single = await updateGroupJoinRequests(
                  context.job.workspaceId,
                  sessionId,
                  groupJid,
                  [participant],
                  operation,
                  false,
                );
                completed += single.succeeded;
                failed += single.failed;
                await context.report({
                  completed: completed + failed,
                  success: completed,
                  failed,
                  currentAction: `${operation} batch completion`,
                  lastResult: `${completed}/${participants.length} requests confirmed; finishing the remaining batch tail.`,
                });
              } catch (error) {
                failed += 1;
                await context.report({
                  completed: completed + failed,
                  success: completed,
                  failed,
                  currentAction: `${operation} batch partial failure`,
                  lastResult: error instanceof Error ? error.message : String(error),
                });
              }
            }
            remaining = [];
          }
        } catch (error) {
          batchAttempts += 1;
          if (batchAttempts >= 2) {
            failed += remaining.length;
            remaining = [];
          }
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: `${operation} batch retry`,
            lastResult: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else if (participantAction === "demote-remove") {
      for (const participant of participants) {
        await context.waitIfPaused();
        if (context.isCancellationRequested()) break;
        try {
          await updateGroupParticipantRole(context.job.workspaceId, sessionId, groupJid, participant, "demote");
          await updateGroupParticipantRole(context.job.workspaceId, sessionId, groupJid, participant, "remove");
          completed += 1;
        } catch (error) {
          failed += 1;
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: "demote-remove partial failure",
            lastResult: error instanceof Error ? error.message : String(error),
          });
        }
        await context.report({
          completed: completed + failed,
          success: completed,
          failed,
          currentAction: "demote-remove progress",
          lastResult: `${completed + failed}/${participants.length} administrator target(s) processed sequentially.`,
        });
      }
    } else if (participantAction === "block") {
      for (const participant of participants) {
        await context.waitIfPaused();
        if (context.isCancellationRequested()) break;
        try {
          await updateParticipantBlockStatus(
            context.job.workspaceId,
            sessionId,
            participant,
            true,
          );
          completed += 1;
        } catch (error) {
          failed += 1;
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: `${operation} partial failure`,
            lastResult: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      const action = participantAction as "promote" | "demote" | "remove";
      let remaining = [...participants];
      let batchAttempts = 0;
      while (remaining.length > 0 && !context.isCancellationRequested()) {
        await context.waitIfPaused();
        try {
          const result = await updateGroupParticipantBatch(
            context.job.workspaceId,
            sessionId,
            groupJid,
            remaining,
            action,
            false,
          );
          const returnedSuccessful = new Set(result.succeededJids);
          const returnedFailed = new Set(
            result.failures
              .map((failure) => failure.jid)
              .filter((jid): jid is string => Boolean(jid)),
          );
          const nextRemaining = remaining.filter(
            (jid) => !returnedSuccessful.has(jid) && !returnedFailed.has(jid),
          );
          completed += result.succeeded;
          failed += result.failures.filter((failure) => failure.status !== "not-returned").length;
          remaining = nextRemaining;
          batchAttempts += 1;
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: `${action} batch progress`,
            lastResult: `${completed}/${participants.length} members confirmed; ${remaining.length} remaining.`,
          });
          if (!remaining.length) break;
          if (batchAttempts >= 2) {
            const tail = remaining;
            remaining = [];
            for (let offset = 0; offset < tail.length; offset += 100) {
              if (context.isCancellationRequested()) {
                remaining = tail.slice(offset);
                break;
              }
              const chunk = tail.slice(offset, offset + 100);
              try {
                const chunkResult = await updateGroupParticipantBatch(
                  context.job.workspaceId,
                  sessionId,
                  groupJid,
                  chunk,
                  action,
                  false,
                );
                completed += chunkResult.succeeded;
                failed += chunkResult.failed;
              } catch {
                failed += chunk.length;
              }
              await context.report({
                completed: completed + failed,
                success: completed,
                failed,
                currentAction: `${action} batch completion`,
                lastResult: `${completed}/${participants.length} members confirmed; processed batch chunk ${Math.min(offset + 100, tail.length)}/${tail.length}.`,
              });
            }
          }
        } catch (error) {
          batchAttempts += 1;
          if (batchAttempts >= 2) {
            failed += remaining.length;
            remaining = [];
          }
          await context.report({
            completed: completed + failed,
            success: completed,
            failed,
            currentAction: `${action} batch retry`,
            lastResult: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return {
      success: completed,
      failed,
      skipped: Math.max(0, participants.length - completed - failed),
    };
  });

  orchestrator.register("join-manager", async (context) => {
    const sessionId = context.job.sessionId;
    if (!sessionId)
      throw new Error("Join Manager requires a selected WhatsApp session.");
    const boundSession = getSession(context.job.workspaceId, sessionId);
    const ready = await waitForWhatsAppSessionReady(
      context.job.workspaceId,
      sessionId,
      90_000,
    );
    if (!ready)
      throw new Error("WhatsApp session is not ready for Join Manager work yet.");
    const socket = getWhatsAppSocket(
      context.job.workspaceId,
      sessionId,
    ) as unknown as {
      groupFetchAllParticipating?: () => Promise<Record<string, unknown>>;
      groupGetInviteInfo?: (code: string) => Promise<{
        id?: string;
        subject?: string;
        size?: number;
        participantsCount?: number;
      }>;
      groupAcceptInvite?: (code: string) => Promise<string | undefined>;
      groupRequestJoin?: (code: string) => Promise<string | undefined>;
    };
    const payload = context.job.payload as {
      targetCount?: number;
      delayMs?: number;
      batchCycles?: number;
      minDelayMs?: number;
      maxDelayMs?: number;
      retryLimit?: number;
      retryBaseMs?: number;
      sessionCooldownMs?: number;
      restrictionThreshold?: number;
      requestMode?: "auto" | "immediate" | "request";
      maxConcurrency?: number;
      sourceBucket?: "active";
      selectedLinks?: string[];
      fullInventory?: boolean;
      fixedDelay?: boolean;
      joinAttemptTimeoutMs?: number;
    };
    let membershipSnapshot: Record<string, unknown> | undefined;
    try {
      membershipSnapshot = await socket.groupFetchAllParticipating?.();
    } catch {
      // Invite metadata and join can still proceed; a later successful join
      // seeds the snapshot without turning a membership-read failure into an
      // account restriction.
    }
    const selectedLinks = new Set(
      (payload.selectedLinks ?? []).map((link) => link.trim()).filter(Boolean),
    );
    const sourceRecords: LinkRecord[] = [];
    if (selectedLinks.size) {
      for (const link of selectedLinks) {
        const record = await buckets.get(GLOBAL_VALIDATOR_SCOPE, link);
        if (record?.bucket === "active") sourceRecords.push(record);
      }
    } else {
      let cursor = 0;
      do {
        const page = await buckets.list(
          GLOBAL_VALIDATOR_SCOPE,
          "active",
          cursor,
          100,
        );
        for (const record of page.records) {
          sourceRecords.push(record);
        }
        cursor = page.nextCursor;
      } while (cursor !== 0);
    }
    const selectedRecords = selectJoinInventoryRecords(sourceRecords, {
      fullInventory: payload.fullInventory === true,
      ...(payload.targetCount !== undefined
        ? { targetCount: payload.targetCount }
        : {}),
    });
    sourceRecords.length = 0;
    sourceRecords.push(...selectedRecords);
    const batchCycles = Math.max(
      1,
      Math.min(20, Number(payload.batchCycles ?? 1)),
    );
    const workItems = Array.from({ length: batchCycles }).flatMap((_, cycle) =>
      remixJoinRecords(sourceRecords, context.job.jobId, cycle).map((record) => ({ record, cycle })),
    );
    await context.report({
      total: workItems.length,
      currentAction: `${payload.fullInventory === true ? "remixed full Active inventory" : "shuffled selected Active inventory"} · ${sourceRecords.length} link(s)`,
    });
    let rateLimitHits = 0;
    let accountRestrictionHits = 0;
    let requested = 0;
    let alreadyMember = 0;
    let deadLinks = 0;
    let joined = 0;
    let lastAttemptAtMono: number | undefined;
    let nextIntervalMs = 0;
    const immediateMode = payload.requestMode === "immediate";
    const fallbackDelay = immediateMode
      ? 0
      : Math.max(1000, Math.min(60000, Number(payload.delayMs ?? 8000)));
    const fixedDelay = payload.fixedDelay === true;
    const minDelayMs = immediateMode
      ? 0
      : fixedDelay
        ? fallbackDelay
        : Math.max(
            1000,
            Math.min(60000, Number(payload.minDelayMs ?? fallbackDelay)),
          );
    const maxDelayMs = immediateMode || fixedDelay
      ? minDelayMs
      : Math.max(
          minDelayMs,
          Math.min(60000, Number(payload.maxDelayMs ?? minDelayMs)),
        );
    const retryLimit = Math.max(
      0,
      Math.min(5, Number(payload.retryLimit ?? 2)),
    );
    const retryBaseMs = Math.max(
      1000,
      Math.min(600000, Number(payload.retryBaseMs ?? 5000)),
    );
    const sessionCooldownMs = Math.max(
      0,
      Math.min(3600000, Number(payload.sessionCooldownMs ?? 30000)),
    );
    const joinAttemptTimeoutMs = Math.max(
      15000,
      Math.min(120000, Number(payload.joinAttemptTimeoutMs ?? 30000)),
    );
    const restrictionThreshold = Math.max(
      1,
      Math.min(5, Math.floor(Number(payload.restrictionThreshold ?? 5))),
    );
    return runBoundedBatch({
      items: workItems,
      // Fixed-delay mode is intentionally single-flight: the next attempt is
      // scheduled from the previous attempt's completion, not from a wall
      // clock read taken before an overlapping worker starts.
      concurrency: fixedDelay
        ? 1
        : Math.max(1, Math.min(3, Number(payload.maxConcurrency ?? 1))),
      context,
      // Only a confirmed account restriction stops this job. A rate-limited
      // invite lookup remains a link-level transient and the next remixed link
      // is still allowed to proceed.
      shouldStop: () => joinRestrictionStopReached(accountRestrictionHits, restrictionThreshold),
      processItem: async (workItem, signal) => {
        const { record, cycle } = workItem;
        const prior = await joinResults.get(
          context.job.jobId,
          record.canonicalUrl,
          cycle,
        );
        if (prior) {
          await context.report({
            currentLink: record.canonicalUrl,
            currentAction: "resumed",
            lastResult: `Skipped completed cycle ${cycle + 1}: ${prior.outcome}`,
          });
          return { status: "skipped" as const };
        }
        const saveResult = async (
          outcome: JoinResultOutcome,
          details: { jid?: string; title?: string; error?: string } = {},
        ) =>
          joinResults.set({
            jobId: context.job.jobId,
            workspaceId: context.job.workspaceId,
            sessionId,
            canonicalUrl: record.canonicalUrl,
            cycle,
            outcome,
            retryCount: retryAttempt,
            timestamp: Date.now(),
            ...details,
          });
        if (signal.aborted) return { status: "skipped" as const };
        const currentRecord = await buckets.get(
          GLOBAL_VALIDATOR_SCOPE,
          record.canonicalUrl,
        );
        if (!currentRecord || currentRecord.bucket !== "active")
          return { status: "skipped" as const };
        const nowMono = performance.now();
        if (lastAttemptAtMono !== undefined && nextIntervalMs > 0) {
          const elapsedSinceCompletion = Math.max(0, nowMono - lastAttemptAtMono);
          const wait = Math.max(0, nextIntervalMs - elapsedSinceCompletion);
          if (wait) {
            const nextActionAt = Date.now() + wait;
            await waitWithHeartbeat(context, wait, {
              nextActionAt,
              currentAction: `waiting ${Math.ceil(wait / 1000)}s before next attempt`,
            });
            if (signal.aborted || context.isCancellationRequested())
              return { status: "skipped" as const };
          }
        }
        await context.report({
          nextActionAt: Date.now(),
          currentLink: record.canonicalUrl,
          currentAction: `checking invite via ${boundSession.sessionName} · socket ${sessionId.slice(0, 8)} · generation ${boundSession.socketGeneration ?? "—"}`,
        });
        const runJoinAttempt = (): Promise<JoinAttemptResult> =>
          withTimeout(
            joinWhatsAppInvite(socket, record.canonicalUrl, {
              mode: payload.requestMode ?? "auto",
              ...(membershipSnapshot ? { participatingGroups: membershipSnapshot } : {}),
            }),
            joinAttemptTimeoutMs,
            `Join attempt timed out after ${Math.ceil(joinAttemptTimeoutMs / 1000)}s.`,
          ).catch((error: unknown) => ({
            success: false,
            stage: "invite-info" as const,
            error: error instanceof Error ? error.message : String(error),
          }));
        let retryAttempt = 0;
        let result = await runJoinAttempt();
        while (
          !result.success &&
          !result.alreadyMember &&
          !result.requestRequired &&
          retryAttempt < retryLimit
        ) {
          const retryClass = classifyJoinAttempt(result);
          if (
            !retryClass.retryable
          )
            break;
          retryAttempt += 1;
          const retryWaitMs = retryBaseMs * retryAttempt;
          await waitWithHeartbeat(context, retryWaitMs, {
            nextActionAt: Date.now() + retryWaitMs,
            currentAction: `retrying in ${retryWaitMs}ms`,
          });
          if (signal.aborted || context.isCancellationRequested())
            return { status: "skipped" as const };
          result = await runJoinAttempt();
        }
        const joinClassification: NonNullable<
          LinkRecord["metadata"]
        >["joinClassification"] = result.success
          ? "joined"
          : result.alreadyMember
            ? "already-member"
            : result.requestRequired
              ? "request-required"
              : "failed";
        const metadata: LinkRecord["metadata"] = {
          ...record.metadata,
          ...(result.jid ? { groupJid: result.jid } : {}),
          ...(result.title ? { groupTitle: result.title } : {}),
          joinClassification,
          joinRetryable: false,
        };
        if (result.success) {
          if (result.jid) membershipSnapshot = { ...(membershipSnapshot ?? {}), [result.jid]: {} };
          joined += 1;
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            "active",
            {
              lastCheckedAt: Date.now(),
              metadata,
            },
          );
          await saveResult("JOINED", {
            ...(result.jid ? { jid: result.jid } : {}),
            ...(result.title ? { title: result.title } : {}),
          });
          await context.report({
            joined,
            lastResult: `Joined ${result.title ?? result.jid ?? record.canonicalUrl}`,
            currentAction: "joined",
            ...(fixedDelay ? { nextActionAt: Date.now() + minDelayMs } : {}),
          });
          lastAttemptAtMono = performance.now();
          nextIntervalMs = minDelayMs;
          return { status: "success" as const };
        }
        if (result.alreadyMember) {
          if (result.jid) membershipSnapshot = { ...(membershipSnapshot ?? {}), [result.jid]: {} };
          alreadyMember += 1;
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            "active",
            {
              lastCheckedAt: Date.now(),
              metadata,
            },
          );
          await saveResult("ALREADY_JOINED", {
            ...(result.jid ? { jid: result.jid } : {}),
            ...(result.title ? { title: result.title } : {}),
          });
          await context.report({
            alreadyMember,
            lastResult: `Already joined ${result.title ?? result.jid ?? record.canonicalUrl}`,
            currentAction: "already member",
            ...(fixedDelay ? { nextActionAt: Date.now() + minDelayMs } : {}),
          });
          lastAttemptAtMono = performance.now();
          nextIntervalMs = minDelayMs;
          return { status: "skipped" as const };
        }
        const classified = classifyJoinAttempt(result);
        if (result.requestRequired) {
          requested += 1;
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            "active",
            {
              lastCheckedAt: Date.now(),
              validationError: "Join request sent or approval required.",
              metadata: {
                ...metadata,
                joinClassification: "request-required",
                joinRetryable: true,
              },
            },
          );
          await saveResult("REQUESTED", {
            ...(result.jid ? { jid: result.jid } : {}),
            ...(result.title ? { title: result.title } : {}),
            error: "Join request sent or approval required.",
          });
          await context.report({
            requested,
            lastResult: `Request pending for ${result.title ?? result.jid ?? record.canonicalUrl}`,
            currentAction: "request pending",
            ...(fixedDelay ? { nextActionAt: Date.now() + minDelayMs } : {}),
          });
          lastAttemptAtMono = performance.now();
          nextIntervalMs = minDelayMs;
          return { status: "skipped" as const };
        }
        if (classified.classification === "rate-limit") {
          rateLimitHits += 1;
          if (result.accountRestricted) accountRestrictionHits += 1;
          await context.report({
            retrying: (context.job.progress.retrying ?? 0) + 1,
            rateLimitHits,
            ...(accountRestrictionHits > 0 ? { rateLimitStopAt: restrictionThreshold } : {}),
            lastResult: result.accountRestricted
              ? `WhatsApp account restriction reported after ${rateLimitHits} attempt(s)`
              : `Join endpoint temporarily throttled after ${rateLimitHits} attempt(s)`,
            currentAction: result.accountRestricted
              ? "cooling down after WhatsApp account restriction"
              : accountRestrictionHits >= restrictionThreshold
                ? "restriction threshold reached; stopping this Join Manager job"
                : `account restriction counted ${accountRestrictionHits}/${restrictionThreshold}; continuing`,
          });
          if (result.accountRestricted && sessionCooldownMs)
            await waitWithHeartbeat(context, sessionCooldownMs, {
              nextActionAt: Date.now() + sessionCooldownMs,
              currentAction: `cooling down for ${Math.ceil(sessionCooldownMs / 1000)}s after account restriction`,
            });
        }
        if (classified.classification === "invalid-invite") {
          deadLinks += 1;
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            "dead",
            {
              validationError:
                "Join Manager confirmed the Active invite is invalid or unavailable.",
              lastCheckedAt: Date.now(),
              metadata: {
                ...metadata,
                joinClassification: "dead-link",
                joinRetryable: false,
                needsValidation: false,
                validationState: "dead",
              },
            },
          );
          await saveResult("DEAD", {
            ...(result.jid ? { jid: result.jid } : {}),
            ...(result.title ? { title: result.title } : {}),
            error: classified.message,
          });
          await context.report({
            deadLinks,
            lastResult: `Confirmed inaccessible link moved to Dead: ${record.canonicalUrl}`,
            currentAction: "marked dead",
          });
        } else {
          // Only an invite-specific invalid/expired result is terminal for the
          // link. Full, locked, or temporarily unavailable groups stay Active
          // so a later remix or another session can try again.
          const deadLink = ["invalid-invite", "expired"].includes(
            classified.classification,
          );
          const retryable = classified.retryable || classified.classification === "rate-limit";
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            deadLink ? "dead" : "active",
            {
              validationError: classified.message.slice(0, 240),
              metadata: {
                ...metadata,
                joinClassification: classified.classification,
                joinRetryable: retryable,
                needsValidation: false,
                validationState: deadLink ? "dead" : "active",
              },
              lastCheckedAt: Date.now(),
            },
          );
          await saveResult(
            joinOutcomeFromClassification(classified.classification),
            {
              ...(result.jid ? { jid: result.jid } : {}),
              ...(result.title ? { title: result.title } : {}),
              error: classified.message,
            },
          );
        }
        lastAttemptAtMono = performance.now();
        nextIntervalMs = fixedDelay
          ? minDelayMs
          : minDelayMs === maxDelayMs
            ? minDelayMs
            : minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
        if (fixedDelay)
          await context.report({ nextActionAt: Date.now() + nextIntervalMs });
        // Active inventory entries are not invalidated by a transient join
        // outcome. Keep them eligible for a later remix and do not present a
        // network/timeout/throttle/full-group/permission response as a
        // permanent failure of the link itself.
        return joinFailureIsTemporary(classified.classification)
          ? { status: "skipped" as const }
          : { status: "failed" as const };
      },
    });
  });

  for (const kind of ["gstatus", "allstatus", "allchat", "tag"] as const) {
    orchestrator.register(kind, async (context) => {
      const sessionId = context.job.sessionId;
      if (!sessionId) throw new Error(`${kind} requires a WhatsApp session.`);
      const payload = context.job.payload as {
        groups?: string[];
        text?: string;
        count?: number;
        delayMs?: number;
        media?: JobMediaReference;
        workerLocal?: boolean;
        styled?: boolean;
      };
      if (kind === "allstatus" || kind === "allchat") {
        const readinessHeartbeat = setInterval(() => {
          void context
            .report({
              currentAction: "waiting for WhatsApp session",
              lastResult:
                "The session is reconnecting; this broadcast will resume when transport is ACTIVE.",
            })
            .catch(() => undefined);
        }, 5_000);
        readinessHeartbeat.unref?.();
        try {
          const ready = await waitForWhatsAppSessionReady(
            context.job.workspaceId,
            sessionId,
            90_000,
          );
          if (!ready)
            throw new Error(
              "WhatsApp session is not ready yet; broadcast retry is scheduled.",
            );
        } finally {
          clearInterval(readinessHeartbeat);
        }
      }
      const text = typeof payload.text === "string" ? payload.text : "";
      const repeat =
        kind === "gstatus" || kind === "allstatus" || kind === "allchat"
          ? Math.max(1, Math.min(20, Number(payload.count ?? 1)))
          : 1;
      const delayMs = Math.max(
        1500,
        Math.min(120000, Number(payload.delayMs ?? 10000)),
      );
      if (!text.trim() && !payload.media)
        throw new Error(`${kind} requires text or media payload.`);
      if (
        (kind === "allstatus" || kind === "allchat") &&
        payload.workerLocal === true
      ) {
        const startCommand = await queueWorkloadCommand(
          context.job.workspaceId,
          sessionId,
          "broadcast.start",
          {
            jobId: context.job.jobId,
            kind,
            text,
            delayMs,
            repeat,
            ...(payload.styled === true ? { styled: true } : {}),
            ...(payload.media ? { mediaRef: payload.media } : {}),
          },
          10 * 60_000,
        );
        const accepted = await waitForWorkloadCommand(
          startCommand.commandId,
          120_000,
        );
        const result = accepted.result as { totalGroups?: unknown } | undefined;
        const totalGroups = Math.max(0, Number(result?.totalGroups ?? 0));
        await context.report({
          ...(totalGroups > 0 ? { total: totalGroups * repeat } : {}),
          currentAction:
            totalGroups > 0
              ? `${kind} worker-local delivery started`
              : `${kind} worker-local dispatch started`,
          nextActionAt: Date.now(),
          lastResult:
            totalGroups > 0
              ? `Panel accepted ${totalGroups} WhatsApp group target(s); delivery remains on the owning worker.`
              : `Panel accepted the broadcast; the delivery runner is active and will publish its target total when ready.`,
        });
        if (
          totalGroups > 0 &&
          (context.job.payload as { sourceTransport?: unknown })
            .sourceTransport !== "whatsapp"
        )
          await notifyBroadcastReady(
            context,
            kind,
            totalGroups,
            repeat,
            delayMs,
          );
        let cancelSent = false;
        while (true) {
          if (context.isCancellationRequested() && !cancelSent) {
            cancelSent = true;
            await requestBroadcastCancellation(
              context.job.workspaceId,
              context.job.jobId,
            ).catch(() => undefined);
            const cancelCommand = await queueWorkloadCommand(
              context.job.workspaceId,
              sessionId,
              "broadcast.cancel",
              { jobId: context.job.jobId },
              60_000,
            ).catch(() => undefined);
            if (cancelCommand)
              await waitForWorkloadCommand(
                cancelCommand.commandId,
                20_000,
              ).catch(() => undefined);
          }
          const progress = await getBroadcastProgress(
            context.job.workspaceId,
            context.job.jobId,
          );
          if (progress) {
            await context.report({
              total: progress.totalGroups * repeat,
              completed: progress.completed,
              success: progress.completed,
              failed: progress.failed,
              skipped: progress.skipped,
              ...(progress.currentGroup
                ? { currentGroup: progress.currentGroup }
                : {}),
              ...(progress.nextActionAt
                ? { nextActionAt: progress.nextActionAt }
                : {}),
              currentAction:
                progress.currentAction ??
                (progress.state === "WAITING_FOR_SESSION"
                  ? "waiting for WhatsApp reconnect"
                  : progress.state.toLowerCase()),
              lastResult:
                progress.lastResult ??
                progress.error ??
                `Worker-local ${kind} progress: ${progress.completed}/${progress.totalGroups * repeat}.`,
            });
            if (
              ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(
                progress.state,
              )
            )
              return {
                success: progress.completed,
                failed: progress.failed,
                skipped: progress.skipped,
              };
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      let baseGroups: string[];
      if (kind === "gstatus") {
        baseGroups = [payload.groups?.[0]].filter((jid): jid is string =>
          Boolean(jid),
        );
      } else if (payload.groups?.length) {
        baseGroups = payload.groups;
      } else {
        await context.report({
          currentAction: "starting delivery",
          lastResult:
            "The broadcast worker is loading the active WhatsApp group targets.",
        });
        const inventoryHeartbeat = setInterval(() => {
          void context
            .report({
              currentAction: "starting delivery",
              lastResult:
                "The broadcast worker is still loading the active WhatsApp group targets.",
            })
            .catch(() => undefined);
        }, 5_000);
        inventoryHeartbeat.unref?.();
        try {
          baseGroups = (
            await listGroups(context.job.workspaceId, sessionId)
          ).map((group) => group.jid);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await context.report({
            currentAction: "group inventory failed",
            lastResult: message,
          });
          throw error;
        } finally {
          clearInterval(inventoryHeartbeat);
        }
      }
      if (!baseGroups.length) {
        await context.report({
          total: 0,
          currentAction: "waiting for group inventory",
          lastResult: "No WhatsApp groups were returned for this session.",
        });
        throw new Error("No WhatsApp groups were returned for this session.");
      }
      const uniqueGroups = [...new Set(baseGroups)];
      const ignoredLinks =
        getSession(context.job.workspaceId, sessionId).ignoredGroupLinks ?? [];
      const ignoredJids = new Set<string>();
      await Promise.all(
        ignoredLinks.map(async (link) => {
          const code = link.split("/").pop()?.split("?")[0];
          if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) return;
          const resolved = await validateInviteLink(
            context.job.workspaceId,
            sessionId,
            code,
          ).catch(() => undefined);
          if (resolved?.jid) ignoredJids.add(resolved.jid);
        }),
      );
      const deliverableGroups = uniqueGroups.filter(
        (jid) => !ignoredJids.has(jid),
      );
      const resolvedPayload = {
        ...payload,
        groups: deliverableGroups,
      };
      await context.report(
        {
          total: deliverableGroups.length,
          currentAction: `${kind} inventory resolved`,
          nextActionAt: Date.now(),
          lastResult: `Resolved ${uniqueGroups.length} WhatsApp group(s); ${ignoredJids.size} ignored; ${deliverableGroups.length} delivery target(s) remain.`,
        },
        { payload: resolvedPayload },
      );
      const deliveries = deliverableGroups.flatMap((jid) =>
        Array.from({ length: repeat }, (_, repeatIndex) => ({
          jid,
          repeatIndex: repeatIndex + 1,
        })),
      );
      let media: GroupMediaPayload | undefined;
      if (payload.media) {
        media = {
          kind: payload.media.kind,
          bytes: await readJobMedia(payload.media),
          mimeType: payload.media.mimeType,
          ...(payload.media.originalFileName
            ? { fileName: payload.media.originalFileName }
            : {}),
          ...(payload.media.ptt !== undefined
            ? { ptt: payload.media.ptt }
            : {}),
        };
      }
      const deliverWithRetries = async (
        targetJid: string,
        send: () => Promise<unknown>,
      ): Promise<"sent" | "inaccessible"> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await withTimeout(
              send(),
              90_000,
              `${kind} delivery timed out for ${targetJid}`,
            );
            return "sent";
          } catch (error) {
            lastError = error;
            const message =
              error instanceof Error ? error.message : String(error);
            if (isConfirmedInaccessibleGroupError(message))
              return "inaccessible";
            if (attempt < 3) {
              await context.report({
                currentGroup: targetJid,
                currentAction: `retrying ${kind} delivery (${attempt + 1}/3)`,
                lastResult: `${kind} transient failure: ${message}`.slice(
                  0,
                  400,
                ),
              });
              await waitWithHeartbeat(context, Math.min(5000, 1500 * attempt), {
                currentGroup: targetJid,
                currentAction: `retrying ${kind} delivery (${attempt + 1}/3)`,
              });
            }
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError));
      };
      let lastPostAt = 0;
      let completedDeliveries = 0;
      let failedDeliveries = 0;
      const autoPromoteRunId =
        typeof (context.job.payload as { autoPromoteRunId?: unknown })
          .autoPromoteRunId === "string"
          ? (context.job.payload as { autoPromoteRunId: string })
              .autoPromoteRunId
          : undefined;
      return await runBoundedBatch({
        items: deliveries,
        concurrency: 1,
        context,
        processItem: async ({ jid, repeatIndex }, signal) => {
          if (signal.aborted) return { status: "skipped" as const };
          const alreadyDelivered = !(await markBroadcastDelivered(
            context.job.jobId,
            kind,
            jid,
            repeatIndex,
          ));
          if (alreadyDelivered) {
            await context.report({
              currentGroup: jid,
              currentAction: `already posted${repeat > 1 ? ` · repeat ${repeatIndex}/${repeat}` : ""}`,
              lastResult: `${kind} delivery was already confirmed for ${jid}.`,
            });
            return { status: "success" as const };
          }
          if (lastPostAt) {
            const wait = Math.max(0, delayMs - (Date.now() - lastPostAt));
            if (wait) {
              await context.report({
                currentGroup: jid,
                currentAction: `waiting for next ${kind} post`,
                nextActionAt: Date.now() + wait,
                lastResult: `Next group post in ${Math.ceil(wait / 1000)}s.`,
              });
              await waitWithHeartbeat(context, wait, {
                currentGroup: jid,
                currentAction: `waiting for next ${kind} post`,
                nextActionAt: Date.now() + wait,
              });
            }
          }
          let sessionLock: SessionLock | undefined;
          const lockDeadline = Date.now() + 15_000;
          while (!sessionLock && Date.now() < lockDeadline) {
            if (signal.aborted) return { status: "skipped" as const };
            sessionLock = await acquireSessionOperationLock(
              context.job.workspaceId,
              sessionId,
            );
            if (!sessionLock) {
              await context.report({
                currentGroup: jid,
                currentAction: "waiting for session operation lock",
                lastResult:
                  "Another operation is using this WhatsApp session; retrying this group without blocking other jobs.",
              });
              await waitWithHeartbeat(context, 500, {
                currentGroup: jid,
                currentAction: "waiting for session operation lock",
              });
            }
          }
          if (!sessionLock)
            throw new Error(
              "Broadcast session operation busy; retry scheduled.",
            );
          lastPostAt = Date.now();
          try {
            const deliveryOutcome = await deliverWithRetries(jid, () =>
              kind === "allstatus" && payload.styled === true
                ? sendGroupColorStatus(context.job.workspaceId, sessionId, jid,
                    {
                      text,
                      ...(media ? { media } : {}),
                    },
                  )
                : kind === "gstatus" || kind === "allstatus"
                  ? sendGroupStatus(context.job.workspaceId, sessionId, jid, {
                      text,
                      ...(media ? { media } : {}),
                    })
                  : sendGroupMentions(
                      context.job.workspaceId,
                      sessionId,
                      jid,
                      text,
                      undefined,
                      media,
                    ),
            );
            if (deliveryOutcome === "inaccessible") {
              await context.report({
                currentGroup: jid,
                currentAction: "skipped inaccessible group",
                lastResult: `${kind} skipped confirmed inaccessible group ${jid}`,
              });
              return { status: "skipped" as const };
            }
            await recordBroadcastDelivered(
              context.job.jobId,
              kind,
              jid,
              repeatIndex,
            );
            completedDeliveries += 1;
            if (autoPromoteRunId)
              void recordAutoPromoteProgress({
                runId: autoPromoteRunId,
                currentGroup: jid,
                currentRepetition: repeatIndex,
                completedGroups: Math.floor(completedDeliveries / repeat),
                failedGroups: failedDeliveries,
                successCount: completedDeliveries,
                totalGroups: uniqueGroups.length,
                totalRepetitions: repeat,
              }).catch(() => undefined);
            const remainingDeliveries = deliveries.length - completedDeliveries;
            await context.report({
              currentGroup: jid,
              currentAction: remainingDeliveries ? "posted" : "completed",
              nextActionAt: remainingDeliveries
                ? Date.now() + delayMs
                : Date.now(),
              lastResult: `${kind} posted to ${jid}${repeat > 1 ? ` · repeat ${repeatIndex}/${repeat}` : ""}`,
            });
            return { status: "success" as const };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            failedDeliveries += 1;
            if (autoPromoteRunId)
              void recordAutoPromoteProgress({
                runId: autoPromoteRunId,
                currentGroup: jid,
                currentRepetition: repeatIndex,
                completedGroups: Math.floor(completedDeliveries / repeat),
                failedGroups: failedDeliveries,
                successCount: completedDeliveries,
                totalGroups: uniqueGroups.length,
                totalRepetitions: repeat,
                error: error instanceof Error ? error.message : String(error),
              }).catch(() => undefined);
            await context.report({
              currentGroup: jid,
              currentAction: "soft failure",
              lastResult:
                `${kind} delivery failed for ${jid}: ${message}`.slice(0, 500),
            });
            return { status: "failed" as const };
          } finally {
            await sessionLock.release();
          }
        },
      });
    });
  }

  orchestrator.register("cleanup", async (context) => {
    await context.report({
      completed: 1,
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
      rate: 1,
    });
    return { success: 1, failed: 0, skipped: 0 };
  });

  const inceptor = startInceptor(orchestrator);
  orchestrator.addCloseHook(() => inceptor.stop());
  void orchestrator.recoverStaleJobsNow().catch((error) => {
    console.error(
      "[pappy-omega-mini] immediate stale-job recovery failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
  void buckets
    .reconcileGlobalIndexes()
    .then((result) =>
      console.info(
        `[pappy-omega-mini] Validator index reconciled removed=${result.removed} restored=${result.restored}`,
      ),
    )
    .catch((error) =>
      console.error(
        "[pappy-omega-mini] Validator index reconciliation failed:",
        error,
      ),
    );
  void sweepPendingMainValidation(orchestrator, buckets);
  void runValidatorGuard(orchestrator, buckets, redis);
  validatorSweepTimer = setInterval(
    () => void sweepPendingMainValidation(orchestrator, buckets),
    5_000,
  );
  validatorGuardTimer = setInterval(
    () => void runValidatorGuard(orchestrator, buckets, redis),
    VALIDATOR_GUARD_INTERVAL_MS,
  );
  validatorSweepTimer.unref?.();
  validatorGuardTimer.unref?.();
  return orchestrator;
}

async function runValidatorGuard(
  orchestrator: JobOrchestrator,
  buckets: LinkBucketStore,
  redis: Redis,
): Promise<void> {
  if (validatorGuardBusy) return;
  validatorGuardBusy = true;
  try {
    const now = Date.now();
    if (now - lastValidatorIndexReconcileAt >= 60_000) {
      lastValidatorIndexReconcileAt = now;
      await buckets
        .reconcileGlobalIndexes()
        .catch((error) =>
          console.error(
            "[pappy-omega-mini] periodic Validator index reconciliation failed:",
            error,
          ),
        );
    }
    const activeValidationJobs = (await orchestrator.listRecent(1000)).filter(
      (job) =>
        job.kind === "link-validation" &&
        ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
    );
    const leasedUrls = new Set(
      activeValidationJobs.flatMap((job) => {
        const payload = job.payload as { urls?: unknown };
        return Array.isArray(payload.urls)
          ? payload.urls.filter((url): url is string => typeof url === "string")
          : [];
      }),
    );
    let cursor = 0;
    do {
      const page = await buckets.list(
        GLOBAL_VALIDATOR_SCOPE,
        "validating",
        cursor,
        500,
      );
      for (const record of page.records) {
        const checkedAt = record.lastCheckedAt ?? record.firstSeenAt;
        if (
          leasedUrls.has(record.canonicalUrl) ||
          now - checkedAt <= VALIDATING_STALE_MS
        )
          continue;
          await buckets.move(
            GLOBAL_VALIDATOR_SCOPE,
            record.canonicalUrl,
            "error",
            {
              validationError:
                "Validator Guard expired a stale validation claim; explicit requeue is required.",
              metadata: {
                ...(record.metadata ?? {}),
                needsValidation: false,
                validationState: "retryable-error",
              },
            },
          );
      }
      cursor = page.nextCursor;
    } while (cursor !== 0);

    const sessions = listAllSessions();
    const jobs = (await orchestrator.listRecent(1000)).filter(
      (job) =>
        job.kind === "link-validation" &&
        Boolean(job.sessionId) &&
        ["COMPLETED", "PARTIAL", "FAILED"].includes(job.state) &&
        Boolean(job.completedAt) &&
        (job.completedAt ?? now) >= validatorGuardStartedAt - 60_000 &&
        now - (job.completedAt ?? now) <= 60 * 60_000,
    );
    for (const job of jobs) {
      const marker = `pappy-omega-mini:validator-guard:${job.jobId}`;
      if ((await redis.set(marker, "1", "EX", 6 * 60 * 60, "NX")) !== "OK")
        continue;
      const session = sessions.find(
        (candidate) =>
          candidate.workspaceId === job.workspaceId &&
          candidate.sessionId === job.sessionId,
      );
      if (!session) continue;
      const progress = job.progress;
      const resultText =
        `${job.error ?? ""} ${progress.lastResult ?? ""} ${progress.currentAction ?? ""}`.toLowerCase();
      const rateLimited = isInviteValidationRateLimited(resultText);
      // “No healthy validation session” is an admission/scheduler result, not
      // evidence that the bound socket failed. Counting it here creates a
      // self-lock: the session is retired, then every queued batch reports no
      // healthy session and extends the retirement indefinitely.
      const transportFailure =
        /timeout|network|closed|not connected|decrypt|bad mac|session|heartbeat/.test(
          resultText,
        ) && !/no healthy(?: whatsapp)? validation session/.test(resultText);
      const successful =
        job.state === "COMPLETED" && (progress.success ?? 0) > 0;
      if (successful) {
        updateSession(session.workspaceId, session.sessionId, {
          validatorFailureCount: 0,
          validatorRateLimitCount: 0,
          validatorLastSuccessAt: now,
          validatorRetiredUntil: now - 1,
          validatorRetireReason: "recovered",
        });
        continue;
      }
      if (!rateLimited && !transportFailure && job.state !== "FAILED") continue;
      const failureCount = (session.validatorFailureCount ?? 0) + 1;
      const rateLimitCount =
        (session.validatorRateLimitCount ?? 0) + (rateLimited ? 1 : 0);
      const consecutiveRateLimitCount = rateLimited
        ? (session.validatorConsecutiveRateLimitCount ?? 0) + 1
        : 0;
      const retire = !rateLimited && failureCount >= 3;
      updateSession(session.workspaceId, session.sessionId, {
        validatorFailureCount: failureCount,
        validatorRateLimitCount: rateLimitCount,
        validatorConsecutiveRateLimitCount: consecutiveRateLimitCount,
        ...(retire
          ? {
              validatorRetiredUntil: now + VALIDATOR_RETIRE_MS,
              validatorRetireReason: "repeated validation transport failure",
            }
          : {
              validatorRetiredUntil: now - 1,
              validatorRetireReason: rateLimited
                ? "per-link rate-limit; session retained for validation"
                : "transient validation failure; cooldown not applied",
            }),
      });
    }
  } catch (error) {
    console.error(
      "[pappy-omega-mini] Validator Guard failed:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    validatorGuardBusy = false;
  }
}

let validatorSweepBusy = false;
let lastValidatorIndexReconcileAt = 0;

async function sweepPendingMainValidation(
  orchestrator: JobOrchestrator,
  buckets: LinkBucketStore,
): Promise<void> {
  if (validatorSweepBusy) return;
  validatorSweepBusy = true;
  try {
    await refreshSessionRegistry().catch((error) =>
      console.error(
        "[pappy-omega-mini] Validator session registry refresh failed:",
        error instanceof Error ? error.message : String(error),
      ),
    );
    await buckets.migrateLegacyWorkspacesToGlobal().catch(() => 0);
    const allSessions = listAllSessions();
    const healthySessionKeys = new Set<string>();
    for (const workspaceId of new Set(
      allSessions.map((session) => session.workspaceId),
    )) {
      for (const session of listHealthyWhatsAppSessions(workspaceId))
        healthySessionKeys.add(`${session.workspaceId}:${session.sessionId}`);
    }
    const activeSessions = allSessions.filter((session) =>
      healthySessionKeys.has(`${session.workspaceId}:${session.sessionId}`),
    );
    if (!activeSessions.length) return;
    const activeValidationJobs = (await orchestrator.listRecent(1000)).filter(
      (job) =>
        job.kind === "link-validation" &&
        ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
    );
    const busySessionIds = new Set(
      activeValidationJobs
        .map((job) => job.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    const availableSessions = activeSessions.filter(
      (session) => !busySessionIds.has(session.sessionId),
    );
    if (!availableSessions.length) return;
    const records: LinkRecord[] = [];
    let cursor = 0;
    do {
      const page = await buckets.list(
        GLOBAL_VALIDATOR_SCOPE,
        "main",
        cursor,
        500,
      );
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== 0);
    const pending = records
      .filter(
        (record) =>
          record.metadata?.needsValidation === true ||
          (record.lastCheckedAt === undefined &&
            record.metadata?.needsValidation !== false),
      )
      .sort(
        (left, right) =>
          right.firstSeenAt - left.firstSeenAt ||
          left.canonicalUrl.localeCompare(right.canonicalUrl),
      );
    if (!pending.length) return;
    // Keep admission small enough to isolate a bad link, but feed each
    // available session a five-link batch so large imports can finish within
    // the operational target without creating a per-session burst.
    const validatorBatchSize = 5;
    const admitted = pending.slice(
      0,
      availableSessions.length * validatorBatchSize,
    );
    const chunks = availableSessions.map(() => [] as string[]);
    admitted.forEach((record, index) => {
      chunks[index % chunks.length]?.push(record.canonicalUrl);
    });
    const jobs: Promise<unknown>[] = [];
    for (const [index, urls] of chunks.entries()) {
      const session = availableSessions[index];
      if (!session || !urls.length) continue;
      const batch = urls.slice(0, validatorBatchSize);
      const validationLeaseToken = randomUUID();
      const claimed = await claimValidatorMainLinks(
        GLOBAL_VALIDATOR_SCOPE,
        batch,
        session.sessionId,
        validationLeaseToken,
      ).catch(() => 0);
      if (claimed !== batch.length) continue;
      const payload = {
        urls: batch,
        sourceSessionId: session.sessionId,
        sourceUserId: "validator-auto",
        validationLeaseToken,
      };
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      jobs.push(
        orchestrator
          .enqueue({
            workspaceId: session.workspaceId,
            sessionId: session.sessionId,
            kind: "link-validation",
            payload,
            idempotencyKey: `validator-auto:global:${session.sessionId}:${payloadHash}`,
          })
          .catch(async (error) => {
            for (const url of batch)
              await buckets.move(GLOBAL_VALIDATOR_SCOPE, url, "error", {
                validationError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
                metadata: {
                  needsValidation: false,
                  validationState: "retryable-error",
                  validationLeaseToken,
                },
              });
            throw error;
          }),
      );
    }
    await Promise.allSettled(jobs);
  } finally {
    validatorSweepBusy = false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitWithHeartbeat(
  context: WorkerContext,
  waitMs: number,
  progress: Pick<
    JobProgress,
    "currentGroup" | "currentAction" | "nextActionAt"
  >,
): Promise<void> {
  const nextActionAt = progress.nextActionAt ?? Date.now() + waitMs;
  let remaining = Math.max(0, nextActionAt - Date.now());
  while (remaining > 0 && !context.isCancellationRequested()) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(15_000, remaining)),
    );
    remaining = Math.max(0, nextActionAt - Date.now());
    if (remaining > 0)
      await context.report({
        ...progress,
        nextActionAt,
        lastResult: `Next group post in ${Math.ceil(remaining / 1000)}s.`,
      });
  }
}

export function stopWorkerRuntimeForTests(): void {
  if (validatorSweepTimer) clearInterval(validatorSweepTimer);
  if (validatorGuardTimer) clearInterval(validatorGuardTimer);
  validatorSweepTimer = undefined;
  validatorGuardTimer = undefined;
}
