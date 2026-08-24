export type OutboundPriority = 0 | 1 | 2 | 3 | 4;

export interface OutboundAdmissionTask {
  sessionId: string;
  priority: OutboundPriority;
  run: () => Promise<void>;
}

export interface OutboundAdmissionSnapshot {
  concurrency: number;
  perSessionActive: number;
  maxPending: number;
  active: number;
  pending: number;
  oldestWaitMs: number;
  perSession: Record<string, { active: number; pending: number; oldestWaitMs: number }>;
}

const GLOBAL_CONCURRENCY = Math.max(
  1,
  Math.min(64, Number.parseInt(process.env.OUTBOUND_WA_CONCURRENCY ?? "24", 10) || 24),
);
const MAX_PENDING = Math.max(
  50,
  Number.parseInt(process.env.OUTBOUND_WA_MAX_PENDING ?? "1000", 10) || 1000,
);

interface PendingTask extends OutboundAdmissionTask {
  queuedAt: number;
  sequence: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pendingBySession = new Map<string, PendingTask[]>();
const activeBySession = new Map<string, number>();
const sessionOrder: string[] = [];
let cursor = 0;
let sequence = 0;
let active = 0;
let pumping = false;

function selectNext(): PendingTask | undefined {
  if (!sessionOrder.length) return undefined;
  for (let offset = 0; offset < sessionOrder.length; offset += 1) {
    const index = (cursor + offset) % sessionOrder.length;
    const sessionId = sessionOrder[index]!;
    if ((activeBySession.get(sessionId) ?? 0) > 0) continue;
    const queue = pendingBySession.get(sessionId);
    if (!queue?.length) continue;
    cursor = (index + 1) % sessionOrder.length;
    const task = queue.shift();
    if (!queue.length) pendingBySession.delete(sessionId);
    return task;
  }
  return undefined;
}

function cleanup(sessionId: string): void {
  if ((pendingBySession.get(sessionId)?.length ?? 0) > 0) return;
  if ((activeBySession.get(sessionId) ?? 0) > 0) return;
  activeBySession.delete(sessionId);
  const index = sessionOrder.indexOf(sessionId);
  if (index >= 0) {
    sessionOrder.splice(index, 1);
    cursor = sessionOrder.length ? cursor % sessionOrder.length : 0;
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
      activeBySession.set(task.sessionId, 1);
      const finish = () => {
        active = Math.max(0, active - 1);
        activeBySession.delete(task.sessionId);
        cleanup(task.sessionId);
      };
      void task.run()
        .then(() => {
          finish();
          pump();
          task.resolve();
        }, (error) => {
          finish();
          pump();
          task.reject(error);
        });
    }
  } finally {
    pumping = false;
  }
}

export function enqueueOutbound(task: OutboundAdmissionTask): Promise<void> {
  const pending = [...pendingBySession.values()].reduce((sum, queue) => sum + queue.length, 0);
  if (pending >= MAX_PENDING) return Promise.reject(new Error("Outbound admission queue is full."));
  const queue = pendingBySession.get(task.sessionId) ?? [];
  if (!pendingBySession.has(task.sessionId)) {
    pendingBySession.set(task.sessionId, queue);
    if (!sessionOrder.includes(task.sessionId)) sessionOrder.push(task.sessionId);
  }
  return new Promise<void>((resolve, reject) => {
    queue.push({ ...task, queuedAt: Date.now(), sequence: sequence++, resolve, reject });
    queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    pump();
  });
}

export function outboundAdmissionSnapshot(now = Date.now()): OutboundAdmissionSnapshot {
  const perSession: OutboundAdmissionSnapshot["perSession"] = {};
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
    perSessionActive: 1,
    maxPending: MAX_PENDING,
    active,
    pending,
    oldestWaitMs: Math.round(oldestWaitMs),
    perSession,
  };
}

export function resetOutboundAdmissionForTests(): void {
  pendingBySession.clear();
  activeBySession.clear();
  sessionOrder.length = 0;
  cursor = 0;
  sequence = 0;
  active = 0;
  pumping = false;
}
