import { updateSession } from "../core/session-registry.js";

export type AuthoritativeLifecycleState =
  | "CREATING"
  | "PAIRING"
  | "PAIRING_CODE_READY"
  | "AUTHENTICATED"
  | "CONNECTING"
  | "ONLINE"
  | "RECONNECTING"
  | "DEGRADED"
  | "LOGGED_OUT"
  | "BANNED_OR_RESTRICTED"
  | "FAILED"
  | "PURGED";

export interface SessionLifecycleState {
  reconnectAttempt: number;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  stopping: boolean;
  socketGeneration: number;
  status: AuthoritativeLifecycleState;
  lastTransitionAt: number;
  lastMessageReceivedAt?: number;
  lastCommandProcessedAt?: number;
  lastOutboundMessageAt?: number;
  lastError?: string;
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
    connected: false,
    reconnectTimer: undefined,
    heartbeatTimer: undefined,
    stopping: false,
    socketGeneration: 0,
    status: "CREATING",
    lastTransitionAt: Date.now(),
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

export function setLifecycleStatus(
  key: string,
  status: AuthoritativeLifecycleState,
): void {
  const state = getLifecycleState(key);
  state.status = status;
  state.lastTransitionAt = Date.now();
}

export function markOpening(key: string): void {
  const state = getLifecycleState(key);
  state.stopping = false;
  state.socketGeneration += 1;
  setLifecycleStatus(key, "CONNECTING");
}

export function noteMessageReceived(key: string): number {
  const state = getLifecycleState(key);
  state.lastMessageReceivedAt = Date.now();
  return state.lastMessageReceivedAt;
}

export function noteCommandProcessed(key: string): number {
  const state = getLifecycleState(key);
  state.lastCommandProcessedAt = Date.now();
  return state.lastCommandProcessedAt;
}

export function noteOutboundMessage(key: string): number {
  const state = getLifecycleState(key);
  state.lastOutboundMessageAt = Date.now();
  return state.lastOutboundMessageAt;
}

export function noteError(key: string, error: string): void {
  getLifecycleState(key).lastError = error.slice(0, 500);
}

export function markConnected(key: string): void {
  const state = getLifecycleState(key);
  state.connected = true;
  setLifecycleStatus(key, "ONLINE");
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
}

export function markStopping(key: string): void {
  const state = getLifecycleState(key);
  state.stopping = true;
  setLifecycleStatus(key, "DEGRADED");
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.reconnectTimer = undefined;
  state.heartbeatTimer = undefined;
}

export function markClosed(key: string): void {
  const state = getLifecycleState(key);
  state.connected = false;
  if (!state.stopping) setLifecycleStatus(key, "RECONNECTING");
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
  // Persistent WhatsApp sessions must keep recovering from transient failures.
  // A caller may still provide a finite cap for a deliberately bounded operation;
  // normal session transport recovery has no retry ceiling.
  const maxAttempts = input.maxAttempts;
  if (maxAttempts !== undefined && state.reconnectAttempt >= maxAttempts) {
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
  setLifecycleStatus(input.key, "RECONNECTING");
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
  probe?: () => Promise<void>;
  onFailure?: (error: unknown) => void;
}): void {
  const state = getLifecycleState(input.key);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (state.stopping) return;
    if (!input.probe) {
      updateSession(input.workspaceId, input.sessionId, {
        lastHealthyAt: Date.now(),
      });
      return;
    }
    void input
      .probe()
      .then(() => {
        updateSession(input.workspaceId, input.sessionId, {
          lastHealthyAt: Date.now(),
        });
      })
      .catch((error) => {
        input.onFailure?.(error);
      });
  }, input.intervalMs ?? 30_000);
}

export function getLifecycleHealth(
  key: string,
  now = Date.now(),
): {
  status: AuthoritativeLifecycleState;
  connected: boolean;
  socketGeneration: number;
  reconnectAttempt: number;
  lastMessageReceivedAt?: number;
  lastCommandProcessedAt?: number;
  lastOutboundMessageAt?: number;
  lastError?: string;
  ageSinceHeartbeatMs: number;
} {
  const state = getLifecycleState(key);
  return {
    status: state.status,
    connected: state.connected,
    socketGeneration: state.socketGeneration,
    reconnectAttempt: state.reconnectAttempt,
    ...(state.lastMessageReceivedAt !== undefined
      ? { lastMessageReceivedAt: state.lastMessageReceivedAt }
      : {}),
    ...(state.lastCommandProcessedAt !== undefined
      ? { lastCommandProcessedAt: state.lastCommandProcessedAt }
      : {}),
    ...(state.lastOutboundMessageAt !== undefined
      ? { lastOutboundMessageAt: state.lastOutboundMessageAt }
      : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ageSinceHeartbeatMs: Math.max(0, now - state.lastTransitionAt),
  };
}

export function clearLifecycle(key: string): void {
  markStopping(key);
  states.delete(key);
  starts.delete(key);
}

export function stopAllLifecycles(): void {
  for (const key of states.keys()) markStopping(key);
}
