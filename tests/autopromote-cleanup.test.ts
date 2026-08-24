import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  configs: [] as any[],
  runs: [] as any[],
  cancelled: [] as string[],
}));

vi.mock("../src/core/session-registry.js", () => ({
  getWorkspaceOwnerTelegramUserId: () => "owner",
  listAllSessions: () => [],
  refreshSessionRegistry: vi.fn(async () => undefined),
}));

vi.mock("../src/persistence/mongo.js", () => ({
  claimAutoPromoteOccurrence: vi.fn(),
  deleteAutoPromoteConfig: vi.fn(async (id: string) => {
    state.configs = state.configs.filter((config) => config.id !== id);
    state.runs = state.runs.filter((run) => run.configId !== id);
  }),
  disableAutoPromoteConfig: vi.fn(async (id: string) => {
    const config = state.configs.find((item) => item.id === id);
    if (config) {
      config.enabled = false;
      config.state = "CANCELLED";
    }
  }),
  getAutoPromoteConfig: vi.fn(),
  getAutoPromoteRun: vi.fn(),
  listAutoPromoteConfigs: vi.fn(async () => state.configs),
  listAutoPromoteRuns: vi.fn(async (filter: { sessionId?: string; configId?: string }) =>
    state.runs.filter((run) =>
      (!filter.sessionId || run.sessionId === filter.sessionId) &&
      (!filter.configId || run.configId === filter.configId),
    )),
  listRecoverableAutoPromoteRuns: vi.fn(),
  saveAutoPromoteConfig: vi.fn(async (config: any) => {
    const index = state.configs.findIndex((item) => item.id === config.id);
    if (index >= 0) state.configs[index] = config;
    else state.configs.push(config);
  }),
  saveAutoPromoteRun: vi.fn(),
  setAutoPromoteConfigState: vi.fn(),
  deleteAutoPromoteRunsForSession: vi.fn(async (sessionId: string) => {
    const before = state.runs.length;
    state.runs = state.runs.filter((run) => run.sessionId !== sessionId);
    return before - state.runs.length;
  }),
}));

import { purgeAutoPromoteSession } from "../src/autopromote/service.js";

describe("Auto Promote terminal session cleanup", () => {
  beforeEach(() => {
    state.configs = [];
    state.runs = [];
    state.cancelled = [];
  });

  it("deletes session configs, cancels child jobs, and reconciles surviving explicit targets", async () => {
    state.configs = [
      { id: "session-config", scope: "SESSION", sessionId: "dead", targetSessionIds: [] },
      { id: "global-config", scope: "GLOBAL", targetSessionIds: ["dead", "live"], enabled: true, state: "SCHEDULED" },
      { id: "user-config", scope: "USER", targetSessionIds: ["dead", "other"], enabled: true, state: "SCHEDULED" },
    ];
    state.runs = [
      { id: "run-session", configId: "session-config", sessionId: "dead", jobId: "job-session" },
      { id: "run-global", configId: "global-config", sessionId: "dead", jobId: "job-global" },
      { id: "run-live", configId: "global-config", sessionId: "live", jobId: "job-live" },
    ];
    const runtime = {
      cancel: vi.fn(async (jobId: string) => {
        state.cancelled.push(jobId);
        return undefined;
      }),
    };

    await expect(purgeAutoPromoteSession("dead", runtime)).resolves.toEqual({ configs: 1, runs: 2 });

    expect(state.cancelled).toEqual(["job-session", "job-global"]);
    expect(state.runs.map((run) => run.id)).toEqual(["run-live"]);
    expect(state.configs.find((config) => config.id === "session-config")).toBeUndefined();
    expect(state.configs.find((config) => config.id === "global-config").targetSessionIds).toEqual(["live"]);
    expect(state.configs.find((config) => config.id === "user-config").targetSessionIds).toEqual(["other"]);
  });

  it("preserves an all-future config and disables an explicit config emptied by purge", async () => {
    state.configs = [
      { id: "all-future", scope: "GLOBAL", enabled: true, state: "SCHEDULED" },
      { id: "only-dead", scope: "GLOBAL", targetSessionIds: ["dead"], enabled: true, state: "SCHEDULED" },
    ];
    await purgeAutoPromoteSession("dead");

    expect(state.configs.find((config) => config.id === "all-future").enabled).toBe(true);
    expect(state.configs.find((config) => config.id === "only-dead")).toMatchObject({ enabled: false, state: "CANCELLED" });
  });
});
