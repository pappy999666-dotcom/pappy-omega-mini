import { afterEach, describe, expect, it } from "vitest";
import {
  clearLifecycle,
  getLifecycleHealth,
  getLifecycleState,
  lifecycleKey,
  markConnected,
  markStableConnected,
  noteHeartbeat,
  recordTerminalFailure,
  startHeartbeat,
  stopAllLifecycles,
  isCircuitOpen,
  getCircuitStats,
} from "../src/whatsapp/session-lifecycle.js";

describe("WhatsApp session lifecycle supervisor telemetry", () => {
  const key = lifecycleKey(
    "workspace-lifecycle-test",
    "session-lifecycle-test",
  );

  afterEach(() => {
    stopAllLifecycles();
    clearLifecycle(key);
  });

  it("preserves reconnect backoff until a connection is stable", () => {
    const state = getLifecycleState(key);
    state.reconnectAttempt = 4;
    markConnected(key);
    expect(getLifecycleState(key).reconnectAttempt).toBe(4);
    markStableConnected(key);
    expect(getLifecycleState(key).reconnectAttempt).toBe(0);
  });

  it("reports the age of the last successful heartbeat rather than the last transition", () => {
    const state = getLifecycleState(key);
    state.lastTransitionAt = 1_000;
    noteHeartbeat(key, 9_000);

    const health = getLifecycleHealth(key, 12_500);

    expect(health.lastHeartbeatAt).toBe(9_000);
    expect(health.ageSinceHeartbeatMs).toBe(3_500);
  });

  it("keeps one heartbeat timer per lifecycle key", async () => {
    let probes = 0;
    startHeartbeat({
      key,
      workspaceId: "workspace-lifecycle-test",
      sessionId: "session-lifecycle-test",
      intervalMs: 5,
      probe: async () => {
        probes += 1;
      },
    });
    const firstTimer = getLifecycleState(key).heartbeatTimer;

    startHeartbeat({
      key,
      workspaceId: "workspace-lifecycle-test",
      sessionId: "session-lifecycle-test",
      intervalMs: 5,
      probe: async () => {
        probes += 1;
      },
    });
    const secondTimer = getLifecycleState(key).heartbeatTimer;

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(firstTimer).not.toBe(secondTimer);
    expect(probes).toBeGreaterThan(0);
  });

  it("does not recover on one or two failed probes, then reports the threshold", async () => {
    let failures = 0;
    startHeartbeat({
      key,
      workspaceId: "workspace-lifecycle-test",
      sessionId: "session-lifecycle-test",
      intervalMs: 5,
      failureThreshold: 3,
      probe: async () => {
        throw new Error("temporary probe failure");
      },
      onFailure: () => {
        failures += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failures).toBeGreaterThanOrEqual(1);
    expect(getLifecycleHealth(key).heartbeatFailures).toBeGreaterThanOrEqual(3);
  });

  it("does not overlap a slow heartbeat probe", async () => {
    let active = 0;
    let maxActive = 0;
    startHeartbeat({
      key,
      workspaceId: "workspace-lifecycle-test",
      sessionId: "session-lifecycle-test",
      intervalMs: 5,
      probe: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 28));
    expect(maxActive).toBe(1);
  });

  it("opens the circuit after repeated 403 failures without a stable open", () => {
    const bannedKey = lifecycleKey("ws-breaker", "session-403-loop");
    try {
      expect(recordTerminalFailure(bannedKey, 403)).toBe(false);
      expect(recordTerminalFailure(bannedKey, 403)).toBe(false);
      expect(recordTerminalFailure(bannedKey, 403)).toBe(false);
      expect(isCircuitOpen(bannedKey)).toBe(false);
      expect(recordTerminalFailure(bannedKey, 403)).toBe(true);
      expect(isCircuitOpen(bannedKey)).toBe(true);
      const stats = getCircuitStats(bannedKey);
      expect(stats.open).toBe(true);
      expect(stats.consecutiveTerminals).toBe(4);
      expect(stats.reason).toContain("403");
    } finally {
      clearLifecycle(bannedKey);
    }
  });

  it("never opens the circuit for transient transport codes", () => {
    const transientKey = lifecycleKey("ws-breaker", "session-transient");
    try {
      for (let i = 0; i < 10; i += 1) {
        expect(recordTerminalFailure(transientKey, 408)).toBe(false);
        expect(recordTerminalFailure(transientKey, 411)).toBe(false);
        expect(recordTerminalFailure(transientKey, 428)).toBe(false);
        expect(recordTerminalFailure(transientKey, 515)).toBe(false);
      }
      expect(isCircuitOpen(transientKey)).toBe(false);
      expect(getCircuitStats(transientKey).consecutiveTerminals).toBe(0);
    } finally {
      clearLifecycle(transientKey);
    }
  });

  it("resets the breaker after a stable open so a later ban can re-open it", () => {
    const recoveredKey = lifecycleKey("ws-breaker", "session-recovered");
    try {
      for (let i = 0; i < 3; i += 1) recordTerminalFailure(recoveredKey, 405);
      markStableConnected(recoveredKey);
      expect(getCircuitStats(recoveredKey).consecutiveTerminals).toBe(0);
      for (let i = 0; i < 3; i += 1) recordTerminalFailure(recoveredKey, 403);
      expect(isCircuitOpen(recoveredKey)).toBe(false);
      expect(recordTerminalFailure(recoveredKey, 403)).toBe(true);
      expect(isCircuitOpen(recoveredKey)).toBe(true);
    } finally {
      clearLifecycle(recoveredKey);
    }
  });
});
