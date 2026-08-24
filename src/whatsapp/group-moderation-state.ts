import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { env } from "../config/env.js";

interface GroupModerationEntry {
  bannedPhones: string[];
  warnings: Record<string, number>;
  updatedAt: number;
}

interface ModerationStore {
  schemaVersion: 1;
  groups: Record<string, GroupModerationEntry>;
}

function pathFor(workspaceId: string, sessionId: string): string {
  return join(resolve(env.SESSION_ROOT, workspaceId, sessionId), "moderation-groups.json");
}

function emptyStore(): ModerationStore {
  return { schemaVersion: 1, groups: {} };
}

function readStore(workspaceId: string, sessionId: string): ModerationStore {
  const path = pathFor(workspaceId, sessionId);
  if (!existsSync(path)) return emptyStore();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ModerationStore>;
    return {
      schemaVersion: 1,
      groups: value && typeof value.groups === "object" && value.groups ? value.groups as Record<string, GroupModerationEntry> : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(workspaceId: string, sessionId: string, store: ModerationStore): void {
  const path = pathFor(workspaceId, sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function normalizePhone(value: string): string {
  return value.replace(/\D/gu, "");
}

function entryOf(store: ModerationStore, groupJid: string): GroupModerationEntry {
  const current = store.groups[groupJid];
  if (current) {
    current.bannedPhones ??= [];
    current.warnings ??= {};
    return current;
  }
  const created: GroupModerationEntry = { bannedPhones: [], warnings: {}, updatedAt: Date.now() };
  store.groups[groupJid] = created;
  return created;
}

export function isPhoneBanned(workspaceId: string, sessionId: string, groupJid: string, phone: string): boolean {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return readStore(workspaceId, sessionId).groups[groupJid]?.bannedPhones?.includes(normalized) ?? false;
}

export function listBannedPhones(workspaceId: string, sessionId: string, groupJid: string): string[] {
  return [...(readStore(workspaceId, sessionId).groups[groupJid]?.bannedPhones ?? [])];
}

export function setPhoneBanned(workspaceId: string, sessionId: string, groupJid: string, phone: string, banned: boolean): void {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const store = readStore(workspaceId, sessionId);
  const entry = entryOf(store, groupJid);
  const next = new Set(entry.bannedPhones);
  if (banned) next.add(normalized); else next.delete(normalized);
  entry.bannedPhones = [...next];
  entry.updatedAt = Date.now();
  writeStore(workspaceId, sessionId, store);
}

export function incrementManualWarning(workspaceId: string, sessionId: string, groupJid: string, phone: string): number {
  const normalized = normalizePhone(phone);
  const store = readStore(workspaceId, sessionId);
  const entry = entryOf(store, groupJid);
  entry.warnings[normalized] = (entry.warnings[normalized] ?? 0) + 1;
  entry.updatedAt = Date.now();
  writeStore(workspaceId, sessionId, store);
  return entry.warnings[normalized];
}

export function getManualWarning(workspaceId: string, sessionId: string, groupJid: string, phone: string): number {
  return readStore(workspaceId, sessionId).groups[groupJid]?.warnings?.[normalizePhone(phone)] ?? 0;
}

export function resetManualWarning(workspaceId: string, sessionId: string, groupJid: string, phone: string): void {
  const store = readStore(workspaceId, sessionId);
  const entry = entryOf(store, groupJid);
  delete entry.warnings[normalizePhone(phone)];
  entry.updatedAt = Date.now();
  writeStore(workspaceId, sessionId, store);
}
