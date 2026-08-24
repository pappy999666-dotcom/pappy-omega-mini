import { firstVerifiedPhone } from "./identity-normalization.js";

interface TrackedMessage {
  groupJid: string;
  senderPhone: string;
  key: Record<string, unknown>;
  trackedAt: number;
}

const MAX_PER_SESSION = 5_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const stores = new Map<string, Map<string, TrackedMessage>>();

function storeFor(workspaceId: string, sessionId: string): Map<string, TrackedMessage> {
  const scope = `${workspaceId}:${sessionId}`;
  const existing = stores.get(scope);
  if (existing) return existing;
  const created = new Map<string, TrackedMessage>();
  stores.set(scope, created);
  return created;
}

function prune(store: Map<string, TrackedMessage>, now = Date.now()): void {
  for (const [key, value] of store) if (now - value.trackedAt > MAX_AGE_MS) store.delete(key);
  while (store.size > MAX_PER_SESSION) {
    const oldest = store.keys().next().value;
    if (typeof oldest !== "string") break;
    store.delete(oldest);
  }
}

export function trackInboundMessage(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  senderIdentity: unknown,
  key: Record<string, unknown>,
): void {
  if (!groupJid.endsWith("@g.us") || typeof key.id !== "string" || !key.id) return;
  const senderPhone = firstVerifiedPhone(senderIdentity);
  if (!senderPhone) return;
  const store = storeFor(workspaceId, sessionId);
  const trackedAt = Date.now();
  store.set(`${groupJid}:${key.id}:${senderPhone}`, { groupJid, senderPhone, key: { ...key }, trackedAt });
  prune(store, trackedAt);
}

export function listTrackedMessages(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  senderPhone: string,
): Array<Record<string, unknown>> {
  const store = storeFor(workspaceId, sessionId);
  prune(store);
  return [...store.values()]
    .filter((value) => value.groupJid === groupJid && value.senderPhone === senderPhone)
    .sort((left, right) => left.trackedAt - right.trackedAt)
    .map((value) => ({ ...value.key }));
}

export function forgetTrackedMessage(workspaceId: string, sessionId: string, groupJid: string, key: Record<string, unknown>): void {
  const store = storeFor(workspaceId, sessionId);
  for (const [index, value] of store) {
    if (value.groupJid === groupJid && value.key.id === key.id) store.delete(index);
  }
}

export function clearTrackedMessages(workspaceId: string, sessionId: string): void {
  stores.delete(`${workspaceId}:${sessionId}`);
}
