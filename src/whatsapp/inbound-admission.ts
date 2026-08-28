export type InboundPriority = 0 | 1 | 2 | 3 | 4 | 5;

export interface InboundAdmissionTask {
  sessionId: string;
  priority: InboundPriority;
  queuedAt?: number;
  run: () => Promise<void>;
  onDrop?: () => void;
}

export interface InboundAdmissionSnapshot {
  concurrency: number;
  perSessionActive: number;
  maxPending: number;
  perSessionMaxPending: number;
  active: number;
  pending: number;
  oldestWaitMs: number;
  dropped: number;
  perSession: Record<string, { active: number; pending: number; oldestWaitMs: number }>;
}

const GLOBAL_CONCURRENCY = Math.max(
  1,
  Math.min(64, Number.parseInt(process.env.INBOUND_WA_CONCURRENCY ?? "24", 10) || 24),
);
const PER_SESSION_ACTIVE = Math.max(
  1,
  Math.min(
    GLOBAL_CONCURRENCY,
    Number.parseInt(process.env.INBOUND_WA_PER_SESSION_ACTIVE ?? "3", 10) || 3,
  ),
);
const MAX_PENDING = Math.max(
  50,
  Number.parseInt(process.env.INBOUND_WA_MAX_PENDING ?? "800", 10) || 800,
);
const PER_SESSION_MAX_PENDING = Math.max(
  10,
  Math.min(
    MAX_PENDING,
    Number.parseInt(process.env.INBOUND_WA_MAX_PENDING_PER_SESSION ?? "150", 10) || 150,
  ),
);
const MAX_SESSIONS_TRACKED = 500;
const SESSION_STALENESS_MS = 10 * 60_000;

interface PendingTask extends InboundAdmissionTask {
  queuedAt: number;
  sequence: number;
}

const pendingBySession = new Map<string, PendingTask[]>();
const activeBySession = new Map<string, number>();
const sessionOrder: string[] = [];
let roundRobinCursor = 0;
let sequence = 0;
let active = 0;
let dropped = 0;
let pumping = false;

function selectNext(): PendingTask | undefined {
  if (!sessionOrder.length) return undefined;
  for (let offset = 0; offset < sessionOrder.length; offset += 1) {
    const index = (roundRobinCursor + offset) % sessionOrder.length;
    const sessionId = sessionOrder[index]!;
    if ((activeBySession.get(sessionId) ?? 0) >= PER_SESSION_ACTIVE) continue;
    const queue = pendingBySession.get(sessionId);
    if (!queue?.length) continue;
    roundRobinCursor = (index + 1) % sessionOrder.length;
    const task = queue.shift();
    if (queue.length === 0) pendingBySession.delete(sessionId);
    return task;
  }
  return undefined;
}

function cleanupSession(sessionId: string): void {
  if ((pendingBySession.get(sessionId)?.length ?? 0) > 0) return;
  if ((activeBySession.get(sessionId) ?? 0) > 0) return;
  activeBySession.delete(sessionId);
  const index = sessionOrder.indexOf(sessionId);
  if (index >= 0) {
    sessionOrder.splice(index, 1);
    roundRobinCursor = sessionOrder.length ? roundRobinCursor % sessionOrder.length : 0;
  }
}

function evictStaleSessions(): void {
  if (sessionOrder.length <= MAX_SESSIONS_TRACKED) return;
  const now = Date.now();
  const staleSessions: string[] = [];
  for (const sessionId of sessionOrder) {
    const queue = pendingBySession.get(sessionId);
    if (!queue || queue.length === 0) {
      const lastActive = activeBySession.get(sessionId) ?? 0;
      if (lastActive === 0) {
        staleSessions.push(sessionId);
      }
    }
  }
  const toRemove = sessionOrder.length - MAX_SESSIONS_TRACKED;
  for (let i = 0; i < Math.min(toRemove, staleSessions.length); i++) {
    const session = staleSessions[i];
    if (session) cleanupSession(session);
  }
}

function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    while (active < GLOBAL_CONCURRENCY) {
      const task = selectNext();
      if (!task) break;
      active += 1;
      activeBySession.set(task.sessionId, (activeBySession.get(task.sessionId) ?? 0) + 1);
      void Promise.resolve()
        .then(task.run)
        .catch(() => undefined)
        .finally(() => {
          active = Math.max(0, active - 1);
          activeBySession.set(
            task.sessionId,
            Math.max(0, (activeBySession.get(task.sessionId) ?? 1) - 1),
          );
          cleanupSession(task.sessionId);
          pump();
        });
    }
  } finally {
    pumping = false;
  }
}

export function enqueueInbound(task: InboundAdmissionTask): boolean {
  const pending = [...pendingBySession.values()].reduce((sum, queue) => sum + queue.length, 0);
  if (pending >= MAX_PENDING) {
    dropped += 1;
    task.onDrop?.();
    return false;
  }
  const queue = pendingBySession.get(task.sessionId) ?? [];
  if (queue.length >= PER_SESSION_MAX_PENDING) {
    dropped += 1;
    task.onDrop?.();
    return false;
  }
  if (!pendingBySession.has(task.sessionId)) {
    pendingBySession.set(task.sessionId, queue);
    sessionOrder.push(task.sessionId);
  }
  evictStaleSessions();
  queue.push({
    ...task,
    queuedAt: task.queuedAt ?? Date.now(),
    sequence: sequence++,
  });
  queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
  pump();
  return true;
}

export function inboundAdmissionSnapshot(now = Date.now()): InboundAdmissionSnapshot {
  const perSession: InboundAdmissionSnapshot["perSession"] = {};
  let pending = 0;
  let oldestWaitMs = 0;
  for (const sessionId of sessionOrder) {
    const queue = pendingBySession.get(sessionId) ?? [];
    const oldestQueuedAt = queue[0]?.queuedAt ?? 0;
    const oldestWaitMsForSession = oldestQueuedAt ? Math.max(0, now - oldestQueuedAt) : 0;
    pending += queue.length;
    oldestWaitMs = Math.max(oldestWaitMs, oldestWaitMsForSession);
    perSession[sessionId] = {
      active: activeBySession.get(sessionId) ?? 0,
      pending: queue.length,
      oldestWaitMs: Math.round(oldestWaitMsForSession),
    };
  }
  return {
    concurrency: GLOBAL_CONCURRENCY,
    perSessionActive: PER_SESSION_ACTIVE,
    maxPending: MAX_PENDING,
    perSessionMaxPending: PER_SESSION_MAX_PENDING,
    active,
    pending,
    oldestWaitMs: Math.round(oldestWaitMs),
    dropped,
    perSession,
  };
}

export const inboundAdmissionConfig = {
  concurrency: GLOBAL_CONCURRENCY,
  perSessionActive: PER_SESSION_ACTIVE,
  maxPending: MAX_PENDING,
  perSessionMaxPending: PER_SESSION_MAX_PENDING,
} as const;

export function resetInboundAdmissionForTests(): void {
  pendingBySession.clear();
  activeBySession.clear();
  sessionOrder.length = 0;
  roundRobinCursor = 0;
  sequence = 0;
  active = 0;
  dropped = 0;
  pumping = false;
}
