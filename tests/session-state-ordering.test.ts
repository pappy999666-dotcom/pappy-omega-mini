import { describe, expect, it } from "vitest";
import { createSession, getSession, resolveUser, updateSession } from "../src/core/session-registry.js";

describe("session lifecycle ordering", () => {
  it("ignores an older workload event after a newer local lifecycle event", () => {
    const user = resolveUser(`lifecycle-order-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "ordering" });

    updateSession(
      user.workspaceId,
      session.sessionId,
      { status: "ACTIVE", authHealth: "VALID", lastHealthyAt: 2_000 },
      { eventAt: 2_000, source: "local" },
    );
    updateSession(
      user.workspaceId,
      session.sessionId,
      { status: "DEGRADED", authHealth: "DEGRADED", disconnectReason: "delayed worker event" },
      { eventAt: 1_000, source: "workload" },
    );

    expect(getSession(user.workspaceId, session.sessionId)).toMatchObject({
      status: "ACTIVE",
      authHealth: "VALID",
      lastHealthyAt: 2_000,
      lifecycleEventAt: 2_000,
    });
  });

  it("applies a newer workload event and increments lifecycle version", () => {
    const user = resolveUser(`lifecycle-newer-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "newer" });

    const first = updateSession(
      user.workspaceId,
      session.sessionId,
      { status: "RECONNECTING", authHealth: "DEGRADED" },
      { eventAt: 3_000, source: "workload" },
    );
    const second = updateSession(
      user.workspaceId,
      session.sessionId,
      { status: "ACTIVE", authHealth: "VALID", lastHealthyAt: 4_000 },
      { eventAt: 4_000, source: "workload" },
    );

    expect(second.lifecycleVersion).toBeGreaterThan(first.lifecycleVersion ?? 0);
    expect(second).toMatchObject({
      status: "ACTIVE",
      authHealth: "VALID",
      lifecycleEventAt: 4_000,
      lifecycleSource: "workload",
    });
  });
});
