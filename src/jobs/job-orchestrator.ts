import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import {
  env,
  excludedSessionIds,
  isWorkerProcess,
  workerSessionIds,
} from "../config/env.js";
import { assertOperationAllowed } from "../core/control-plane.js";
import { getSession } from "../core/session-registry.js";
import { attachRedisErrorHandler } from "../core/redis-events.js";
import type {
  JobKind,
  JobProgress,
  JobRecord,
  WorkerContext,
  WorkerHandler,
} from "./job-contracts.js";
import { JoinResultStore } from "./join-result-store.js";
import { getBroadcastProgress } from "../workload/broadcast-progress.js";

const QUEUE_NAME = "pappy-omega-mini-jobs";
const BROADCAST_QUEUE_NAME = "pappy-omega-mini-broadcasts";
const PANEL_BROADCAST_QUEUE_NAME = "pappy-omega-mini-panel-broadcasts";
const VALIDATOR_QUEUE_NAME = "pappy-omega-mini-validator";
const STORE_PREFIX = "pappy-omega-mini:job:";
const CODE_PREFIX = "pappy-omega-mini:job-code:";
// Deliberately outside the `pappy-omega-mini:job:*` keyspace so SCAN-based
// listAll() never sees it as a record.
const ACTIVE_INDEX_KEY = "pappy-omega-mini:job-active-index";
const TERMINAL_RECORD_TTL_SECONDS = 24 * 60 * 60;
// Records the reaper/recovery never need to revisit.
const SETTLED_STATES = new Set<string>(["COMPLETED", "CANCELLED", "EXPIRED"]);
const TERMINAL_STATES = new Set<string>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);
const STALE_ACTIVE_JOB_GRACE_MS = 60_000;
const WORKER_LOCK_DURATION_MS = 30 * 60_000;
const WORKER_LOCK_RENEW_MS = 10_000;
const WORKER_STALLED_INTERVAL_MS = 120_000;
const PROCESS_WORKER_ID = `${isWorkerProcess ? "worker" : "control"}:${process.pid}`;

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
    const key = `${STORE_PREFIX}${record.jobId}`;
    const serialized = JSON.stringify(record);
    if (TERMINAL_STATES.has(record.state)) {
      // Terminal records are retention-bounded so the job keyspace cannot grow
      // forever; the panel only lists recent activity anyway.
      await this.redis.set(key, serialized, "EX", TERMINAL_RECORD_TTL_SECONDS);
      await this.redis.srem(ACTIVE_INDEX_KEY, record.jobId);
    } else {
      await this.redis.set(key, serialized);
      if (!SETTLED_STATES.has(record.state))
        await this.redis.sadd(ACTIVE_INDEX_KEY, record.jobId);
      else await this.redis.srem(ACTIVE_INDEX_KEY, record.jobId);
    }
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

  /**
   * Records that recovery/reaping may still act on. Backed by a Redis SET of
   * non-settled job ids so the 30-second reaper no longer scans the entire job
   * keyspace. Falls back to one full rebuild when the index is missing.
   */
  async listReapCandidates(): Promise<JobRecord[]> {
    const members = await this.redis.smembers(ACTIVE_INDEX_KEY);
    if (!members.length) {
      const rebuilt = await this.listAll();
      const activeIds = rebuilt
        .filter((record) => !SETTLED_STATES.has(record.state))
        .map((record) => record.jobId);
      for (let index = 0; index < activeIds.length; index += 500)
        await this.redis.sadd(ACTIVE_INDEX_KEY, ...activeIds.slice(index, index + 500));
      return rebuilt.filter((record) => !SETTLED_STATES.has(record.state));
    }
    const records: JobRecord[] = [];
    const staleMembers: string[] = [];
    for (let index = 0; index < members.length; index += 500) {
      const batch = members.slice(index, index + 500);
      const values = await this.redis.mget(
        ...batch.map((jobId) => `${STORE_PREFIX}${jobId}`),
      );
      batch.forEach((jobId, offset) => {
        const value = values[offset];
        if (!value) {
          staleMembers.push(jobId);
          return;
        }
        try {
          const record = JSON.parse(value) as JobRecord;
          if (SETTLED_STATES.has(record.state)) {
            staleMembers.push(jobId);
            return;
          }
          records.push(record);
        } catch {
          staleMembers.push(jobId);
        }
      });
    }
    for (let index = 0; index < staleMembers.length; index += 500)
      await this.redis.srem(ACTIVE_INDEX_KEY, ...staleMembers.slice(index, index + 500));
    return records;
  }

  async list(limit = 100): Promise<JobRecord[]> {
    const records = await this.listAll();
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async delete(jobId: string): Promise<void> {
    await this.redis.del(`${STORE_PREFIX}${jobId}`);
    await this.redis.srem(ACTIVE_INDEX_KEY, jobId);
  }

  async clearError(jobId: string): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current || current.error === undefined) return false;
    const next = { ...current };
    delete next.error;
    await this.set(next);
    return true;
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
  private readonly broadcastQueue: Queue<JobRecord>;
  private readonly panelBroadcastQueue: Queue<JobRecord>;
  private readonly validatorQueue: Queue<JobRecord>;
  private readonly handlers = new Map<JobKind, WorkerHandler>();
  private readonly worker: Worker<JobRecord>;
  private readonly broadcastWorker: Worker<JobRecord>;
  private readonly panelBroadcastWorker: Worker<JobRecord>;
  private readonly validatorWorker: Worker<JobRecord>;
  private readonly joinResults: JoinResultStore;
  private readonly closeHooks: Array<() => Promise<void> | void> = [];
  private readonly completionHooks: Array<(job: JobRecord) => Promise<void> | void> = [];
  private readonly forcedCancellation = new Set<string>();
  private readonly reaperTimer: NodeJS.Timeout;
  private reaperBusy = false;

  constructor(concurrency = env.QUEUE_CONCURRENCY) {
    this.redis = attachRedisErrorHandler(
      new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      }),
      "job-orchestrator",
    );
    this.store = new RedisJobStore(this.redis);
    this.joinResults = new JoinResultStore(this.redis);
    const defaultJobOptions = { removeOnComplete: false, removeOnFail: false };
    this.queue = new Queue<JobRecord>(QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions,
    });
    this.broadcastQueue = new Queue<JobRecord>(BROADCAST_QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions,
    });
    this.panelBroadcastQueue = new Queue<JobRecord>(PANEL_BROADCAST_QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions,
    });
    this.validatorQueue = new Queue<JobRecord>(VALIDATOR_QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions,
    });
    const workerOptions = {
      connection: this.redis,
      lockDuration: WORKER_LOCK_DURATION_MS,
      lockRenewTime: WORKER_LOCK_RENEW_MS,
      stalledInterval: WORKER_STALLED_INTERVAL_MS,
      maxStalledCount: 3,
    } as const;
    this.worker = new Worker<JobRecord>(
      QUEUE_NAME,
      async (job) => this.process(job),
      {
        ...workerOptions,
        concurrency: Math.max(1, Math.min(concurrency, 32)),
      },
    );
    this.broadcastWorker = new Worker<JobRecord>(
      BROADCAST_QUEUE_NAME,
      async (job) => this.process(job),
      {
        ...workerOptions,
        // Broadcast jobs spend nearly all their time in per-group delay
        // timers and network waits, so a high concurrency is cheap. The cap
        // must cover every session broadcasting simultaneously; a low cap
        // makes later sessions queue behind earlier ones.
        concurrency: Math.max(1, Math.min(env.BROADCAST_CONCURRENCY, 64)),
      },
    );
    this.panelBroadcastWorker = new Worker<JobRecord>(
      PANEL_BROADCAST_QUEUE_NAME,
      async (job) => this.process(job),
      {
        ...workerOptions,
        concurrency: Math.max(1, Math.min(env.BROADCAST_CONCURRENCY, 64)),
      },
    );
    this.validatorWorker = new Worker<JobRecord>(
      VALIDATOR_QUEUE_NAME,
      async (job) => this.process(job),
      {
        ...workerOptions,
        concurrency: Math.max(1, Math.min(env.VALIDATOR_CONCURRENCY, 32)),
      },
    );
    const handleFailed = (job: BullJob<JobRecord> | undefined, error: Error): void => {
      if (!job) return;
      void (async () => {
        const retrying = job.attemptsMade + 1 < job.data.maxAttempts;
        await this.store.update(job.data.jobId, {
          state: retrying ? "RETRYING" : "FAILED",
          error: error.message,
          heartbeatAt: Date.now(),
          ...(retrying ? {} : { completedAt: Date.now() }),
        });
        if (!retrying) await this.emitCompletionHooks(job.data.jobId);
      })().catch(() => undefined);
    };
    this.worker.on("failed", handleFailed);
    this.broadcastWorker.on("failed", handleFailed);
    this.panelBroadcastWorker.on("failed", handleFailed);
    this.validatorWorker.on("failed", handleFailed);
    this.reaperTimer = setInterval(() => {
      void this.reapStaleJobs();
    }, 30_000);
    this.reaperTimer.unref?.();
  }

  ownsSession(sessionId?: string): boolean {
    if (isWorkerProcess) return Boolean(sessionId && workerSessionIds.has(sessionId));
    return !sessionId || !excludedSessionIds.has(sessionId);
  }

  private ownsRecord(record: JobRecord): boolean {
    return this.ownsSession(record.sessionId);
  }

  /**
   * True when at least one recovery child (`<jobId>:recovery:*` /
   * `<jobId>:inceptor:*` / `<jobId>:startup:*`) is still live in any queue.
   * Both the reaper and the Inceptor must consult this before re-adding a
   * record — otherwise the two recovery systems race and spawn duplicate
   * children that fight over the same session operation lock and crawl.
   */
  private async hasLiveRecoveryChild(record: JobRecord): Promise<boolean> {
    for (const queue of this.allQueues()) {
      const jobs = await queue.getJobs(["active", "waiting", "delayed"], 0, 500, false);
      for (const job of jobs) {
        if (String(job.id).startsWith(`${record.jobId}:`)) return true;
      }
    }
    return false;
  }

  private queueForKind(kind: JobKind): Queue<JobRecord> {
    if (isBroadcastKind(kind)) return this.broadcastQueue;
    if (kind === "link-validation") return this.validatorQueue;
    return this.queue;
  }

  private queueForRecord(record: Pick<JobRecord, "kind" | "payload">): Queue<JobRecord> {
    if (isBroadcastKind(record.kind) && record.payload.workerLocal === true)
      return this.panelBroadcastQueue;
    return this.queueForKind(record.kind);
  }

  private allQueues(): Queue<JobRecord>[] {
    return [this.queue, this.broadcastQueue, this.panelBroadcastQueue, this.validatorQueue];
  }

  private async findBullJob(record: JobRecord): Promise<BullJob<JobRecord> | undefined> {
    const preferred = this.queueForRecord(record);
    const queues = [preferred, ...this.allQueues().filter((queue) => queue !== preferred)];
    for (const queue of queues) {
      const job = await queue.getJob(record.jobId);
      if (job) return job;
    }
    return undefined;
  }

  async recoverStaleJobsNow(): Promise<void> {
    await this.recoverOutstandingJobs();
    await this.reapStaleJobs();
  }

  private async recoverOutstandingJobs(): Promise<void> {
    const now = Date.now();
    const recoveryJobs = (
      await Promise.all(
        this.allQueues().map((queue) =>
          queue.getJobs(["active", "waiting", "delayed"], 0, 2000, true),
        ),
      )
    ).flat();
    const recoveryParents = new Set(
      recoveryJobs
        .map((job) => String(job.id))
        .filter((jobId) => jobId.includes(":"))
        .map((jobId) => jobId.split(":", 1)[0]),
    );
    for (const record of await this.store.listReapCandidates()) {
      if (!this.ownsRecord(record)) continue;
      if (!["QUEUED", "RUNNING", "RETRYING", "FAILED"].includes(record.state)) continue;
      if (record.cancellationRequested) continue;
      const bullJob = await this.findBullJob(record);
      const heartbeatAge = now - (record.heartbeatAt ?? record.startedAt ?? record.createdAt);
      const bullWaiting = bullJob ? await bullJob.isWaiting() : false;
      const bullActive = bullJob ? await bullJob.isActive() : false;
      const bullDelayed = bullJob ? await bullJob.isDelayed() : false;
      const shouldRecover = shouldRecoverOutstandingJob({
        state: record.state,
        bullExists: Boolean(bullJob),
        bullWaiting,
        bullActive,
        bullDelayed,
        heartbeatAge,
        retryableBroadcastFailure: isRetryableBroadcastFailure(record, heartbeatAge),
      });
      if (!shouldRecover) continue;
      if (recoveryParents.has(record.jobId)) continue;
      if (await this.hasLiveRecoveryChild(record)) continue;
      const claimKey = `pappy-omega-mini:recovery:${record.jobId}`;
      const claimed = await this.redis.set(claimKey, "1", "EX", 120, "NX");
      if (claimed !== "OK") continue;
      await this.store.update(record.jobId, {
        state: "RETRYING",
        error: "Worker restart recovery scheduled.",
        heartbeatAt: now,
      });
      await this.queueForRecord(record).add(
        `${record.kind}:startup-recovery`,
        { ...record, state: "QUEUED", attempts: Math.min(record.maxAttempts, record.attempts + 1) },
        {
          jobId: `${record.jobId}:startup:${now}`,
          attempts: Math.max(1, record.maxAttempts - record.attempts),
          backoff: { type: "exponential", delay: 1000 },
          ...(isImmediatePostingKind(record.kind) ? { priority: 1 } : {}),
        },
      );
      recoveryParents.add(record.jobId);
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
    const immediatePosting = isImmediatePostingKind(input.kind);
    await this.queueForRecord(record).add(input.kind, record, {
      jobId: record.jobId,
      attempts: record.maxAttempts,
      backoff: { type: "exponential", delay: 1000 },
      ...(immediatePosting ? { priority: 1 } : {}),
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
    const record = await this.store.getByCode(workspaceId, code.trim().toUpperCase());
    if (!record) return undefined;
    return (await this.reconcileWorkerLocalBroadcast(record).catch(() => undefined)) ?? record;
  }

  async listRecent(limit = 100): Promise<JobRecord[]> {
    return this.store.list(limit);
  }

  async listAllJobs(): Promise<JobRecord[]> {
    return this.store.listAll();
  }

  async forceRecoverJob(
    jobId: string,
    reason = "Inceptor recovered a stale worker heartbeat.",
  ): Promise<"recovered" | "failed" | "ignored" | "missing"> {
    const record = await this.store.get(jobId);
    if (!record) return "missing";
    if (!this.ownsRecord(record)) return "ignored";
    if (["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"].includes(record.state))
      return "ignored";
    const now = Date.now();
    const heartbeatAge = now - (record.heartbeatAt ?? record.startedAt ?? record.createdAt);
    if (heartbeatAge < STALE_ACTIVE_JOB_GRACE_MS) return "ignored";
    if (await this.hasLiveRecoveryChild(record)) return "ignored";
    const claimKey = `pappy-omega-mini:recovery:${record.jobId}`;
    const claimed = await this.redis.set(claimKey, "1", "EX", 120, "NX");
    if (claimed !== "OK") return "ignored";
    if (record.attempts >= record.maxAttempts) {
      await this.store.update(record.jobId, {
        state: "FAILED",
        error: `${reason} Retry limit exhausted.`,
        heartbeatAt: now,
        completedAt: now,
      });
      await this.emitCompletionHooks(record.jobId);
      return "failed";
    }
    await this.store.update(record.jobId, {
      state: "RETRYING",
      error: reason,
      heartbeatAt: now,
    });
    await this.queueForRecord(record).add(
      `${record.kind}:inceptor-recovery`,
      { ...record, state: "QUEUED", attempts: Math.min(record.maxAttempts, record.attempts + 1) },
      {
        jobId: `${record.jobId}:inceptor:${now}`,
        attempts: Math.max(1, record.maxAttempts - record.attempts),
        backoff: { type: "exponential", delay: 1000 },
        ...(isImmediatePostingKind(record.kind) ? { priority: 1 } : {}),
      },
    );
    return "recovered";
  }

  async flushJob(jobId: string): Promise<boolean> {
    const record = await this.store.get(jobId);
    if (!record) return false;
    this.forcedCancellation.add(jobId);
    if (!["COMPLETED", "FAILED", "CANCELLED", "PARTIAL"].includes(record.state))
      await this.cancel(jobId).catch(() => undefined);
    const bullJob = await this.findBullJob(record);
    if (bullJob && !(await bullJob.isActive()))
      await bullJob.remove().catch(() => undefined);
    await this.redis.del(
      `pappy-omega-mini:idempotency:${record.idempotencyKey}`,
      `${CODE_PREFIX}${record.workspaceId}:${record.jobCode ?? ""}`,
      `pappy-omega-mini:completion-notified:${jobId}`,
      `pappy-omega-mini:broadcast-progress:${record.workspaceId}:${jobId}`,
      `pappy-omega-mini:broadcast-progress:${record.workspaceId}:${jobId}:cancel`,
    );
    if (record.jobCode)
      await this.redis.del(`${CODE_PREFIX}${record.workspaceId}:${record.jobCode}`);
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `pappy-omega-mini:broadcast-done:${jobId}:*`,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length) await this.redis.unlink(...keys).catch(() => undefined);
    } while (cursor !== "0");
    await this.joinResults.purgeJob(jobId);
    await this.store.delete(jobId);
    const timer = setTimeout(() => this.forcedCancellation.delete(jobId), 60_000);
    timer.unref?.();
    return true;
  }

  async pruneTerminalJobs(
    olderThanMs: number,
    limit = 200,
  ): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const records = (await this.store.listAll())
      .filter((record) => this.ownsRecord(record))
      .filter((record) =>
        ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(record.state) &&
        (record.completedAt ?? record.createdAt) < cutoff,
      )
      .sort((left, right) => (left.completedAt ?? left.createdAt) - (right.completedAt ?? right.createdAt))
      .slice(0, limit);
    let removed = 0;
    for (const record of records)
      if (await this.flushJob(record.jobId)) removed += 1;
    return removed;
  }

  async clearAllJobs(): Promise<number> {
    const records = await this.store.listAll();
    for (const record of records) this.forcedCancellation.add(record.jobId);
    await Promise.all(
      records
        .filter((record) => !["COMPLETED", "FAILED", "CANCELLED"].includes(record.state))
        .map((record) => this.cancel(record.jobId).catch(() => undefined)),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await Promise.all(this.allQueues().map((queue) => queue.obliterate({ force: true }).catch(() => undefined)));
    const patterns = [
      `${STORE_PREFIX}*`,
      `${CODE_PREFIX}*`,
      "pappy-omega-mini:idempotency:*",
      "pappy-omega-mini:completion-notified:*",
      "pappy-omega-mini:broadcast-done:*",
      "pappy-omega-mini:broadcast-progress:*",
      "pappy-omega-mini:recovery:*",
    ];
    for (const pattern of patterns) {
      let cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length) await this.redis.unlink(...keys);
      } while (cursor !== "0");
    }
    for (const jobId of records.map((record) => record.jobId)) {
      const timer = setTimeout(() => this.forcedCancellation.delete(jobId), 60_000);
      timer.unref?.();
    }
    return records.length;
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
        `pappy-omega-mini:broadcast-progress:${workspaceId}:${job.jobId}`,
        `pappy-omega-mini:broadcast-progress:${workspaceId}:${job.jobId}:cancel`,
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
    const current = await this.store.get(jobId);
    const record = await this.store.update(jobId, {
      state: "CANCELLING",
      cancellationRequested: true,
      pauseRequested: false,
    });
    const job = current ? await this.queueForRecord(current).getJob(jobId) : undefined;
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

  private async emitCompletionHooks(jobId: string): Promise<void> {
    const claimed = await this.redis.set(
      `pappy-omega-mini:completion-notified:${jobId}`,
      "1",
      "EX",
      60 * 60 * 24 * 30,
      "NX",
    );
    if (claimed !== "OK") return;
    const completedRecord = await this.store.get(jobId);
    if (!completedRecord) return;
    for (const hook of this.completionHooks)
      await Promise.resolve(hook(completedRecord)).catch(() => undefined);
  }

  async close(): Promise<void> {
    clearInterval(this.reaperTimer);
    // Do not wait for long-running handlers during process shutdown. Their durable
    // records remain recoverable by the next process after the lease expires.
    await Promise.all([this.worker.close(true), this.broadcastWorker.close(true), this.panelBroadcastWorker.close(true), this.validatorWorker.close(true)]);
    await Promise.all(this.allQueues().map((queue) => queue.close()));
    for (const hook of this.closeHooks) await hook();
    await this.redis.quit();
  }

  private async process(bullJob: BullJob<JobRecord>): Promise<void> {
    const record = bullJob.data;
    if (!this.ownsRecord(record)) {
      await bullJob.moveToWait(bullJob.token);
      const released = new Error(`Job ${record.jobId} belongs to another worker owner.`);
      released.name = "WaitingError";
      throw released;
    }
    assertOperationAllowed(operationFor(record.kind));
    const handler = this.handlers.get(record.kind);
    if (!handler) throw new Error(`No worker registered for ${record.kind}.`);
    const startedAt = Date.now();
    const leaseToken = `${PROCESS_WORKER_ID}:${record.jobId}:${startedAt}`;
    await this.store.update(record.jobId, {
      state: "RUNNING",
      attempts: Math.max(record.attempts, bullJob.attemptsMade + 1),
      startedAt,
      heartbeatAt: startedAt,
      workerId: PROCESS_WORKER_ID,
      leaseToken,
      leaseExpiresAt: startedAt + WORKER_LOCK_DURATION_MS,
    });
    await this.store.clearError(record.jobId);
    const controller = new AbortController();
    const context: WorkerContext = {
      job: (await this.store.get(record.jobId)) ?? record,
      signal: controller.signal,
      isCancellationRequested: () =>
        this.forcedCancellation.has(record.jobId) ||
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
      report: async (progress, patch) => {
        const current = await this.store.get(record.jobId);
        if (!current) return;
        context.job = current;
        const nextProgress = {
          ...current.progress,
          ...progress,
          elapsedMs: Date.now() - (current.startedAt ?? Date.now()),
        };
        const heartbeatAt = Date.now();
        await this.store.update(record.jobId, {
          progress: nextProgress,
          heartbeatAt,
          leaseExpiresAt: heartbeatAt + WORKER_LOCK_DURATION_MS,
          ...(patch?.payload ? { payload: patch.payload } : {}),
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
      const completedAt = Date.now();
      await this.store.update(record.jobId, {
        state: finalState,
        completedAt,
        heartbeatAt: completedAt,
        leaseExpiresAt: completedAt,
        cancellationRequested: context.isCancellationRequested(),
      });
      if (finalState === "COMPLETED") await this.store.clearError(record.jobId);
      await this.emitCompletionHooks(record.jobId);
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

  private async compactLegacyPanelBroadcast(record: JobRecord): Promise<JobRecord | undefined> {
    if (isWorkerProcess || (record.kind !== "allstatus" && record.kind !== "allchat") || !record.sessionId || record.payload.workerLocal === true || ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(record.state))
      return undefined;
    let panelAssigned = false;
    try {
      panelAssigned = Boolean(getSession(record.workspaceId, record.sessionId).workloadWorkerId);
    } catch {
      return undefined;
    }
    if (!panelAssigned) return undefined;
    const { groups: _groups, ...compactPayload } = record.payload;
    const updated = await this.store.update(record.jobId, {
      payload: { ...compactPayload, workerLocal: true },
      error: "Legacy panel broadcast migrated to worker-local execution.",
    });
    return updated;
  }

  private async reconcileWorkerLocalBroadcast(record: JobRecord): Promise<JobRecord | undefined> {
    if ((record.kind !== "allstatus" && record.kind !== "allchat") || record.payload.workerLocal !== true || !record.sessionId)
      return undefined;
    const progress = await getBroadcastProgress(record.workspaceId, record.jobId);
    if (!progress) return undefined;
    const repeat = Math.max(1, Math.min(20, Number(record.payload.count ?? 1)));
    const nextProgress: JobProgress = {
      ...record.progress,
      total: progress.totalGroups * repeat,
      completed: progress.completed,
      success: progress.completed,
      failed: progress.failed,
      skipped: progress.skipped,
      elapsedMs: Math.max(0, Date.now() - (record.startedAt ?? record.createdAt)),
      currentAction: progress.currentAction ?? (progress.state === "WAITING_FOR_SESSION" ? "waiting for WhatsApp reconnect" : progress.state.toLowerCase()),
      ...(progress.currentGroup ? { currentGroup: progress.currentGroup } : {}),
      ...(progress.nextActionAt ? { nextActionAt: progress.nextActionAt } : {}),
      lastResult: progress.lastResult ?? progress.error ?? `Worker-local ${record.kind} progress: ${progress.completed}/${progress.totalGroups * repeat}.`,
    };
    const terminal = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(progress.state);
    const nextState: JobRecord["state"] = terminal
      ? progress.state
      : "RUNNING";
    const updated = await this.store.update(record.jobId, {
      state: nextState,
      progress: nextProgress,
      heartbeatAt: progress.updatedAt,
      ...(terminal ? { completedAt: progress.updatedAt } : {}),
      ...(progress.error ? { error: progress.error } : {}),
    });
    if (terminal && !["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(record.state))
      await this.emitCompletionHooks(record.jobId);
    return updated;
  }

  private async pruneTerminalRecoveryChildren(): Promise<void> {
    const now = Date.now();
    for (const queue of this.allQueues()) {
      const jobs = await queue.getJobs(["active", "waiting", "delayed"], 0, 2000, true);
      for (const job of jobs) {
        const childId = String(job.id);
        const hasParentSuffix = childId.includes(":");
        const parentId = hasParentSuffix ? (childId.split(":", 1)[0] ?? "") : childId;
        if (!parentId) continue;
        const parent = await this.store.get(parentId);
        if (!parent || !["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(parent.state)) continue;
        if (!parent.completedAt || now - parent.completedAt < 60_000) continue;
        try {
          if (await job.isActive()) await this.redis.del(queue.toKey(`${childId}:lock`));
          await queue.remove(childId, { removeChildren: false });
        } catch {
          // A child may finish naturally between the state check and cleanup.
        }
      }
    }
  }

  private async reapStaleJobs(): Promise<void> {
    if (this.reaperBusy) return;
    this.reaperBusy = true;
    try {
      const cutoff = Date.now() - 2 * 60_000;
      const recoveryJobs = (
        await Promise.all(
          this.allQueues().map((queue) =>
            queue.getJobs(["active", "waiting", "delayed"], 0, 2000, true),
          ),
        )
      ).flat();
      await this.pruneTerminalRecoveryChildren();
      const recoveryParents = new Set(
        recoveryJobs
          .map((job) => String(job.id))
          .filter((jobId) => jobId.includes(":"))
          .map((jobId) => jobId.split(":", 1)[0]),
      );
      for (const originalRecord of await this.store.listReapCandidates()) {
        if (!this.ownsRecord(originalRecord)) continue;
        const record = await this.compactLegacyPanelBroadcast(originalRecord).catch(() => undefined) ?? originalRecord;
        const reconciled = await this.reconcileWorkerLocalBroadcast(record).catch(() => undefined);
        if (reconciled?.state === "COMPLETED" || reconciled?.state === "PARTIAL" || reconciled?.state === "FAILED" || reconciled?.state === "CANCELLED") continue;
        const heartbeatAge =
          Date.now() - (record.heartbeatAt ?? record.startedAt ?? record.createdAt);
        const retryableFailed = isRetryableBroadcastFailure(record, heartbeatAge);
        if (!["RUNNING", "RETRYING"].includes(record.state) && !retryableFailed)
          continue;
        if (recoveryParents.has(record.jobId)) continue;
        if (await this.hasLiveRecoveryChild(record)) continue;
        if (!retryableFailed &&
          (record.heartbeatAt ?? record.startedAt ?? record.createdAt) > cutoff
        )
          continue;
        const bullJob = await this.findBullJob(record);
        const staleActive =
          record.state === "RUNNING" && heartbeatAge > STALE_ACTIVE_JOB_GRACE_MS;
        if (bullJob && (await bullJob.isActive()) && !staleActive) continue;
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
          await this.queueForRecord(record).add(
            `${record.kind}:recovery`,
            { ...record, state: "QUEUED", attempts: Math.min(record.maxAttempts, record.attempts + 1) },
            {
              jobId: `${record.jobId}:recovery:${Date.now()}`,
              attempts: Math.max(1, record.maxAttempts - record.attempts),
              backoff: { type: "exponential", delay: 1000 },
              ...(isImmediatePostingKind(record.kind) ? { priority: 1 } : {}),
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

export interface OutstandingJobRecoveryInput {
  state: JobRecord["state"];
  bullExists: boolean;
  bullWaiting: boolean;
  bullActive: boolean;
  bullDelayed: boolean;
  heartbeatAge: number;
  retryableBroadcastFailure: boolean;
}

export function shouldRecoverOutstandingJob(input: OutstandingJobRecoveryInput): boolean {
  if (!input.bullExists) return true;
  const staleRunning =
    input.state === "RUNNING" &&
    !input.bullWaiting &&
    !input.bullDelayed &&
    (!input.bullActive || input.heartbeatAge > STALE_ACTIVE_JOB_GRACE_MS) &&
    input.heartbeatAge > 10_000;
  if (staleRunning) return true;
  if (input.state === "RETRYING" && !input.bullWaiting && !input.bullActive && !input.bullDelayed) return true;
  return input.retryableBroadcastFailure;
}

function isBroadcastKind(kind: JobKind): boolean {
  return kind === "allstatus" || kind === "allchat";
}

function isImmediatePostingKind(kind: JobKind): boolean {
  return isBroadcastKind(kind) || kind === "gstatus" || kind === "tag";
}

function isRetryableBroadcastFailure(
  record: JobRecord,
  heartbeatAge: number,
): boolean {
  if (record.state !== "FAILED") return false;
  if (record.kind !== "allstatus" && record.kind !== "allchat") return false;
  if (record.attempts >= record.maxAttempts) return false;
  if (heartbeatAge > 24 * 60 * 60_000) return false;
  const error = (record.error ?? "").toLowerCase();
  return /not connected|connection|closed|timeout|tempor|network|inventory|rate|429/.test(error);
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
    kind === "play-download" ||
    kind === "group-sync" ||
    kind === "group-control"
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
