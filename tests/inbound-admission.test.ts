import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueInbound,
  inboundAdmissionSnapshot,
  resetInboundAdmissionForTests,
} from "../src/whatsapp/inbound-admission.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded inbound admission", () => {
  afterEach(() => resetInboundAdmissionForTests());

  it("keeps message work asynchronous and limits one session to two active tasks", async () => {
    let active = 0;
    let maxActive = 0;
    const completions: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      expect(enqueueInbound({
        sessionId: "session-a",
        priority: 1,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await wait(8);
          completions.push(index);
          active -= 1;
        },
      })).toBe(true);
    }
    expect(inboundAdmissionSnapshot().pending).toBeGreaterThan(0);
    await wait(45);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(completions).toHaveLength(6);
    expect(inboundAdmissionSnapshot().active).toBe(0);
  });

  it("round-robins sessions instead of letting one burst starve another", async () => {
    const order: string[] = [];
    const task = (sessionId: string, index: number) => enqueueInbound({
      sessionId,
      priority: 1,
      run: async () => {
        order.push(`${sessionId}-${index}`);
        await wait(2);
      },
    });
    for (let index = 0; index < 5; index += 1) task("session-a", index);
    for (let index = 0; index < 2; index += 1) task("session-b", index);
    await wait(30);
    expect(order.slice(0, 4)).toContain("session-b-0");
    expect(order.slice(0, 6)).toContain("session-b-1");
  });

  it("runs lower numeric priority first within a queued session", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { await firstFinished; order.push(9); } });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { await secondFinished; order.push(8); } });
    await wait(1);
    enqueueInbound({ sessionId: "session-p", priority: 4, run: async () => { order.push(4); } });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { order.push(1); } });
    enqueueInbound({ sessionId: "session-p", priority: 2, run: async () => { order.push(2); } });
    releaseFirst();
    releaseSecond();
    await wait(15);
    expect(order.slice(0, 5)).toEqual([9, 8, 1, 2, 4]);
  });
});
