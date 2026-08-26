import { afterEach, describe, expect, it } from "vitest";
import {
  isNoisyBaileysProtocolLog,
  sanitizeNoisyBaileysLogArgs,
} from "../src/whatsapp/baileys-log-safety.js";
import {
  getRuntimeHealthSnapshot,
  startRuntimeHealthMonitor,
  stopRuntimeHealthMonitor,
} from "../src/core/runtime-health.js";

describe("CPU forensic audit guards", () => {
  afterEach(() => {
    stopRuntimeHealthMonitor();
  });

  it("summarizes noisy newsletter logs without forwarding protocol nodes", () => {
    const largeNode = {
      tag: "notification",
      attrs: { from: "newsletter@g.us" },
      content: [Buffer.alloc(1024 * 1024, 7)],
    };
    const args = [largeNode, "invalid mex newsletter notification content"];

    expect(isNoisyBaileysProtocolLog(args)).toBe(true);
    const safe = sanitizeNoisyBaileysLogArgs(args);
    expect(safe).toHaveLength(1);
    expect(safe[0]).toMatchObject({
      event: "baileys-protocol-log",
      message: expect.stringContaining("invalid mex newsletter"),
    });
    expect(JSON.stringify(safe).length).toBeLessThan(2_000);
    expect(JSON.stringify(safe)).not.toContain("newsletter@g.us");
  });

  it("summarizes the fork raw-node error shape without forwarding its node string", () => {
    const rawNode = "<message>" + "x".repeat(100_000) + "</message>";
    const args = [{ error: new Error("decode failed"), node: rawNode }, "error in handling message"];

    expect(isNoisyBaileysProtocolLog(args)).toBe(true);
    const safe = sanitizeNoisyBaileysLogArgs(args);
    expect(JSON.stringify(safe).length).toBeLessThan(2_000);
    expect(JSON.stringify(safe)).not.toContain(rawNode);
  });

  it("does not classify ordinary errors as noisy newsletter logs", () => {
    expect(isNoisyBaileysProtocolLog([new Error("temporary network failure")])).toBe(false);
  });

  it("exposes p99, event-loop utilization, and active resource counts", () => {
    startRuntimeHealthMonitor();
    const snapshot = getRuntimeHealthSnapshot();

    expect(snapshot.eventLoopLagMs).toHaveProperty("p99");
    expect(snapshot.eventLoopUtilization).toHaveProperty("utilization");
    expect(Number.isFinite(snapshot.activeHandles)).toBe(true);
    expect(Number.isFinite(snapshot.activeRequests)).toBe(true);
  });
});
