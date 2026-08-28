import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueInbound,
  inboundAdmissionSnapshot,
  resetInboundAdmissionForTests,
} from "../src/whatsapp/inbound-admission.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded inbound admission", () => {
  afterEach(() => resetInboundAdmissionForTests());

  it("keeps message work asynchronous and limits one session to configured active tasks", async () => {
    let active = 0;
    let maxActive = 0;
    const completions: number[] = [];
    const perSessionActive = inboundAdmissionSnapshot().perSessionActive;
    for (let index = 0; index < perSessionActive + 4; index += 1) {
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
    expect(maxActive).toBeLessThanOrEqual(perSessionActive);
    expect(completions).toHaveLength(perSessionActive + 4);
    expect(inboundAdmissionSnapshot().active).toBe(0);
  });

  it("caps one noisy session while allowing another session to enter", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let dropped = 0;
    const cap = inboundAdmissionSnapshot().perSessionMaxPending;
    const perSessionActive = inboundAdmissionSnapshot().perSessionActive;
    for (let index = 0; index < cap + perSessionActive + 2; index += 1) {
      enqueueInbound({
        sessionId: "noisy-session",
        priority: 1,
        run: async () => blocked,
        onDrop: () => { dropped += 1; },
      });
    }
    expect(dropped).toBe(2);
    expect(inboundAdmissionSnapshot().perSession["noisy-session"]?.pending).toBe(cap);
    expect(enqueueInbound({
      sessionId: "quiet-session",
      priority: 0,
      run: async () => undefined,
    })).toBe(true);
    release();
    await wait(30);
    expect(inboundAdmissionSnapshot().active).toBe(0);
    expect(inboundAdmissionSnapshot().pending).toBe(0);
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
    let releaseThird!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const thirdFinished = new Promise<void>((resolve) => { releaseThird = resolve; });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { await firstFinished; order.push(9); } });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { await secondFinished; order.push(8); } });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { await thirdFinished; order.push(7); } });
    await wait(1);
    enqueueInbound({ sessionId: "session-p", priority: 4, run: async () => { order.push(4); } });
    enqueueInbound({ sessionId: "session-p", priority: 1, run: async () => { order.push(1); } });
    enqueueInbound({ sessionId: "session-p", priority: 2, run: async () => { order.push(2); } });
    releaseFirst();
    releaseSecond();
    releaseThird();
    await wait(15);
    expect(order.slice(0, 6)).toEqual([9, 8, 7, 1, 2, 4]);
  });
});
