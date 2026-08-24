import { randomUUID } from "node:crypto";
import type {
  SessionJoinSettings,
  User,
  WhatsAppSession,
  Workspace,
} from "../types/domain.js";
import {
  hydrateRegistry,
  deletePersistedSession,
  persistSession,
  persistUser,
  persistWorkspace,
} from "../persistence/mongo.js";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings,
  type WorkspaceSettings,
} from "./workspace-settings.js";

const users = new Map<string, User>();
const workspaces = new Map<string, Workspace>();
const sessions = new Map<string, WhatsAppSession>();
// Prevent an in-flight Mongo hydration snapshot from resurrecting a session
// after purge has removed it from the live registry.
const deletedSessionIds = new Set<string>();

export function resolveUser(
  telegramUserId: string,
  displayName?: string,
  username?: string,
): User {
  const now = Date.now();
  const existing = users.get(telegramUserId);
  if (existing) {
    const updated: User = {
      ...existing,
      lastSeenAt: now,
      ...((displayName ?? existing.displayName)
        ? { displayName: displayName ?? existing.displayName }
        : {}),
      ...((username ?? existing.username)
        ? { username: username ?? existing.username }
        : {}),
    };
    users.set(telegramUserId, updated);
    void persistUser(updated).catch(() => undefined);
    return updated;
  }
  const workspace: Workspace = {
    workspaceId: randomUUID(),
    ownerTelegramUserId: telegramUserId,
    globalSudoList: [],
    workloadMode: "ON",
    createdAt: now,
  };
  workspaces.set(workspace.workspaceId, workspace);
  void persistWorkspace(workspace).catch(() => undefined);
  const user: User = {
    telegramUserId,
    ...(displayName ? { displayName } : {}),
    ...(username ? { username } : {}),
    role: "user",
    status: "active",
    workspaceId: workspace.workspaceId,
    createdAt: now,
    lastSeenAt: now,
  };
  users.set(telegramUserId, user);
  void persistUser(user).catch(() => undefined);
  return user;
}

function joinSettingsFromWorkspace(workspaceId: string): SessionJoinSettings {
  const settings = getWorkspaceSettings(workspaceId);
  return {
    targetCount: settings.defaultJoinTargetCount,
    delayMs: settings.defaultJoinDelayMs,
    minDelayMs: settings.defaultJoinMinDelayMs,
    maxDelayMs: settings.defaultJoinMaxDelayMs,
    batchCycles: settings.defaultJoinBatchCycles,
    maxConcurrency: settings.defaultJoinMaxConcurrency,
    retryLimit: settings.defaultJoinRetryLimit,
    retryBaseMs: settings.defaultJoinRetryBaseMs,
    sessionCooldownMs: settings.defaultJoinSessionCooldownMs,
    restrictionThreshold: settings.defaultJoinRestrictionThreshold,
    mode: settings.defaultJoinMode ?? "auto",
  };
}

function normalizedSessionJoinSettings(
  workspaceId: string,
  current?: Partial<SessionJoinSettings>,
): SessionJoinSettings {
  const base = joinSettingsFromWorkspace(workspaceId);
  const next = { ...base, ...(current ?? {}) };
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const allowImmediate = next.mode === "immediate";
  const delayMinMs = allowImmediate ? 0 : 1000;
  const minDelayMs = clamp(next.minDelayMs, delayMinMs, 60000);
  const maxDelayMs = Math.max(
    minDelayMs,
    clamp(next.maxDelayMs, minDelayMs, 60000),
  );
  return {
    ...next,
    targetCount: clamp(next.targetCount, 1, 10000),
    delayMs: clamp(next.delayMs, delayMinMs, 60000),
    minDelayMs,
    maxDelayMs,
    batchCycles: clamp(next.batchCycles, 1, 20),
    maxConcurrency: clamp(next.maxConcurrency, 1, 10),
    retryLimit: clamp(next.retryLimit, 0, 5),
    retryBaseMs: clamp(next.retryBaseMs, 1000, 600000),
    sessionCooldownMs: clamp(next.sessionCooldownMs, 0, 3600000),
    restrictionThreshold: clamp(next.restrictionThreshold, 1, 5),
    mode:
      next.mode === "immediate" || next.mode === "request"
        ? next.mode
        : "auto",
  };
}

