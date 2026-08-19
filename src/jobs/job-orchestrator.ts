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
import { JoinResultStore } from "./join-result-store.js";

const QUEUE_NAME = "pappy-omega-mini-jobs";
const STORE_PREFIX = "pappy-omega-mini:job:";
const CODE_PREFIX = "pappy-omega-mini:job-code:";

export class RedisJobStore {
  constructor(private readonly redis: Redis) {}

  async get(jobId: string): Promise<JobRecord | undefined> {
    const value = await this.redis.get(`${STORE_PREFIX}${jobId}`);
    return value ? (JSON.parse(value) as JobRecord) : undefined;
  }

  async getByCode(
    workspaceId: string,
    code: string,
  ): Promise<JobRecord | undefined> {
    const jobId = await this.redis.get(
      `${CODE_PREFIX}${workspaceId}:${code.toUpperCase()}`,
    );
    return jobId ? this.get(jobId) : undefined;
  }

  async set(record: JobRecord): Promise<void> {
    await this.redis.set(
      `${STORE_PREFIX}${record.jobId}`,
      JSON.stringify(record),
    );
  }

  async listAll(): Promise<JobRecord[]> {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const result = await this.redis.scan(
        cursor,
        "MATCH",
        `${STORE_PREFIX}*`,
        "COUNT",
        250,
      );
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== "0");
    return (
      await Promise.all(
        keys.map((key) =>
          this.redis
            .get(key)
            .then((value) =>
              value ? (JSON.parse(value) as JobRecord) : undefined,
            ),
        ),
      )
    ).filter((record): record is JobRecord => Boolean(record));
  }

  async list(limit = 100): Promise<JobRecord[]> {
    const records = await this.listAll();
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async delete(jobId: string): Promise<void> {
    await this.redis.del(`${STORE_PREFIX}${jobId}`);
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
  private readonly joinResults: JoinResultStore;
  private readonly closeHooks: Array<() => Promise<void> | void> = [];
  private readonly completionHooks: Array<(job: JobRecord) => Promise<void> | void> = [];
  private readonly reaperTimer: NodeJS.Timeout;
  private reaperBusy = false;

  constructor(concurrency = env.QUEUE_CONCURRENCY) {
    this.redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.store = new RedisJobStore(this.redis);
    this.joinResults = new JoinResultStore(this.redis);
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
      },
    );
    this.worker.on("failed", (job, error) => {
      if (job)
        void this.store.update(job.data.jobId, {
          state: "FAILED",
          error: error.message,
          heartbeatAt: Date.now(),
          completedAt: Date.now(),
        });
    });
    this.reaperTimer = setInterval(() => {
      void this.reapStaleJobs();
    }, 30_000);
    this.reaperTimer.unref?.();
  }

  async recoverStaleJobsNow(): Promise<void> {
    await this.recoverOutstandingJobs();
    await this.reapStaleJobs();
  }

  private async recoverOutstandingJobs(): Promise<void> {
    const now = Date.now();
    for (const record of await this.store.listAll()) {
      if (!["QUEUED", "RUNNING", "RETRYING"].includes(record.state)) continue;
      if (record.cancellationRequested) continue;
      const bullJob = await this.queue.getJob(record.jobId);
      const heartbeatAge = now - (record.heartbeatAt ?? record.startedAt ?? record.createdAt);
      const bullWaiting = bullJob ? await bullJob.isWaiting() : false;
      const bullActive = bullJob ? await bullJob.isActive() : false;
      const bullDelayed = bullJob ? await bullJob.isDelayed() : false;
      const shouldRecover =
        !bullJob ||
        (record.state === "RUNNING" && !bullWaiting && !bullActive && !bullDelayed && heartbeatAge > 10_000) ||
        (record.state === "RETRYING" && !bullWaiting && !bullActive && !bullDelayed);
      if (!shouldRecover) continue;
      const claimKey = `pappy-omega-mini:recovery:${record.jobId}:${record.heartbeatAt ?? record.createdAt}`;
      const claimed = await this.redis.set(claimKey, "1", "EX", 120, "NX");
      if (claimed !== "OK") continue;
      await this.store.update(record.jobId, {
        state: "RETRYING",
        error: "Worker restart recovery scheduled.",
        heartbeatAt: now,
      });
      await this.queue.add(
        `${record.kind}:startup-recovery`,
        { ...record, state: "QUEUED" },
        {
          jobId: `${record.jobId}:startup:${now}`,
          attempts: Math.max(1, record.maxAttempts - record.attempts),
          backoff: { type: "exponential", delay: 1000 },
        },
      );
    }
  }

  register(kind: JobKind, handler: WorkerHandler): void {
    this.handlers.set(kind, handler);
  }

  addCloseHook(hook: () => Promise<void> | void): void {
    this.closeHooks.push(hook);
  }

  addCompletionHook(hook: (job: JobRecord) => Promise<void> | void): void {
    this.completionHooks.push(hook);
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
      jobCode: await this.reserveJobCode(input.workspaceId),
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
    if (record.jobCode)
      await this.redis.set(
        `${CODE_PREFIX}${input.workspaceId}:${record.jobCode}`,
        record.jobId,
        "EX",
        60 * 60 * 24 * 30,
      );
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

  async waitForStarted(
    jobId: string,
    timeoutMs = 3000,
  ): Promise<JobRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    let current = await this.get(jobId);
    while (current && current.state === "QUEUED" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = await this.get(jobId);
    }
    return current;
  }

  async getByCode(
    workspaceId: string,
    code: string,
  ): Promise<JobRecord | undefined> {
    return this.store.getByCode(workspaceId, code.trim().toUpperCase());
  }

  async listRecent(limit = 100): Promise<JobRecord[]> {
    return this.store.list(limit);
  }

  async purgeSession(workspaceId: string, sessionId: string): Promise<number> {
    const jobs = await this.store.listAll();
    let removed = 0;
    for (const job of jobs) {
      if (job.workspaceId !== workspaceId || job.sessionId !== sessionId)
        continue;
      if (!["COMPLETED", "FAILED", "CANCELLED"].includes(job.state))
        await this.cancel(job.jobId).catch(() => undefined);
      await this.redis.del(
        `pappy-omega-mini:idempotency:${job.idempotencyKey}`,
      );
      if (job.jobCode)
        await this.redis.del(`${CODE_PREFIX}${workspaceId}:${job.jobCode}`);
      await this.joinResults.purgeJob(job.jobId);
      await this.store.delete(job.jobId);
      removed += 1;
    }
    return removed;
  }

  async cancel(jobId: string): Promise<JobRecord | undefined> {
    const record = await this.store.update(jobId, {
      state: "CANCELLING",
      cancellationRequested: true,
      pauseRequested: false,
    });
    const job = await this.queue.getJob(jobId);
    if (job && !(await job.isActive()))
      await job.remove().catch(() => undefined);
    return record;
  }

  async pause(jobId: string): Promise<JobRecord | undefined> {
    return this.store.update(jobId, { state: "PAUSED", pauseRequested: true });
  }

  async resume(jobId: string): Promise<JobRecord | undefined> {
    return this.store.update(jobId, {
      state: "RUNNING",
      pauseRequested: false,
    });
  }

  private async reserveJobCode(workspaceId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
      const claimed = await this.redis.set(
        `${CODE_PREFIX}${workspaceId}:${code}`,
        "pending",
        "EX",
        60 * 60 * 24 * 30,
        "NX",
      );
      if (claimed) return code;
    }
    throw new Error("Unable to allocate a unique live job code.");
  }

  async close(): Promise<void> {
    clearInterval(this.reaperTimer);
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
      heartbeatAt: Date.now(),
    });
    const controller = new AbortController();
    const context: WorkerContext = {
      job: (await this.store.get(record.jobId)) ?? record,
      signal: controller.signal,
      isCancellationRequested: () =>
        Boolean((context.job as JobRecord).cancellationRequested),
      waitIfPaused: async () => {
        while (true) {
          const current = await this.store.get(record.jobId);
          if (!current?.pauseRequested || current.cancellationRequested) {
            context.job = current ?? context.job;
            return;
          }
          await this.store.update(record.jobId, { heartbeatAt: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      },
      report: async (progress) => {
        const current = await this.store.get(record.jobId);
        if (!current) return;
        context.job = current;
        const nextProgress = {
          ...current.progress,
          ...progress,
          elapsedMs: Date.now() - (current.startedAt ?? Date.now()),
        };
        await this.store.update(record.jobId, {
          progress: nextProgress,
          heartbeatAt: Date.now(),
        });
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
        heartbeatAt: Date.now(),
        cancellationRequested: context.isCancellationRequested(),
      });
      const completedRecord = await this.store.get(record.jobId);
      if (completedRecord) {
        for (const hook of this.completionHooks)
          await Promise.resolve(hook(completedRecord)).catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retrying = bullJob.attemptsMade + 1 < record.maxAttempts;
      await this.store.update(record.jobId, {
        state: retrying ? "RETRYING" : "FAILED",
        error: message,
        heartbeatAt: Date.now(),
        ...(retrying ? {} : { completedAt: Date.now() }),
      });
      throw error;
    }
  }

  private async reapStaleJobs(): Promise<void> {
    if (this.reaperBusy) return;
    this.reaperBusy = true;
    try {
      const cutoff = Date.now() - 2 * 60_000;
      for (const record of await this.store.listAll()) {
        if (!["RUNNING", "RETRYING"].includes(record.state)) continue;
        if (
          (record.heartbeatAt ?? record.startedAt ?? record.createdAt) > cutoff
        )
          continue;
        const bullJob = await this.queue.getJob(record.jobId);
        if (bullJob && (await bullJob.isActive())) continue;
        if (record.cancellationRequested) {
          await this.store.update(record.jobId, {
            state: "CANCELLED",
            heartbeatAt: Date.now(),
            completedAt: Date.now(),
          });
          continue;
        }
        if (record.attempts < record.maxAttempts) {
          await this.store.update(record.jobId, {
            state: "RETRYING",
            error: "Worker heartbeat expired; job recovery scheduled.",
            heartbeatAt: Date.now(),
          });
          await this.queue.add(
            `${record.kind}:recovery`,
            { ...record, state: "QUEUED" },
            {
              jobId: `${record.jobId}:recovery:${Date.now()}`,
              attempts: Math.max(1, record.maxAttempts - record.attempts),
              backoff: { type: "exponential", delay: 1000 },
            },
          );
        } else {
          await this.store.update(record.jobId, {
            state: "FAILED",
            error: "Worker heartbeat expired after the configured retry limit.",
            heartbeatAt: Date.now(),
            completedAt: Date.now(),
          });
        }
      }
    } catch {
      // A reaper error must never interfere with active workers.
    } finally {
      this.reaperBusy = false;
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
  if (
    kind === "gstatus" ||
    kind === "allstatus" ||
    kind === "allchat" ||
    kind === "tag"
  )
    return "massSend";
  if (kind === "broadcast") return "broadcast";
  if (kind === "scheduled") return "schedule";
  if (kind === "pairing") return "pairing";
  return "massSend";
}
