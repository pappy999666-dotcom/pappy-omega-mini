import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { assertOperationAllowed } from "../core/control-plane.js";
import type {
  JobKind,
  JobProgress,
  JobRecord,
  WorkerContext,
  WorkerHandler,
} from "./job-contracts.js";

const QUEUE_NAME = "pappy-omega-mini:jobs";
const STORE_PREFIX = "pappy-omega-mini:job:";

export class RedisJobStore {
  constructor(private readonly redis: Redis) {}

  async get(jobId: string): Promise<JobRecord | undefined> {
    const value = await this.redis.get(`${STORE_PREFIX}${jobId}`);
    return value ? (JSON.parse(value) as JobRecord) : undefined;
  }

  async set(record: JobRecord): Promise<void> {
    await this.redis.set(
      `${STORE_PREFIX}${record.jobId}`,
      JSON.stringify(record),
    );
  }

  async update(
    jobId: string,
    patch: Partial<JobRecord>,
  ): Promise<JobRecord | undefined> {
    const current = await this.get(jobId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.set(next);
    return next;
  }
}

export interface EnqueueInput<TPayload extends Record<string, unknown>> {
  workspaceId: string;
  sessionId?: string;
  kind: JobKind;
  payload: TPayload;
  idempotencyKey: string;
  maxAttempts?: number;
}

export class JobOrchestrator {
  private readonly redis: Redis;
  private readonly store: RedisJobStore;
  private readonly queue: Queue<JobRecord>;
  private readonly handlers = new Map<JobKind, WorkerHandler>();
  private readonly worker: Worker<JobRecord>;
  private readonly closeHooks: Array<() => Promise<void> | void> = [];

  constructor(concurrency = env.QUEUE_CONCURRENCY) {
    this.redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.store = new RedisJobStore(this.redis);
    this.queue = new Queue<JobRecord>(QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    });
    this.worker = new Worker<JobRecord>(
      QUEUE_NAME,
      async (job) => this.process(job),
      {
        connection: this.redis,
        concurrency: Math.max(1, Math.min(concurrency, 32)),
        limiter: { max: Math.max(1, concurrency * 2), duration: 1000 },
      },
    );
    this.worker.on("failed", (job, error) => {
      if (job)
        void this.store.update(job.data.jobId, {
          state: "FAILED",
          error: error.message,
          completedAt: Date.now(),
        });
    });
  }

  register(kind: JobKind, handler: WorkerHandler): void {
    this.handlers.set(kind, handler);
  }

  addCloseHook(hook: () => Promise<void> | void): void {
    this.closeHooks.push(hook);
  }

  async enqueue<TPayload extends Record<string, unknown>>(
    input: EnqueueInput<TPayload>,
  ): Promise<JobRecord<TPayload>> {
    const existing = await this.redis.get(
      `pappy-omega-mini:idempotency:${input.idempotencyKey}`,
    );
    if (existing) {
      const record = await this.store.get(existing);
      if (record) return record as JobRecord<TPayload>;
    }
    const record: JobRecord<TPayload> = {
      jobId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      workspaceId: input.workspaceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      kind: input.kind,
      payload: input.payload,
      state: "QUEUED",
      progress: emptyProgress(),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      cancellationRequested: false,
      createdAt: Date.now(),
    };
    await this.store.set(record);
    await this.redis.set(
      `pappy-omega-mini:idempotency:${input.idempotencyKey}`,
      record.jobId,
      "EX",
      60 * 60 * 24 * 30,
      "NX",
    );
    await this.queue.add(input.kind, record, {
      jobId: record.jobId,
      attempts: record.maxAttempts,
      backoff: { type: "exponential", delay: 1000 },
    });
    return record;
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    return this.store.get(jobId);
  }

  async cancel(jobId: string): Promise<JobRecord | undefined> {
    const record = await this.store.update(jobId, {
      state: "CANCELLING",
      cancellationRequested: true,
    });
    const job = await this.queue.getJob(jobId);
    if (job && !(await job.isActive()))
      await job.remove().catch(() => undefined);
    return record;
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    for (const hook of this.closeHooks) await hook();
    await this.redis.quit();
  }

  private async process(bullJob: BullJob<JobRecord>): Promise<void> {
    const record = bullJob.data;
    assertOperationAllowed(operationFor(record.kind));
    const handler = this.handlers.get(record.kind);
    if (!handler) throw new Error(`No worker registered for ${record.kind}.`);
    await this.store.update(record.jobId, {
      state: "RUNNING",
      attempts: bullJob.attemptsMade + 1,
      startedAt: Date.now(),
    });
    const controller = new AbortController();
    const context: WorkerContext = {
      job: (await this.store.get(record.jobId)) ?? record,
      signal: controller.signal,
      isCancellationRequested: () =>
        Boolean((context.job as JobRecord).cancellationRequested),
      report: async (progress) => {
        const current = await this.store.get(record.jobId);
        if (!current) return;
        context.job = current;
        const nextProgress = {
          ...current.progress,
          ...progress,
          elapsedMs: Date.now() - (current.startedAt ?? Date.now()),
        };
        await this.store.update(record.jobId, { progress: nextProgress });
        await bullJob.updateProgress(nextProgress);
      },
    };
    try {
      const result = await handler(context);
      const finalState = context.isCancellationRequested()
        ? "CANCELLED"
        : result.failed > 0
          ? "PARTIAL"
          : "COMPLETED";
      await context.report(result);
      await this.store.update(record.jobId, {
        state: finalState,
        completedAt: Date.now(),
        cancellationRequested: context.isCancellationRequested(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retrying = bullJob.attemptsMade + 1 < record.maxAttempts;
      await this.store.update(record.jobId, {
        state: retrying ? "RETRYING" : "FAILED",
        error: message,
        ...(retrying ? {} : { completedAt: Date.now() }),
      });
      throw error;
    }
  }
}

function emptyProgress(): JobProgress {
  return {
    completed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    retrying: 0,
    rate: 0,
    elapsedMs: 0,
  };
}

function operationFor(
  kind: JobKind,
): "massSend" | "join" | "broadcast" | "schedule" | "pairing" {
  if (
    kind === "link-validation" ||
    kind === "link-collection" ||
    kind === "link-export" ||
    kind === "cleanup" ||
    kind === "preview-hydration" ||
    kind === "media-processing" ||
    kind === "group-sync"
  )
    return "massSend";
  if (kind === "allstatus" || kind === "allchat" || kind === "tag")
    return "massSend";
  if (kind === "broadcast") return "broadcast";
  if (kind === "scheduled") return "schedule";
  if (kind === "pairing") return "pairing";
  return "massSend";
}
