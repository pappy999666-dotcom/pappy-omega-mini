/**
 * Digital OS — draft-session store.
 *
 * A user opens a Digital OS app (`.os`) which registers one draft session bound
 * to their JID + chat. Every screen re-render, toggle, stepper tap, page turn
 * and "Done" happens against this draft through the SAME opaque token, so the
 * container identity is stable across bubbles. Drafts are one-shot: Done or TTL
 * expiry (default 10 min idle) consumes the token. Interaction ids are
 * `dos:<token>:<action>` where `<action>` is one of the button verbs produced
 * by DigitalUIBuilder (x<c> / c<c> / u<c> / d<c> / done / back / home /
 * next / prev / open.<path>).
 */
import { createHash, randomBytes } from "node:crypto";

export type DosValue = boolean | number | string;

export interface DosDraft {
  token: string;
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  initiatorJid: string;
  /** App being configured, e.g. "main" | "anti". */
  appId: string;
  /** Current screen path within the app, e.g. "home" | "module:antilink". */
  screen: string;
  /** Navigation stack of screens opened under this token ("main" bottom). */
  stack: string[];
  /** Draft values keyed by screen-scoped ids, e.g. "antilink.enabled". */
  values: Record<string, DosValue>;
  page: number;
  createdAt: number;
  expiresAt: number;
  committed: boolean;
}

const KEY_SEP = "\u0000";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const drafts = new Map<string, DosDraft>();

const keyOf = (
  workspaceId: string,
  sessionId: string,
  chatJid: string,
  token: string,
): string => [workspaceId, sessionId, chatJid, token].join(KEY_SEP);

function normalizeIdentity(value: string): string {
  return (value.trim().toLowerCase().split("@")[0] ?? "").split(":")[0] ?? "";
}
export function dosIdentitiesMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || normalizeIdentity(left) === normalizeIdentity(right);
}

function sweep(now = Date.now()): void {
  for (const [key, draft] of drafts) {
    if (draft.expiresAt <= now || draft.committed) drafts.delete(key);
  }
}

export function createDosToken(seed: string): string {
  const seedHash = createHash("sha1").update(normalizeIdentity(seed)).digest("hex").slice(0, 8);
  return `${Date.now().toString(36)}${seedHash}${randomBytes(5).toString("hex")}`;
}

export function createDosSession(input: {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  initiatorJid: string;
  appId: string;
  screen: string;
  values?: Record<string, DosValue>;
  stack?: string[];
  ttlMs?: number;
}): DosDraft {
  sweep();
  const token = createDosToken(input.initiatorJid);
  const now = Date.now();
  const draft: DosDraft = {
    token,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    chatJid: input.chatJid,
    initiatorJid: input.initiatorJid,
    appId: input.appId,
    screen: input.screen,
    stack: input.stack && input.stack.length ? [...input.stack] : [input.screen],
    values: { ...(input.values ?? {}) },
    page: 0,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    committed: false,
  };
  drafts.set(keyOf(draft.workspaceId, draft.sessionId, draft.chatJid, token), draft);
  return { ...draft };
}

export function getDosSession(
  workspaceId: string,
  sessionId: string,
  chatJid: string,
  token: string,
): DosDraft | undefined {
  sweep();
  const draft = drafts.get(keyOf(workspaceId, sessionId, chatJid, token));
  return draft ? { ...draft } : undefined;
}

/**
 * Lookup by token only (workspace+session scope). HTML beacons arrive from the
 * user's DM (`wa.me` deep link), so the chat of the tap differs from the chat
 * the screen was opened in — the token is the identity, not the chat.
 */
export function getDosSessionByToken(
  workspaceId: string,
  sessionId: string,
  token: string,
): DosDraft | undefined {
  sweep();
  const prefix = `${workspaceId}${KEY_SEP}${sessionId}${KEY_SEP}`;
  const suffix = `${KEY_SEP}${token}`;
  for (const [key, draft] of drafts) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) return { ...draft };
  }
  return undefined;
}

export function updateDosSession(
  draft: DosDraft,
  patch: Partial<Omit<DosDraft, "token" | "workspaceId" | "sessionId" | "chatJid" | "initiatorJid" | "createdAt">>,
): DosDraft {
  const key = keyOf(draft.workspaceId, draft.sessionId, draft.chatJid, draft.token);
  const existing = drafts.get(key);
  if (!existing) throw new Error("Digital OS session expired or was already closed.");
  const next: DosDraft = {
    ...existing,
    ...patch,
    values: { ...existing.values, ...(patch.values ?? {}) },
    expiresAt: Date.now() + DEFAULT_TTL_MS,
  };
  drafts.set(key, next);
  return { ...next };
}

export function commitDosSession(draft: DosDraft): DosDraft {
  const key = keyOf(draft.workspaceId, draft.sessionId, draft.chatJid, draft.token);
  const existing = drafts.get(key);
  if (!existing) return { ...draft, committed: true };
  const next: DosDraft = { ...existing, committed: true, values: { ...existing.values } };
  drafts.set(key, next);
  return { ...next };
}

/** Live-token check for the non-owner tap guard (does not consume). */
export function peekDosToken(
  workspaceId: string,
  sessionId: string,
  chatJid: string,
  token: string,
): { live: boolean; initiatorJid?: string } {
  const draft = getDosSession(workspaceId, sessionId, chatJid, token);
  if (!draft || draft.committed) return { live: false };
  return { live: true, initiatorJid: draft.initiatorJid };
}

/** Test/ops helper: force expiry of one draft. */
export function _expireDosSession(
  workspaceId: string,
  sessionId: string,
  chatJid: string,
  token: string,
): void {
  const key = keyOf(workspaceId, sessionId, chatJid, token);
  const existing = drafts.get(key);
  if (existing) existing.expiresAt = Date.now() - 1;
}

export function dosSessionCount(): number {
  sweep();
  return drafts.size;
}

export function resetDosSessions(): void {
  drafts.clear();
}

/** Interaction id grammar: dos:<token>:<action>. */
export function isDosInteractionId(value: string): boolean {
  return /^dos:[a-z0-9-]+:[a-z0-9.]+$/iu.test(value.trim());
}

export function parseDosInteractionId(value: string): { token: string; action: string } | undefined {
  const match = /^dos:([a-z0-9-]+):([a-z0-9.]+)$/iu.exec(value.trim());
  if (!match) return undefined;
  return { token: match[1] ?? "", action: match[2] ?? "" };
}
