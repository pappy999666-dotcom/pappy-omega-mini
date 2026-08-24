import { beforeEach, describe, expect, it, vi } from "vitest";

const persistedSessions: Array<Record<string, unknown>> = [];

vi.mock("../src/persistence/mongo.js", () => ({
  hydrateRegistry: vi.fn(async () => ({
    users: [],
    workspaces: [],
    sessions: persistedSessions,
  })),
  deletePersistedSession: vi.fn(async (sessionId: string) => {
    for (let index = persistedSessions.length - 1; index >= 0; index -= 1) {
      if (persistedSessions[index]?.sessionId === sessionId) persistedSessions.splice(index, 1);
    }
  }),
  persistSession: vi.fn(async (session: Record<string, unknown>) => {
    const index = persistedSessions.findIndex((item) => item.sessionId === session.sessionId);
    if (index >= 0) persistedSessions[index] = { ...session };
    else persistedSessions.push({ ...session });
  }),
  persistUser: vi.fn(async () => undefined),
  persistWorkspace: vi.fn(async () => undefined),
}));

import {
  createSession,
  deleteSession,
  listSessions,
  refreshSessionRegistry,
  resolveUser,
} from "../src/core/session-registry.js";

describe("session purge visibility", () => {
  beforeEach(() => {
    persistedSessions.length = 0;
  });

  it("does not resurrect a purged session from a stale hydration snapshot", async () => {
    const user = resolveUser(`purge-race-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "purge-race",
      phoneNumber: "2348012345678",
    });
    persistedSessions.push({ ...session, status: "ACTIVE", authHealth: "VALID" });

    await deleteSession(user.workspaceId, session.sessionId);
    expect(listSessions(user.workspaceId)).toHaveLength(0);

    persistedSessions.push({ ...session, status: "ACTIVE", authHealth: "VALID" });
    await refreshSessionRegistry();
    expect(listSessions(user.workspaceId)).toHaveLength(0);
  });
});
