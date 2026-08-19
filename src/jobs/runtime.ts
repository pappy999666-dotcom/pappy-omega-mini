import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { LinkBucketStore } from "../links/link-bucket-store.js";
import { getWhatsAppSocket } from "../whatsapp/session-manager.js";
import { listSessions } from "../core/session-registry.js";
import {
  sendGroupMentions,
  sendGroupStatus,
  sendGroupText,
  validateInviteLink,
} from "../whatsapp/transport-adapter.js";
import { runBoundedBatch } from "./bounded-batch.js";
import { JobOrchestrator } from "./job-orchestrator.js";
import { createDefaultPreviewManager } from "../preview/default-adapter.js";

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

export function getWorkerRuntime(): JobOrchestrator | undefined {
  return activeRuntime;
}

export function startWorkerRuntime(): JobOrchestrator {
  if (activeRuntime) return activeRuntime;
  const orchestrator = new JobOrchestrator(env.QUEUE_CONCURRENCY);
  activeRuntime = orchestrator;
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const buckets = new LinkBucketStore(redis);
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
    ) as typeof getWhatsAppSocket extends (...args: never[]) => infer R
      ? R & { groupAcceptInvite: (code: string) => Promise<unknown> }
      : never;
    const payload = context.job.payload as {
      targetCount?: number;
      delayMs?: number;
    };
    const active = await buckets.list(
      context.job.workspaceId,
      "active",
      0,
      Math.max(1, payload.targetCount ?? 100),
    );
    const records = active.records.filter(
      (record) =>
        !record.sourceSessionId || record.sourceSessionId === sessionId,
    );
    return runBoundedBatch({
      items: records,
      concurrency: 1,
      context,
      processItem: async (record) => {
        const inviteCode =
          record.metadata?.inviteCode ??
          record.canonicalUrl.match(
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/,
          )?.[1];
        if (!inviteCode) {
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            "dead",
            { validationError: "No WhatsApp invite code found." },
          );
          return { status: "failed" as const };
        }
        try {
          await socket.groupAcceptInvite(inviteCode);
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            "active",
            { lastCheckedAt: Date.now() },
          );
          const delayMs = Math.max(
            0,
            Math.min(600000, Number(payload.delayMs ?? 0)),
          );
          if (delayMs)
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { status: "success" as const };
        } catch (error) {
          const classified = classifyJoinFailure(error);
          if (classified.classification === "already-member") {
            await buckets.move(
              context.job.workspaceId,
              record.canonicalUrl,
              "active",
              {
                lastCheckedAt: Date.now(),
                metadata: {
                  ...record.metadata,
                  joinClassification: classified.classification,
                  joinRetryable: false,
                },
              },
            );
            return { status: "success" as const };
          }
          if (classified.retryable) {
            await context.report({
              retrying: (context.job.progress.retrying ?? 0) + 1,
            });
          }
          await buckets.move(
            context.job.workspaceId,
            record.canonicalUrl,
            classified.retryable ? "error" : "dead",
            {
              validationError: classified.message.slice(0, 240),
              metadata: {
                ...record.metadata,
                joinClassification: classified.classification,
                joinRetryable: classified.retryable,
              },
              lastCheckedAt: Date.now(),
            },
          );
          return { status: "failed" as const };
        }
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
      };
      const groups =
        kind === "gstatus"
          ? Array.from(
              { length: Math.max(1, Math.min(20, payload.count ?? 1)) },
              () => payload.groups?.[0],
            ).filter((jid): jid is string => Boolean(jid))
          : (payload.groups ?? []);
      const text = payload.text?.trim();
      if (!text) throw new Error(`${kind} requires a non-empty text payload.`);
      return runBoundedBatch({
        items: groups,
        concurrency: 1,
        context,
        processItem: async (jid) => {
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
            return { status: "success" as const };
          } catch {
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
