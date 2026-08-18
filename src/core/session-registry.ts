import { randomUUID } from "node:crypto";
import type { User, WhatsAppSession, Workspace } from "../types/domain.js";

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
    return updated;
  }
  const workspace: Workspace = {
    workspaceId: randomUUID(),
    ownerTelegramUserId: telegramUserId,
    createdAt: now,
  };
  workspaces.set(workspace.workspaceId, workspace);
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
  return user;
}

export function createSession(input: {
  workspaceId: string;
  sessionName: string;
  phoneNumber?: string;
}): WhatsAppSession {
  const session: WhatsAppSession = {
    sessionId: randomUUID(),
    workspaceId: input.workspaceId,
    sessionName: input.sessionName.trim().slice(0, 48),
    ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
    status: "PAIRING",
    prefix: ".",
    sudoList: [],
    autoJoinEnabled: false,
  };
  sessions.set(session.sessionId, session);
  return session;
}

export function listSessions(workspaceId: string): WhatsAppSession[] {
  return [...sessions.values()].filter(
    (session) => session.workspaceId === workspaceId,
  );
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
  return next;
}

export function getUserWorkspace(telegramUserId: string): string {
  const user = users.get(telegramUserId);
  if (!user) return resolveUser(telegramUserId).workspaceId;
  return user.workspaceId;
}
