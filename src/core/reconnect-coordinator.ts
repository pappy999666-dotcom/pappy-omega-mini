import { env } from "../config/env.js";

interface ReconnectTask {
  key: string;
  run: () => void;
  priority: number;
  enqueuedAt: number;
}

let reconnectQueue: ReconnectTask[] = [];
let activeReconnects = 0;
let processing = false;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
const STALE_TASK_MS = 5 * 60_000;

function scheduleCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined;
    const now = Date.now();
    reconnectQueue = reconnectQueue.filter((task) => now - task.enqueuedAt < STALE_TASK_MS);
    if (reconnectQueue.length) scheduleCleanup();
  }, 30_000);
  cleanupTimer.unref?.();
}

export function enqueueSessionReconnect(input: {
  key: string;
  run: () => void;
  priority?: number;
}): void {
  const existing = reconnectQueue.find((task) => task.key === input.key);
  if (existing) {
    existing.priority = input.priority ?? existing.priority;
    return;
  }
  reconnectQueue.push({
    key: input.key,
    run: input.run,
    priority: input.priority ?? 5,
    enqueuedAt: Date.now(),
  });
  reconnectQueue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
  scheduleCleanup();
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (reconnectQueue.length > 0 && activeReconnects < env.MAX_CONCURRENT_RECONNECTS) {
      const task = reconnectQueue.shift();
      if (!task) break;
      activeReconnects++;
      try {
        const result = task.run() as unknown;
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          // Reconnect tasks are async; the slot must stay occupied until the
          // attempt settles, otherwise MAX_CONCURRENT_RECONNECTS is not real.
          void Promise.resolve(result)
            .catch(() => undefined)
            .finally(() => {
              activeReconnects = Math.max(0, activeReconnects - 1);
              void processQueue();
            });
          continue;
        }
        activeReconnects--;
      } catch {
        activeReconnects = Math.max(0, activeReconnects - 1);
      }
    }
  } finally {
    processing = false;
  }
}

export function removeSessionReconnect(key: string): void {
  const index = reconnectQueue.findIndex((task) => task.key === key);
  if (index >= 0) reconnectQueue.splice(index, 1);
}

export function getReconnectQueueStats(): {
  queued: number;
  active: number;
  maxConcurrent: number;
} {
  return {
    queued: reconnectQueue.length,
    active: activeReconnects,
    maxConcurrent: env.MAX_CONCURRENT_RECONNECTS,
  };
}

export function resetReconnectCoordinator(): void {
  reconnectQueue = [];
  activeReconnects = 0;
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }
}
