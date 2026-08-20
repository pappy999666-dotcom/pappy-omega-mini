import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  LinkBucketStore,
  type LinkRecord,
} from "../links/link-bucket-store.js";
import {
  claimValidatorMainLinks,
  requeueLegacyValidatorErrors,
  requeueValidatorMainLinks,
} from "../links/validator-operations.js";
import { canonicalizeHttpUrl } from "../links/url-canonicalization.js";
import { getWhatsAppSocket } from "../whatsapp/session-manager.js";
import {
  getSession,
  getWorkspaceDefaults,
  listAllSessions,
  listSessions,
  updateSession,
} from "../core/session-registry.js";
import {
  listGroups,
  sendGroupMentions,
  sendGroupStatus,
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
import { joinWhatsAppInvite } from "./join-operation.js";
import {
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
}

type JoinFailureClass =
  | "already-member"
  | "invalid-invite"
  | "forbidden"
  | "rate-limit"
  | "transport";
function classifyJoinFailure(error: unknown): {
  classification: JoinFailureClass;
  retryable: boolean;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("already") ||
    lower.includes("participant") ||
    lower.includes("409")
  )
    return { classification: "already-member", retryable: false, message };
  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("invite")
  )
    return { classification: "invalid-invite", retryable: false, message };
  if (
    lower.includes("forbidden") ||
    lower.includes("not allowed") ||
    lower.includes("unauthorized")
  )
    return { classification: "forbidden", retryable: false, message };
  if (lower.includes("rate") || lower.includes("429"))
    return { classification: "rate-limit", retryable: true, message };
  if (
    lower.includes("timeout") ||
    lower.includes("tempor") ||
    lower.includes("network")
  )
    return { classification: "transport", retryable: true, message };
  return { classification: "transport", retryable: true, message };
}

let activeRuntime: JobOrchestrator | undefined;
let jobCompletionNotifier:
  | ((job: import("./job-contracts.js").JobRecord) => Promise<void>)
  | undefined;
let activeBuckets: LinkBucketStore | undefined;
let activeJoinResults: JoinResultStore | undefined;
let validatorSweepTimer: NodeJS.Timeout | undefined;
const validatorErrorMigrations = new Set<string>();

export function getWorkerRuntime(): JobOrchestrator | undefined {
  return activeRuntime;
}

export function setJobCompletionNotifier(
  notifier: (job: import("./job-contracts.js").JobRecord) => Promise<void>,
): void {
  jobCompletionNotifier = notifier;
}

export async function purgeRuntimeSessionData(
  workspaceId: string,
  sessionId: string,
): Promise<{ jobs: number; links: number }> {
  const jobs = activeRuntime
    ? await activeRuntime.purgeSession(workspaceId, sessionId)
    : 0;
  const links = activeBuckets
    ? await activeBuckets.removeSourceSession(workspaceId, sessionId)
    : 0;
  return { jobs, links };
}