export function getSessionJoinSettings(
  workspaceId: string,
  sessionId: string,
): SessionJoinSettings {
  const session = getSession(workspaceId, sessionId);
  return normalizedSessionJoinSettings(workspaceId, session.joinSettings);
}

export function updateSessionJoinSettings(
  workspaceId: string,
  sessionId: string,
  patch: Partial<SessionJoinSettings>,
): WhatsAppSession {
  const current = getSessionJoinSettings(workspaceId, sessionId);
  return updateSession(workspaceId, sessionId, {
    joinSettings: normalizedSessionJoinSettings(workspaceId, {
      ...current,
      ...patch,
    }),
  });
}

export function createSession(input: {
  workspaceId: string;
  sessionName: string;
  phoneNumber?: string;
}): WhatsAppSession {
  const workspaceSettings = getWorkspaceSettings(input.workspaceId);
  const session: WhatsAppSession = {
    sessionId: randomUUID(),
    workspaceId: input.workspaceId,
    sessionName: input.sessionName.trim().slice(0, 48),
    ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
    status: "PAIRING",
    prefix: workspaceSettings.defaultPrefix,
    sudoList: [],
    ignoredGroupLinks: [],
    autoJoinEnabled: workspaceSettings.defaultAutoJoinEnabled,
    joinSettings: joinSettingsFromWorkspace(input.workspaceId),
    autoCollectLinks: true,
    autoValidateLinks: true,
    createdAt: Date.now(),
    collectedLinkCount: 0,
    validatedLinkCount: 0,
  };
  sessions.set(session.sessionId, session);
  void persistSession(session).catch(() => undefined);
  return session;
}

export function listSessions(workspaceId: string): WhatsAppSession[] {
  return [...sessions.values()].filter(
    (session) => session.workspaceId === workspaceId,
  );
}

export function isSessionVisibleInTelegram(session: WhatsAppSession): boolean {
  if (session.status === "LOGGED_OUT" || session.status === "BANNED") return false;
  return !(
    Boolean(session.workloadWorkerId) &&
    session.status === "DEGRADED" &&
    session.disconnectReason?.startsWith("Panel heartbeat timeout;")
  );
}

export function listVisibleSessions(workspaceId: string): WhatsAppSession[] {
  return listSessions(workspaceId).filter(isSessionVisibleInTelegram);
}

export function listAllSessions(): WhatsAppSession[] {
  return [...sessions.values()];
}

export function getSession(
  workspaceId: string,
  sessionId: string,
): WhatsAppSession {
  const session = sessions.get(sessionId);
  if (!session || session.workspaceId !== workspaceId)
    throw new Error("Session is not owned by this workspace.");
  return session;
}

export async function deleteSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  getSession(workspaceId, sessionId);
  deletedSessionIds.add(sessionId);
  sessions.delete(sessionId);
  await deletePersistedSession(sessionId);
}

export function updateSession(
  workspaceId: string,
  sessionId: string,
  patch: Partial<WhatsAppSession>,
): WhatsAppSession {
  const current = getSession(workspaceId, sessionId);
  const next = {
    ...current,
    ...patch,
    sessionId: current.sessionId,
    workspaceId: current.workspaceId,
  };
  sessions.set(sessionId, next);
  void persistSession(next).catch(() => undefined);
  return next;
}

export function getWorkspaceOwnerTelegramUserId(
  workspaceId: string,
): string | undefined {
  return workspaces.get(workspaceId)?.ownerTelegramUserId;
}

export function getWorkspaceSudo(workspaceId: string): string[] {
  const workspace = workspaces.get(workspaceId);
  return workspace ? [...(workspace.globalSudoList ?? [])] : [];
}

export function updateWorkspaceSudo(
  workspaceId: string,
  action: "add" | "remove",
  identity: string,
): string[] {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) throw new Error("Workspace not found.");
  const normalized = identity.replace(/[^0-9A-Za-z:_.@-]/g, "");
  if (!normalized) throw new Error("Invalid WhatsApp identity.");
  const current = workspace.globalSudoList ?? [];
  const globalSudoList =
    action === "add"
      ? [...new Set([...current, normalized])]
      : current.filter((item) => item !== normalized);
  const next = { ...workspace, globalSudoList };
  workspaces.set(workspaceId, next);
  void persistWorkspace(next).catch(() => undefined);
  return [...globalSudoList];
}

export function getWorkspaceDefaults(workspaceId: string): WorkspaceSettings {
  return getWorkspaceSettings(workspaceId);
}

