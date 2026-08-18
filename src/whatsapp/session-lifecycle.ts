import { updateSession } from "../core/session-registry.js";

export interface SessionLifecycleState {
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  stopping: boolean;
}

const states = new Map<string, SessionLifecycleState>();
const starts = new Map<string, Promise<void>>();

export function lifecycleKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function getLifecycleState(key: string): SessionLifecycleState {
  const existing = states.get(key);
  if (existing) return existing;
  const created: SessionLifecycleState = {
    reconnectAttempt: 0,
    reconnectTimer: undefined,
    heartbeatTimer: undefined,
    stopping: false,
  };
  states.set(key, created);
  return created;
}

export function getStart(key: string): Promise<void> | undefined {
  return starts.get(key);
}

export function setStart(key: string, promise: Promise<void>): void {
  starts.set(key, promise);
  void promise.finally(() => {
    if (starts.get(key) === promise) starts.delete(key);
  });
}

export function markOpening(key: string): void {
  getLifecycleState(key).stopping = false;
}

export function markConnected(key: string): void {
  const state = getLifecycleState(key);
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
}

export function markStopping(key: string): void {
  const state = getLifecycleState(key);
  state.stopping = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.reconnectTimer = undefined;
  state.heartbeatTimer = undefined;
}

export function markClosed(key: string): void {
  const state = getLifecycleState(key);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = undefined;
}

export function scheduleReconnect(input: {
  key: string;
  workspaceId: string;
  sessionId: string;
  run: () => void;
  maxAttempts?: number;
}): void {
  const state = getLifecycleState(input.key);
  if (state.stopping || state.reconnectTimer) return;
  const maxAttempts = input.maxAttempts ?? 8;
  if (state.reconnectAttempt >= maxAttempts) {
    updateSession(input.workspaceId, input.sessionId, {
      status: "ERROR",
      disconnectReason: "reconnect attempts exhausted",
    });
    return;
  }
  state.reconnectAttempt += 1;
  const base = Math.min(60_000, 1_000 * 2 ** (state.reconnectAttempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(250, base * 0.2));
  const delay = base + jitter;
  updateSession(input.workspaceId, input.sessionId, {
    status: "RECONNECTING",
    disconnectReason: `reconnect scheduled in ${delay}ms`,
  });
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined;
    input.run();
  }, delay);
}

export function startHeartbeat(input: {
  key: string;
  workspaceId: string;
  sessionId: string;
  intervalMs?: number;
}): void {
  const state = getLifecycleState(input.key);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (!state.stopping)
      updateSession(input.workspaceId, input.sessionId, {
        lastHealthyAt: Date.now(),
      });
  }, input.intervalMs ?? 30_000);
}

export function clearLifecycle(key: string): void {
  markStopping(key);
  states.delete(key);
  starts.delete(key);
}

export function stopAllLifecycles(): void {
  for (const key of states.keys()) markStopping(key);
}
