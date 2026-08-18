import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { LinkBucketStore } from "../links/link-bucket-store.js";
import { runBoundedBatch } from "./bounded-batch.js";
import { JobOrchestrator } from "./job-orchestrator.js";

interface LinkValidationPayload {
  urls?: string[];
  sourceUserId?: string;
  sourceSessionId?: string;
}

export function startWorkerRuntime(): JobOrchestrator {
  const orchestrator = new JobOrchestrator(env.QUEUE_CONCURRENCY);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const buckets = new LinkBucketStore(redis);
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
        try {
          const parsed = new URL(url.trim());
          if (!["http:", "https:"].includes(parsed.protocol))
            return { status: "failed" as const };
          const canonicalUrl = parsed.toString();
          await buckets.upsert({
            canonicalUrl,
            originalUrl: url,
            bucket: "active",
            workspaceId: context.job.workspaceId,
            sourceUserId: payload.sourceUserId ?? "worker",
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