export function updateWorkspaceWorkloadMode(
  workspaceId: string,
  mode: "ON" | "OFF",
): Workspace {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) throw new Error("Workspace not found.");
  const next = { ...workspace, workloadMode: mode };
  workspaces.set(workspaceId, next);
  void persistWorkspace(next).catch(() => undefined);
  return next;
}

export function updateWorkspaceDefaults(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceSettings, "workspaceId" | "updatedAt">>,
): WorkspaceSettings {
  // Workspace values are defaults for newly created sessions only. Existing
  // session prefix, auto-join, and Join Manager settings remain isolated.
  return updateWorkspaceSettings(workspaceId, patch);
}

export function setUserStatusLocal(
  telegramUserId: string,
  status: User["status"],
): boolean {
  const user = users.get(telegramUserId);
  if (!user) return false;
  users.set(telegramUserId, { ...user, status, lastSeenAt: Date.now() });
  return true;
}

function normalizedPersistedSession(session: WhatsAppSession): WhatsAppSession {
  return {
    ...session,
    prefix: session.prefix ?? getWorkspaceSettings(session.workspaceId).defaultPrefix,
    sudoList: session.sudoList ?? [],
    ignoredGroupLinks: session.ignoredGroupLinks ?? [],
    autoJoinEnabled:
      session.autoJoinEnabled ??
      getWorkspaceSettings(session.workspaceId).defaultAutoJoinEnabled,
    autoCollectLinks: true,
    autoValidateLinks: true,
    joinSettings: normalizedSessionJoinSettings(
      session.workspaceId,
      session.joinSettings,
    ),
    collectedLinkCount: session.collectedLinkCount ?? 0,
    validatedLinkCount: session.validatedLinkCount ?? 0,
  };
}

export async function hydrateSessionRegistry(): Promise<void> {
  const snapshot = await hydrateRegistry();
  users.clear();
  workspaces.clear();
  sessions.clear();
  for (const user of snapshot.users) users.set(user.telegramUserId, user);
  for (const workspace of snapshot.workspaces)
    workspaces.set(workspace.workspaceId, {
      ...workspace,
      globalSudoList: workspace.globalSudoList ?? [],
      workloadMode: workspace.workloadMode ?? "ON",
    });
  for (const session of snapshot.sessions)
    sessions.set(session.sessionId, normalizedPersistedSession(session));
}

let registryRefreshPromise: Promise<void> | undefined;
let lastRegistryRefreshAt = 0;
const REGISTRY_REFRESH_MIN_INTERVAL_MS = 10_000;

/** Merge database-created sessions into the running registry for picker views and schedulers. */
export async function refreshSessionRegistry(): Promise<void> {
  if (Date.now() - lastRegistryRefreshAt < REGISTRY_REFRESH_MIN_INTERVAL_MS) return;
  if (registryRefreshPromise) return registryRefreshPromise;
  registryRefreshPromise = (async () => {
    const snapshot = await hydrateRegistry();
    for (const user of snapshot.users) users.set(user.telegramUserId, user);
    for (const workspace of snapshot.workspaces)
      workspaces.set(workspace.workspaceId, {
        ...workspace,
        globalSudoList: workspace.globalSudoList ?? [],
        workloadMode: workspace.workloadMode ?? "ON",
      });
    for (const session of snapshot.sessions) {
      if (deletedSessionIds.has(session.sessionId)) continue;
      const current = sessions.get(session.sessionId);
      const persisted = normalizedPersistedSession(session);
      // DB is authoritative for records not currently held by a live socket.
      // Preserve a newer in-memory lifecycle update when it exists.
      const persistedAt = Math.max(persisted.lastHealthyAt ?? 0, persisted.connectedAt ?? 0, persisted.lastMessageReceivedAt ?? 0);
      const currentAt = current
        ? Math.max(current.lastHealthyAt ?? 0, current.connectedAt ?? 0, current.lastMessageReceivedAt ?? 0)
        : 0;
      if (!current || persistedAt >= currentAt) sessions.set(session.sessionId, persisted);
    }
    lastRegistryRefreshAt = Date.now();
  })().finally(() => {
    registryRefreshPromise = undefined;
  });
  return registryRefreshPromise;
}

export function getUserWorkspace(telegramUserId: string): string {
  const user = users.get(telegramUserId);
  if (!user) return resolveUser(telegramUserId).workspaceId;
  return user.workspaceId;
}
