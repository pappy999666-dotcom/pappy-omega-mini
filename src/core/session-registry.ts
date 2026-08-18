import { randomUUID } from "node:crypto";
import type { User, WhatsAppSession, Workspace } from "../types/domain.js";
import {
  hydrateRegistry,
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
    autoJoinEnabled: workspaceSettings.defaultAutoJoinEnabled,
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
  const normalized = identity.replace(/[^0-9:@.-]/g, "");
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

export function updateWorkspaceDefaults(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceSettings, "workspaceId" | "updatedAt">>,
): WorkspaceSettings {
  const next = updateWorkspaceSettings(workspaceId, patch);
  for (const current of listSessions(workspaceId)) {
    updateSession(workspaceId, current.sessionId, {
      ...(patch.defaultPrefix !== undefined
        ? { prefix: next.defaultPrefix }
        : {}),
      ...(patch.defaultAutoJoinEnabled !== undefined
        ? { autoJoinEnabled: next.defaultAutoJoinEnabled }
        : {}),
    });
  }
  return next;
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
    });
  for (const session of snapshot.sessions)
    sessions.set(session.sessionId, session);
}

export function getUserWorkspace(telegramUserId: string): string {
  const user = users.get(telegramUserId);
  if (!user) return resolveUser(telegramUserId).workspaceId;
  return user.workspaceId;
}
