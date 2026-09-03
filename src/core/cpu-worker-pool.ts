import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { env } from "../config/env.js";

const workerDirectory = dirname(fileURLToPath(import.meta.url));

interface CpuTask {
  id: number;
  type: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
}
interface CpuWorker {
  worker: Worker;
  current?: CpuTask | undefined;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  stopping: boolean;
}
export interface CpuWorkerPoolStats {
  maxWorkers: number;
  liveWorkers: number;
  busyWorkers: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  timedOutTasks: number;
}

function defaultWorkerCount(): number {
  // Operator override for Pterodactyl / single-core / cgroup-limited hosts.
  if (env.CPU_WORKER_COUNT !== undefined) return env.CPU_WORKER_COUNT;
  // The main thread plus these workers can occupy every CPU in the process cpuset.
  return Math.max(1, availableParallelism() - 1);
}

/** Lazy, bounded workers for pure CPU work; no socket/runtime state enters here. */
export class CpuWorkerPool {
  private readonly workers: CpuWorker[] = [];
  private readonly queue: CpuTask[] = [];
  private readonly workerScript: string;
  private nextTaskId = 1;
  private closing = false;
  private completedTasks = 0;
  private failedTasks = 0;
  private timedOutTasks = 0;

  constructor(
    workerScript: string,
    readonly maxWorkers = defaultWorkerCount(),
    private readonly maxQueue = 64,
    private readonly taskTimeoutMs = 60_000,
    private readonly idleTimeoutMs = 45_000,
  ) {
    this.workerScript = resolve(workerDirectory, workerScript);
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
      throw new Error("CPU worker count must be positive.");
  }

  run<TInput, TOutput>(type: string, payload: TInput): Promise<TOutput> {
    if (this.closing) return Promise.reject(new Error("CPU worker pool is shutting down."));
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new Error("CPU worker queue is full; refusing unbounded work."));
    return new Promise<TOutput>((resolvePromise, reject) => {
      const task = {
        id: this.nextTaskId++, type, payload,
        resolve: resolvePromise as (value: unknown) => void,
        reject, settled: false,
      } as CpuTask;
      task.timeout = setTimeout(() => this.timeoutTask(task), this.taskTimeoutMs);
      task.timeout.unref?.();
      this.queue.push(task);
      this.pump();
    });
  }

  private spawn(): CpuWorker {
    const worker = new Worker(this.workerScript, { execArgv: [] });
    const entry: CpuWorker = { worker, stopping: false };
    worker.on("message", (message: unknown) => this.handleMessage(entry, message));
    worker.on("error", (error) => this.retire(entry, error));
    worker.on("exit", (code) => {
      if (!entry.stopping)
        this.retire(entry, new Error(`CPU worker exited unexpectedly with code ${code}.`), false);
    });
    this.workers.push(entry);
    return entry;
  }

  private pump(): void {
    if (this.closing) return;
    const demand = this.queue.length + this.workers.filter((entry) => entry.current).length;
    while (this.workers.length < Math.min(this.maxWorkers, demand)) this.spawn();
    for (const entry of this.workers) {
      if (!this.queue.length) break;
      if (entry.stopping || entry.current) continue;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      const task = this.queue.shift();
      if (!task) break;
      entry.current = task;
      try {
        entry.worker.postMessage({ id: task.id, type: task.type, payload: task.payload });
      } catch (error) {
        this.retire(entry, error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const entry of this.workers)
      if (!entry.current && !entry.stopping && !entry.idleTimer)
        this.scheduleIdleRetirement(entry);
  }

  private handleMessage(entry: CpuWorker, message: unknown): void {
    const response = message as { id?: number; result?: unknown; error?: string };
    const task = entry.current;
    if (!task || response.id !== task.id) return;
    entry.current = undefined;
    if (response.error) {
      this.failedTasks += 1;
      this.settle(task, new Error(response.error));
    } else {
      this.completedTasks += 1;
      this.settle(task, undefined, response.result);
    }
    this.pump();
  }

  private timeoutTask(task: CpuTask): void {
    if (task.settled) return;
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const owner = this.workers.find((entry) => entry.current === task);
    this.timedOutTasks += 1;
    this.failedTasks += 1;
    this.settle(task, new Error(`CPU task ${task.type} exceeded ${this.taskTimeoutMs}ms.`));
    if (owner) {
      owner.current = undefined;
      this.retire(owner);
    } else this.pump();
  }

  private settle(task: CpuTask, error?: Error, result?: unknown): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timeout);
    if (error) task.reject(error);
    else task.resolve(result);
  }

  private scheduleIdleRetirement(entry: CpuWorker): void {
    entry.idleTimer = setTimeout(() => this.retire(entry), this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private retire(entry: CpuWorker, error?: Error, terminate = true): void {
    if (entry.stopping) return;
    entry.stopping = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const index = this.workers.indexOf(entry);
    if (index >= 0) this.workers.splice(index, 1);
    if (entry.current) {
      this.failedTasks += 1;
      this.settle(entry.current, error ?? new Error("CPU worker stopped before completing its task."));
      entry.current = undefined;
    }
    if (terminate) void entry.worker.terminate().catch(() => undefined);
    this.pump();
  }

  get stats(): CpuWorkerPoolStats {
    return {
      maxWorkers: this.maxWorkers,
      liveWorkers: this.workers.length,
      busyWorkers: this.workers.filter((entry) => entry.current).length,
      queuedTasks: this.queue.length,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      timedOutTasks: this.timedOutTasks,
    };
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const error = new Error("CPU worker pool shut down before task completion.");
    for (const task of this.queue.splice(0)) this.settle(task, error);
    const workers = this.workers.splice(0);
    await Promise.all(workers.map(async (entry) => {
      entry.stopping = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.current) this.settle(entry.current, error);
      await entry.worker.terminate().catch(() => undefined);
    }));
  }
}

let sharedPool: CpuWorkerPool | undefined;
export function getCpuWorkerPool(): CpuWorkerPool {
  sharedPool ??= new CpuWorkerPool("./workers/cpu-worker.js");
  return sharedPool;
}
export function getCpuWorkerPoolStats(): CpuWorkerPoolStats {
  return sharedPool?.stats ?? {
    maxWorkers: defaultWorkerCount(), liveWorkers: 0, busyWorkers: 0,
    queuedTasks: 0, completedTasks: 0, failedTasks: 0, timedOutTasks: 0,
  };
}
export async function shutdownCpuWorkerPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  await pool?.shutdown();
}

