import { describe, expect, it } from "vitest";
import {
  createSession,
  getWorkspaceDefaults,
  listSessions,
  updateWorkspaceDefaults,
} from "../src/core/session-registry.js";

describe("live workspace settings", () => {
  it("keeps existing session settings isolated while updating workspace defaults", () => {
    const workspaceId = `workspace-live-${Date.now()}`;
    const otherWorkspaceId = `${workspaceId}-other`;
    const first = createSession({ workspaceId, sessionName: "first" });
    const second = createSession({ workspaceId, sessionName: "second" });
    const other = createSession({
      workspaceId: otherWorkspaceId,
      sessionName: "other",
    });

    const settings = updateWorkspaceDefaults(workspaceId, {
      defaultAutoJoinEnabled: true,
      defaultPrefix: "!",
      defaultJoinDelayMs: 10000,
    });

    expect(settings.defaultAutoJoinEnabled).toBe(true);
    expect(getWorkspaceDefaults(workspaceId).defaultPrefix).toBe("!");
    expect(
      listSessions(workspaceId).filter(
        (item) => !item.autoJoinEnabled && item.prefix === ".",
      ),
    ).toHaveLength(2);
    expect(other.autoJoinEnabled).toBe(false);
    expect(other.prefix).toBe(".");
    expect(first.workspaceId).toBe(workspaceId);
    expect(second.workspaceId).toBe(workspaceId);
  });
});