export function startWorkerRuntime(): JobOrchestrator {
  if (activeRuntime) return activeRuntime;
  const orchestrator = new JobOrchestrator(env.QUEUE_CONCURRENCY);
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
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
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
    await redis.set(key, "done", "EX", 60 * 60 * 24 * 30).catch(() => undefined);
  };
  const joinResults = new JoinResultStore(redis);
  activeBuckets = buckets;
  activeJoinResults = joinResults;
  orchestrator.addCloseHook(async () => {
    if (validatorSweepTimer) clearInterval(validatorSweepTimer);
    validatorSweepTimer = undefined;
    validatorErrorMigrations.clear();
    await redis.quit();
  });

  orchestrator.register("link-validation", async (context) => {
    const payload = context.job.payload as LinkValidationPayload;
    const urls = payload.urls ?? [];
    return runBoundedBatch({
      items: urls,
      concurrency: env.QUEUE_CONCURRENCY,
      context,
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
          if (!inviteCode) throw new Error("Invalid WhatsApp group invite link.");
          const candidates = listHealthyWhatsAppSessions(
            context.job.workspaceId,
            payload.sourceSessionId,
          );
          const sourceSession = candidates[0] ?? selectHealthyWhatsAppSession(
            context.job.workspaceId,
            payload.sourceSessionId,
            canonicalUrl,
          );
          if (!sourceSession)
            throw new Error("No healthy WhatsApp validation session is available yet.");
          const existing = await buckets.get(context.job.workspaceId, canonicalUrl);
          const validatingMetadata = {
            ...(existing?.metadata ?? {}),
            inviteCode,
            needsValidation: false,
            validationState: "validating" as const,
          };
          if (existing)
            await buckets.move(context.job.workspaceId, canonicalUrl, "active", {
              sourceSessionId: sourceSession.sessionId,
              metadata: validatingMetadata,
            });
          else
            await buckets.upsert({
              canonicalUrl,
              originalUrl: raw,
              bucket: "active",
              workspaceId: context.job.workspaceId,
              sourceUserId: payload.sourceUserId ?? "worker",
              sourceSessionId: sourceSession.sessionId,
              metadata: validatingMetadata,
            });
          let metadata: Awaited<ReturnType<typeof validateInviteLink>> | undefined;
          let sourceSessionId: string | undefined;
          let lastValidationError: unknown;
          for (const candidate of candidates.length ? candidates : [sourceSession]) {
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
            }
          }
          if (!metadata || !sourceSessionId)
            throw lastValidationError instanceof Error
              ? lastValidationError
              : new Error("Invite validation failed on all healthy sessions.");
          await buckets.upsert({
            canonicalUrl,
            originalUrl: raw,
            bucket: "active",
            workspaceId: context.job.workspaceId,
            sourceUserId: payload.sourceUserId ?? "worker",
            sourceSessionId,
            lastCheckedAt: Date.now(),
            metadata: {
              ...(existing?.metadata ?? {}),
              ...(metadata.subject ? { title: metadata.subject } : {}),
              ...(metadata.participantCount !== undefined
                ? { memberCount: metadata.participantCount }
                : {}),
              inviteCode,
              needsValidation: false,
              validationState: "active",
            },
          });
          const currentSession = getSession(
            context.job.workspaceId,
            sourceSessionId,
          );
          updateSession(context.job.workspaceId, sourceSessionId, {
            validatedLinkCount: (currentSession.validatedLinkCount ?? 0) + 1,
            lastLinkValidatedAt: Date.now(),
          });
          await context.report({
            currentLink: canonicalUrl,
            currentAction: "validated",
            lastResult: `Active: ${metadata.subject ?? canonicalUrl}`,
          });
          if (currentSession.autoJoinEnabled && activeRuntime) {
            const defaults = getWorkspaceDefaults(context.job.workspaceId);
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
                delayMs: defaults.defaultJoinDelayMs,
                minDelayMs: defaults.defaultJoinMinDelayMs,
                maxDelayMs: defaults.defaultJoinMaxDelayMs,
                retryLimit: defaults.defaultJoinRetryLimit,
                retryBaseMs: defaults.defaultJoinRetryBaseMs,
                sessionCooldownMs: defaults.defaultJoinSessionCooldownMs,
                restrictionThreshold: defaults.defaultJoinRestrictionThreshold,
                requestMode: defaults.defaultJoinMode ?? "auto",
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
          const isDead = [
            "invalid whatsapp group invite",
            "not found",
            "expired",
            "revoked",
            "unknown invite",
            "group not found",
            "gone",
          ].some((marker) => lower.includes(marker));
          const existing = await buckets.get(context.job.workspaceId, parsed);
          if (
            existing &&
            (existing.bucket !== "active" ||
              existing.metadata?.validationState !== "validating")
          )
            return { status: "skipped" as const };
          await buckets
            .move(
              context.job.workspaceId,
              parsed,
              isDead ? "dead" : "main",
              {
                validationError: message.slice(0, 240),
                metadata: {
                  ...(existing?.metadata ?? {}),
                  needsValidation: !isDead,
                  validationState: isDead ? "dead" : "retryable-error",
                },
              },
            )
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
          const parsed = new URL(url.trim());
          if (!["http:", "https:"].includes(parsed.protocol))
            return { status: "failed" as const };
          await buckets.upsert({
            canonicalUrl: parsed.toString(),
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

  orchestrator.register("join-manager", async (context) => {
    const sessionId = context.job.sessionId;
    if (!sessionId)
      throw new Error("Join Manager requires a selected WhatsApp session.");
    const boundSession = getSession(context.job.workspaceId, sessionId);
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
    };
    const selectedLinks = new Set(
      (payload.selectedLinks ?? []).map((link) => link.trim()).filter(Boolean),
    );
    const targetLimit =
      payload.targetCount && payload.targetCount > 0
        ? Math.min(10000, payload.targetCount)
        : 10000;
    const sourceRecords: LinkRecord[] = [];
    if (selectedLinks.size) {
      for (const link of selectedLinks) {
        const record = await buckets.get(context.job.workspaceId, link);
        if (
          record?.bucket === "active" &&
          !["joined", "already-member", "request-required"].includes(
            record.metadata?.joinClassification ?? "",
          )
        )
          sourceRecords.push(record);
      }
    } else {
      let cursor = 0;
      do {
        const page = await buckets.list(
          context.job.workspaceId,
          "active",
          cursor,
          100,
        );
        for (const record of page.records) {
          if (
            !["joined", "already-member", "request-required"].includes(
              record.metadata?.joinClassification ?? "",
            )
          )
            sourceRecords.push(record);
        }
        cursor = page.nextCursor;
      } while (cursor !== 0);
    }
    const shuffledRecords = sourceRecords
      .map((record) => ({
        record,
        sortKey: createHash("sha256")
          .update(`${context.job.jobId}:${record.canonicalUrl}`)
          .digest("hex"),
      }))
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ record }) => record)
      .slice(0, targetLimit);
    sourceRecords.length = 0;
    sourceRecords.push(...shuffledRecords);
    const batchCycles = Math.max(
      1,
      Math.min(20, Number(payload.batchCycles ?? 1)),
    );
    const workItems = Array.from({ length: batchCycles }).flatMap((_, cycle) =>
      sourceRecords.map((record) => ({ record, cycle })),
    );
    await context.report({
      total: workItems.length,
      currentAction: `shuffled Active inventory · selected ${sourceRecords.length} link(s)`,
    });
    let rateLimitHits = 0;
    let requested = 0;
    let alreadyMember = 0;
    let deadLinks = 0;
    let joined = 0;
    let lastAttemptAt = 0;
    const immediateMode = payload.requestMode === "immediate";
    const fallbackDelay = immediateMode
      ? 0
      : Math.max(0, Math.min(600000, Number(payload.delayMs ?? 0)));
    const minDelayMs = immediateMode
      ? 0
      : Math.max(0, Math.min(600000, Number(payload.minDelayMs ?? fallbackDelay)));
    const maxDelayMs = Math.max(
      minDelayMs,
      Math.min(600000, Number(payload.maxDelayMs ?? minDelayMs)),
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
    const restrictionThreshold = Math.max(
      1,
      Math.min(20, Number(payload.restrictionThreshold ?? 5)),
    );
    return runBoundedBatch({
      items: workItems,
      concurrency: Math.max(
        1,
        Math.min(8, Math.floor(Number(payload.maxConcurrency ?? 1))),
      ),
      context,
      shouldStop: () => rateLimitHits >= restrictionThreshold,
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
          context.job.workspaceId,
          record.canonicalUrl,
        );
        if (!currentRecord || currentRecord.bucket !== "active")
          return { status: "skipped" as const };
        const now = Date.now();
        if (lastAttemptAt) {
          const interval =
            minDelayMs === maxDelayMs
              ? minDelayMs
              : minDelayMs +
                Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
          const wait = Math.max(0, interval - (now - lastAttemptAt));
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        lastAttemptAt = Date.now();
        await context.report({
          currentLink: record.canonicalUrl,
          currentAction: `checking invite via ${boundSession.sessionName} · socket ${sessionId.slice(0, 8)} · generation ${boundSession.socketGeneration ?? "—"}`,
        });
        let retryAttempt = 0;
        let result = await joinWhatsAppInvite(socket, record.canonicalUrl, {
          mode: payload.requestMode ?? "auto",
        });
        while (
          !result.success &&
          !result.alreadyMember &&
          !result.requestRequired &&
          retryAttempt < retryLimit
        ) {
          const retryClass = classifyJoinFailure(result.error ?? "Join failed");
          if (
            !retryClass.retryable ||
            retryClass.classification === "rate-limit"
          )
            break;
          retryAttempt += 1;
          await context.report({
            retrying: retryAttempt,
            currentAction: `retrying in ${retryBaseMs * retryAttempt}ms`,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, retryBaseMs * retryAttempt),
          );
          if (signal.aborted) return { status: "skipped" as const };
          result = await joinWhatsAppInvite(socket, record.canonicalUrl, {
            mode: payload.requestMode ?? "auto",
          });
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
          joined += 1;
          await buckets.move(
            context.job.workspaceId,
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
          });
          return { status: "success" as const };
        }
        if (result.alreadyMember) {
          alreadyMember += 1;
          await buckets.move(
            context.job.workspaceId,
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
          });
          return { status: "skipped" as const };
        }
        const classified = classifyJoinFailure(result.error ?? "Join failed");
        if (result.requestRequired) {
          requested += 1;
          await buckets.move(
            context.job.workspaceId,
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
          });
          return { status: "skipped" as const };
        }
        if (classified.classification === "rate-limit") {
          rateLimitHits += 1;
          await context.report({
            retrying: (context.job.progress.retrying ?? 0) + 1,
            rateLimitHits,
            rateLimitStopAt: restrictionThreshold,
            lastResult: `Rate limited after ${rateLimitHits} attempt(s)`,
            currentAction:
              rateLimitHits >= restrictionThreshold
                ? "stopped at rate limit"
                : "cooling down",
          });
          if (sessionCooldownMs && rateLimitHits < restrictionThreshold)
            await new Promise((resolve) =>
              setTimeout(resolve, sessionCooldownMs),
            );
        }
        if (classified.classification === "invalid-invite") {
          deadLinks += 1;
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            "main",
            {
              validationError:
                "Dead or revoked invite returned to Main for re-validation.",
              lastCheckedAt: Date.now(),
              metadata: {
                ...metadata,
                joinClassification: "dead-link",
                joinRetryable: true,
                needsValidation: true,
                validationState: "pending",
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
            lastResult: `Dead link returned to Main: ${record.canonicalUrl}`,
            currentAction: "returned to main",
          });
        } else {
          const retryable = classified.retryable || classified.classification === "rate-limit";
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            retryable ? "main" : "dead",
            {
              validationError: classified.message.slice(0, 240),
              metadata: {
                ...metadata,
                joinClassification: classified.classification,
                joinRetryable: retryable,
                needsValidation: retryable,
                ...(retryable ? { validationState: "pending" as const } : {}),
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
        return { status: "failed" as const };
      },
    });
  });

  for (const kind of ["gstatus", "allstatus", "allchat", "tag"] as const) {
    orchestrator.register(kind, async (context) => {
      const sessionId = context.job.sessionId;
      if (!sessionId) throw new Error(`${kind} requires a WhatsApp session.`);
      const payload = context.job.payload as {
        groups?: string[];
        originJid?: string;
        text?: string;
        count?: number;
        delayMs?: number;
        media?: JobMediaReference;
      };
      let baseGroups: string[];
      if (kind === "gstatus") {
        baseGroups = [payload.groups?.[0]].filter(
          (jid): jid is string => Boolean(jid),
        );
      } else if (payload.groups?.length) {
        baseGroups = payload.groups;
      } else {
        await context.report({
          currentAction: "resolving group inventory",
          lastResult: "The worker is fetching the current WhatsApp group list.",
        });
        const inventoryHeartbeat = setInterval(() => {
          void context
            .report({
              currentAction: "resolving group inventory",
              lastResult: "Still fetching the current WhatsApp group list…",
            })
            .catch(() => undefined);
        }, 5_000);
        inventoryHeartbeat.unref?.();
        try {
          baseGroups = (await listGroups(
            context.job.workspaceId,
            sessionId,
          )).map((group) => group.jid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
      const repeat =
        kind === "gstatus" || kind === "allstatus" || kind === "allchat"
          ? Math.max(1, Math.min(20, Number(payload.count ?? 1)))
          : 1;
      const uniqueGroups = [...new Set(baseGroups)];
      const resolvedPayload = {
        ...payload,
        groups: uniqueGroups,
      };
      await context.report(
        {
          total: uniqueGroups.length,
          currentAction: `${kind} inventory resolved`,
          lastResult: `Resolved ${uniqueGroups.length} WhatsApp group(s); delivery is starting.`,
        },
        { payload: resolvedPayload },
      );
      const originJid =
        typeof payload.originJid === "string" ? payload.originJid : undefined;
      if (originJid) {
        const notifyKey = `pappy-omega-mini:broadcast-resolved:${context.job.jobId}`;
        const claimed = await redis.set(
          notifyKey,
          "done",
          "EX",
          60 * 60 * 24 * 30,
          "NX",
        );
        if (claimed === "OK") {
          const delaySeconds = Math.max(
            1,
            Math.round(Number(payload.delayMs ?? 20_000) / 1000),
          );
          const expectedPosts = uniqueGroups.length * repeat;
          const expectedSeconds = Math.max(0, expectedPosts - 1) * delaySeconds;
          const minutes = Math.floor(expectedSeconds / 60);
          const seconds = expectedSeconds % 60;
          const label = kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT";
          const action =
            kind === "allstatus"
              ? "Status delivery is now posting to every resolved group."
              : "Hidden-member mention delivery is now posting to every resolved group.";
          void sendDirectText(
            context.job.workspaceId,
            sessionId,
            originJid,
            [
              `✦ PAPPY OMEGA MINI · ${label} READY`,
              "──────────────────────────────",
              `Total groups  · ${uniqueGroups.length}`,
              `Expected posts · ${expectedPosts}`,
              `Delay         · ${delaySeconds}s`,
              `Expected time · ${minutes}m ${seconds}s`,
              `Live code     · ${context.job.jobCode ?? context.job.jobId.slice(0, 8)}`,
              `Action        · ${action}`,
            ].join("\\n"),
          ).catch((error) => {
            console.warn(
              `[pappy-omega-mini] broadcast roster notification failed job=${context.job.jobId}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
        }
      }
      const deliveries = uniqueGroups.flatMap((jid) =>
        Array.from({ length: repeat }, (_, repeatIndex) => ({
          jid,
          repeatIndex: repeatIndex + 1,
        })),
      );
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim() && !payload.media)
        throw new Error(`${kind} requires text or media payload.`);
      const delayMs = Math.max(
        1500,
        Math.min(120000, Number(payload.delayMs ?? 2500)),
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
      let lastPostAt = 0;
      let completedDeliveries = 0;
      let failedDeliveries = 0;
      const autoPromoteRunId = typeof (context.job.payload as { autoPromoteRunId?: unknown }).autoPromoteRunId === "string"
        ? (context.job.payload as { autoPromoteRunId: string }).autoPromoteRunId
        : undefined;
      const sessionLock = await waitForSessionOperationLock(context.job.workspaceId, sessionId, context.signal);
      if (!sessionLock) throw new Error("WhatsApp session operation was cancelled before its lock became available.");
      try {
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
            });
            return { status: "skipped" as const };
          }
          if (lastPostAt) {
            const wait = Math.max(0, delayMs - (Date.now() - lastPostAt));
            if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          }
          lastPostAt = Date.now();
          await context.report({
            currentGroup: jid,
            currentAction: `posting ${kind}`,
          });
          try {
            if (kind === "gstatus" || kind === "allstatus")
              await sendGroupStatus(context.job.workspaceId, sessionId, jid, {
                text,
                ...(media ? { media } : {}),
              });
            else if (kind === "allchat")
              await sendGroupMentions(
                context.job.workspaceId,
                sessionId,
                jid,
                text,
                undefined,
                media,
              );
            else
              await sendGroupMentions(
                context.job.workspaceId,
                sessionId,
                jid,
                text,
                undefined,
                media,
              );
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
            await context.report({
              currentGroup: jid,
              currentAction: "posted",
              lastResult: `${kind} posted to ${jid}${repeat > 1 ? ` · repeat ${repeatIndex}/${repeat}` : ""}`,
            });
            return { status: "success" as const };
          } catch (error) {
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
                `${kind} skipped ${jid}: ${error instanceof Error ? error.message : String(error)}`.slice(
                  0,
                  500,
                ),
            });
            return { status: "failed" as const };
          }
        },
        });
      } finally {
        await sessionLock.release();
      }
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

  void orchestrator.recoverStaleJobsNow().catch((error) => {
    console.error(
      "[pappy-omega-mini] immediate stale-job recovery failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
  void sweepPendingMainValidation(orchestrator, buckets);
  validatorSweepTimer = setInterval(
    () => void sweepPendingMainValidation(orchestrator, buckets),
    5_000,
  );
  validatorSweepTimer.unref?.();
  return orchestrator;
}


async function sweepPendingMainValidation(
  orchestrator: JobOrchestrator,
  buckets: LinkBucketStore,
): Promise<void> {
  const activeSessions = listAllSessions().filter(
    (session) => session.status === "ACTIVE" && session.authHealth !== "INVALID",
  );
  const workspaceIds = [...new Set(activeSessions.map((session) => session.workspaceId))];
  for (const workspaceId of workspaceIds) {
    if (!validatorErrorMigrations.has(workspaceId)) {
      await requeueLegacyValidatorErrors(workspaceId).catch(() => 0);
      validatorErrorMigrations.add(workspaceId);
    }
    const sessions = activeSessions.filter(
      (session) => session.workspaceId === workspaceId,
    );
    if (!sessions.length) continue;
    const activeValidationJobs = (await orchestrator.listRecent(500)).filter(
      (job) =>
        job.workspaceId === workspaceId &&
        job.kind === "link-validation" &&
        ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
    );
    const busySessionIds = new Set(
      activeValidationJobs
        .map((job) => job.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    const availableSessions = sessions.filter(
      (session) => !busySessionIds.has(session.sessionId),
    );
    if (!availableSessions.length) continue;
    const records: LinkRecord[] = [];
    let cursor = 0;
    do {
      const page = await buckets.list(workspaceId, "main", cursor, 500);
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
      .sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
    if (!pending.length) continue;
    const validatorBatchSize = 5;
    const admissionLimit = availableSessions.length * validatorBatchSize;
    const admitted = pending.slice(0, admissionLimit);
    const chunks = availableSessions.map(() => [] as string[]);
    admitted.forEach((record, index) => {
      chunks[index % chunks.length]?.push(record.canonicalUrl);
    });
    const jobs: Promise<unknown>[] = [];
    for (const [index, urls] of chunks.entries()) {
      const session = availableSessions[index];
      if (!session || !urls.length) continue;
      const batch = urls.slice(0, validatorBatchSize);
      const claimed = await claimValidatorMainLinks(
        workspaceId,
        batch,
        session.sessionId,
      ).catch(() => 0);
      if (claimed !== batch.length) continue;
      const payload = {
        urls: batch,
        sourceSessionId: session.sessionId,
        sourceUserId: "validator-auto",
      };
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      jobs.push(
        orchestrator
          .enqueue({
            workspaceId,
            sessionId: session.sessionId,
            kind: "link-validation",
            payload,
            idempotencyKey: `validator-auto:${workspaceId}:${session.sessionId}:${payloadHash}`,
          })
          .catch(async (error) => {
            for (const url of batch)
              await buckets.move(workspaceId, url, "main", {
                metadata: {
                  needsValidation: true,
                  validationState: "pending",
                },
              });
            throw error;
          }),
      );
    }
    await Promise.all(jobs);
  }
}

export function stopWorkerRuntimeForTests(): void {
  if (validatorSweepTimer) clearInterval(validatorSweepTimer);
  validatorSweepTimer = undefined;
  validatorErrorMigrations.clear();
}


async function waitForSessionOperationLock(
  workspaceId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionLock | undefined> {
  while (!signal.aborted) {
    const lock = await acquireSessionOperationLock(workspaceId, sessionId);
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}
