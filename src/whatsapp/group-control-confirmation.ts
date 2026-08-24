import { randomUUID } from "node:crypto";

export type PendingGroupControlOperation = "approve" | "reject" | "participant" | "moderation";

export interface GroupControlTableButton {
  text: string;
  id: string;
}

export interface GroupControlTable {
  title: string;
  headers: string[];
  rows: string[][];
  buttons: GroupControlTableButton[];
  footer: string;
}

export interface PendingGroupControl {
  token: string;
  workspaceId: string;
  sessionId: string;
  groupJid: string;
  senderJid: string;
  operation: PendingGroupControlOperation;
  participantAction?: "promote" | "demote" | "remove" | "block" | "demote-remove";
  moderationAction?: "ban" | "unban" | "mute" | "unmute" | "deleteall" | "warn-kick";
  participants: string[];
  quotedMessageKey?: Record<string, unknown>;
  table: GroupControlTable;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 90_000;
const MAX_ENTRIES = 256;
const pending = new Map<string, PendingGroupControl>();

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+(?=@)/, "");
}

function keyOf(workspaceId: string, sessionId: string, groupJid: string, senderJid: string): string {
  return `${workspaceId}\u0000${sessionId}\u0000${normalize(groupJid)}\u0000${normalize(senderJid)}`;
}

function prune(now = Date.now()): void {
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  while (pending.size > MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (typeof oldest !== "string") break;
    pending.delete(oldest);
  }
}

export function registerGroupControlConfirmation(input: Omit<PendingGroupControl, "token" | "createdAt" | "expiresAt">): PendingGroupControl {
  const now = Date.now();
  prune(now);
  const token = randomUUID().replaceAll("-", "").slice(0, 20);
  const value: PendingGroupControl = { ...input, token, createdAt: now, expiresAt: now + TTL_MS };
  pending.set(keyOf(input.workspaceId, input.sessionId, input.groupJid, input.senderJid), value);
  return value;
}

export function consumeGroupControlConfirmation(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  senderJid: string,
  token: string,
): PendingGroupControl | undefined {
  prune();
  const key = keyOf(workspaceId, sessionId, groupJid, senderJid);
  const value = pending.get(key);
  if (!value || value.token !== token || value.expiresAt <= Date.now()) {
    if (value?.expiresAt && value.expiresAt <= Date.now()) pending.delete(key);
    return undefined;
  }
  pending.delete(key);
  return value;
}

export function cancelGroupControlConfirmation(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  senderJid: string,
  token: string,
): boolean {
  return Boolean(consumeGroupControlConfirmation(workspaceId, sessionId, groupJid, senderJid, token));
}

export function pendingGroupControlCount(): number {
  prune();
  return pending.size;
}
