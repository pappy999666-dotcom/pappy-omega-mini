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
  validateInviteLink,
} from "../whatsapp/transport-adapter.js";
import { runBoundedBatch } from "./bounded-batch.js";
import { JobOrchestrator } from "./job-orchestrator.js";
import { createDefaultPreviewManager } from "../preview/default-adapter.js";
import { joinWhatsAppInvite } from "./join-operation.js";

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
let activeBuckets: LinkBucketStore | undefined;

export function getWorkerRuntime(): JobOrchestrator | undefined {
  return activeRuntime;
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
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const buckets = new LinkBucketStore(redis);
  activeBuckets = buckets;
  const previewManager = createDefaultPreviewManager(redis);
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
        try {
          const parsed = new URL(raw);
          if (!["http:", "https:"].includes(parsed.protocol))
            return { status: "failed" as const };
          const canonicalUrl = parsed.toString();
          const inviteCode = canonicalUrl.match(
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/,
          )?.[1];
          const sourceSessionId =
            payload.sourceSessionId ??
            listSessions(context.job.workspaceId).find(
              (session) => session.status === "ACTIVE",
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
      requestMode?: "auto" | "immediate" | "request";
    };
    const active = await buckets.list(
      context.job.workspaceId,
      "active",
      0,
      Math.max(
        1,
        Math.min(
          10000,
          payload.targetCount && payload.targetCount > 0
            ? payload.targetCount
            : 10000,
        ),
      ),
    );
    const records = active.records.filter(
      (record) =>
        !record.sourceSessionId || record.sourceSessionId === sessionId,
    );
    let rateLimitHits = 0;
    let requested = 0;
    let alreadyMember = 0;
    let deadLinks = 0;
    let joined = 0;
    let lastAttemptAt = 0;
    const delayMs = Math.max(
      1000,
      Math.min(600000, Number(payload.delayMs ?? 5000)),
    );
    return runBoundedBatch({
      items: records,
      concurrency: 1,
      context,
      shouldStop: () => rateLimitHits >= 5,
      processItem: async (record, signal) => {
        if (signal.aborted) return { status: "skipped" as const };
        const now = Date.now();
        if (lastAttemptAt) {
          const wait = Math.max(0, delayMs - (now - lastAttemptAt));
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        lastAttemptAt = Date.now();
        await context.report({
          currentLink: record.canonicalUrl,
          currentAction: "checking invite",
        });
        const result = await joinWhatsAppInvite(socket, record.canonicalUrl);
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
            rateLimitStopAt: 5,
            lastResult: `Rate limited after ${rateLimitHits} attempt(s)`,
            currentAction:
              rateLimitHits >= 5 ? "stopped at rate limit" : "cooling down",
          });
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
      };
      const baseGroups =
        kind === "gstatus"
          ? [payload.groups?.[0]].filter((jid): jid is string => Boolean(jid))
          : (payload.groups ?? []);
      const repeat =
        kind === "gstatus" || kind === "allstatus" || kind === "allchat"
          ? Math.max(1, Math.min(20, Number(payload.count ?? 1)))
          : 1;
      const groups = baseGroups.flatMap((jid) =>
        Array.from({ length: repeat }, () => jid),
      );
      const text = payload.text?.trim();
      if (!text) throw new Error(`${kind} requires a non-empty text payload.`);
      const delayMs = Math.max(
        1500,
        Math.min(120000, Number(payload.delayMs ?? 2500)),
      );
      let lastPostAt = 0;
      return runBoundedBatch({
        items: groups,
        concurrency: 1,
        context,
        processItem: async (jid, signal) => {
          if (signal.aborted) return { status: "skipped" as const };
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
              });
            else if (kind === "allchat")
              await sendGroupText(
                context.job.workspaceId,
                sessionId,
                jid,
                text,
                previewManager,
              );
            else
              await sendGroupMentions(
                context.job.workspaceId,
                sessionId,
                jid,
                text,
                payload.count,
                previewManager,
              );
            await context.report({
              currentGroup: jid,
              currentAction: "posted",
              lastResult: `${kind} posted to ${jid}`,
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
