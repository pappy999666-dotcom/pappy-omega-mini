import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  LinkBucketStore,
  type LinkRecord,
} from "../links/link-bucket-store.js";
import { getWhatsAppSocket } from "../whatsapp/session-manager.js";
import {
  getSession,
  getWorkspaceDefaults,
  listSessions,
  updateSession,
} from "../core/session-registry.js";
import {
  sendGroupMentions,
  sendGroupStatus,
  sendGroupText,
  type GroupMediaPayload,
  validateInviteLink,
} from "../whatsapp/transport-adapter.js";
import {
  readJobMedia,
  type JobMediaReference,
} from "../whatsapp/job-media-store.js";
import { selectHealthyWhatsAppSession } from "../whatsapp/session-allocator.js";
import { runBoundedBatch } from "./bounded-batch.js";
import { JobOrchestrator } from "./job-orchestrator.js";
import { joinWhatsAppInvite } from "./join-operation.js";
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
          const canonicalUrl = parsed.toString();
          const inviteCode = canonicalUrl.match(
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/,
          )?.[1];
          const sourceSessionId = selectHealthyWhatsAppSession(
            context.job.workspaceId,
            payload.sourceSessionId,
            canonicalUrl,
          )?.sessionId;
          if (!inviteCode || !sourceSessionId)
            throw new Error(
              "No safe WhatsApp validation session is available.",
            );
          const metadata = await validateInviteLink(
            context.job.workspaceId,
            sourceSessionId,
            inviteCode,
          );
          await buckets.upsert({
            canonicalUrl,
            originalUrl: raw,
            bucket: "active",
            workspaceId: context.job.workspaceId,
            sourceUserId: payload.sourceUserId ?? "worker",
            sourceSessionId,
            lastCheckedAt: Date.now(),
            metadata: {
              ...(metadata.subject ? { title: metadata.subject } : {}),
              ...(metadata.participantCount !== undefined
                ? { memberCount: metadata.participantCount }
                : {}),
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
              return new URL(raw).toString();
            } catch {
              return raw;
            }
          })();
          await context.report({
            currentLink: parsed,
            currentAction: "validation failed",
            lastResult: message.slice(0, 240),
          });
          await buckets
            .move(
              context.job.workspaceId,
              parsed,
              message.toLowerCase().includes("not found") ||
                message.toLowerCase().includes("expired")
                ? "dead"
                : "error",
              {
                validationError: message.slice(0, 240),
                lastCheckedAt: Date.now(),
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
    const allActive = await buckets.listAll(context.job.workspaceId);
    const selectedLinks = new Set(
      (payload.selectedLinks ?? []).map((link) => link.trim()).filter(Boolean),
    );
    const sourceRecords = allActive
      .filter(
        (record) =>
          record.bucket === "active" &&
          (!record.sourceSessionId || record.sourceSessionId === sessionId) &&
          (selectedLinks.size === 0 ||
            selectedLinks.has(record.canonicalUrl) ||
            selectedLinks.has(record.originalUrl)),
      )
      .slice(
        0,
        payload.targetCount && payload.targetCount > 0
          ? Math.min(payload.targetCount, allActive.length)
          : undefined,
      );
    const batchCycles = Math.max(
      1,
      Math.min(20, Number(payload.batchCycles ?? 1)),
    );
    const workItems = Array.from({ length: batchCycles }).flatMap((_, cycle) =>
      sourceRecords.map((record) => ({ record, cycle })),
    );
    let rateLimitHits = 0;
    let requested = 0;
    let alreadyMember = 0;
    let deadLinks = 0;
    let joined = 0;
    let lastAttemptAt = 0;
    const fallbackDelay = Math.max(
      1000,
      Math.min(600000, Number(payload.delayMs ?? 5000)),
    );
    const minDelayMs = Math.max(
      1000,
      Math.min(600000, Number(payload.minDelayMs ?? fallbackDelay)),
    );
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
          currentAction: "checking invite",
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
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            classified.retryable ? "error" : "dead",
            {
              validationError: classified.message.slice(0, 240),
              metadata: {
                ...metadata,
                joinClassification: classified.classification,
                joinRetryable: classified.retryable,
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
        text?: string;
        count?: number;
        delayMs?: number;
        media?: JobMediaReference;
      };
      const baseGroups =
        kind === "gstatus"
          ? [payload.groups?.[0]].filter((jid): jid is string => Boolean(jid))
          : (payload.groups ?? []);
      const repeat =
        kind === "gstatus" || kind === "allstatus" || kind === "allchat"
          ? Math.max(1, Math.min(20, Number(payload.count ?? 1)))
          : 1;
      const uniqueGroups = [...new Set(baseGroups)];
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
      return runBoundedBatch({
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
            await context.report({
              currentGroup: jid,
              currentAction: "posted",
              lastResult: `${kind} posted to ${jid}${repeat > 1 ? ` · repeat ${repeatIndex}/${repeat}` : ""}`,
            });
            return { status: "success" as const };
          } catch (error) {
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

  return orchestrator;
}
