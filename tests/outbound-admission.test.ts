import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueOutbound,
  outboundAdmissionSnapshot,
  resetOutboundAdmissionForTests,
} from "../src/whatsapp/outbound-admission.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded outbound admission", () => {
  afterEach(() => resetOutboundAdmissionForTests());

  it("allows configured concurrent sends per session", async () => {
    let active = 0;
    let maxActive = 0;
    const perSessionActive = outboundAdmissionSnapshot().perSessionActive;
    const tasks = Array.from({ length: perSessionActive + 2 }, (_, index) => enqueueOutbound({
      sessionId: "session-a",
      priority: 1,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await wait(5);
        active -= 1;
      },
    }));

    await Promise.all(tasks);
    expect(maxActive).toBe(perSessionActive);
    expect(outboundAdmissionSnapshot().active).toBe(0);
  });

  it("gives another session a turn instead of letting one burst starve it", async () => {
    const order: string[] = [];
    const tasks: Promise<void>[] = [];
    const perSessionActive = outboundAdmissionSnapshot().perSessionActive;
    for (let index = 0; index < perSessionActive + 4; index += 1) {
      tasks.push(enqueueOutbound({
        sessionId: "session-a",
        priority: 1,
        run: async () => {
          order.push(`a-${index}`);
          await wait(2);
        },
      }));
    }
    for (let index = 0; index < 2; index += 1) {
      tasks.push(enqueueOutbound({
        sessionId: "session-b",
        priority: 1,
        run: async () => {
          order.push(`b-${index}`);
          await wait(2);
        },
      }));
    }

    await Promise.all(tasks);
    expect(order.slice(0, perSessionActive + 1)).toContain("b-0");
    expect(order).toContain("b-1");
  });

  it("runs lower numeric priority first after the active send", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const thirdFinished = new Promise<void>((resolve) => { releaseThird = resolve; });
    const tasks = [
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { await firstFinished; order.push(9); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { await secondFinished; order.push(8); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { await thirdFinished; order.push(7); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 4, run: async () => { order.push(4); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { order.push(1); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 2, run: async () => { order.push(2); } }),
    ];

    await wait(1);
    releaseFirst();
    releaseSecond();
    releaseThird();
    await Promise.all(tasks);
    expect(order).toEqual([9, 8, 7, 1, 2, 4]);
  });

  it("reports per-session telemetry while work is active and pending", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const perSessionActive = outboundAdmissionSnapshot().perSessionActive;
    const first = enqueueOutbound({ sessionId: "session-observed", priority: 1, run: () => blocked });
    const blockers: Promise<void>[] = [first];
    for (let i = 1; i < perSessionActive; i++) {
      blockers.push(enqueueOutbound({ sessionId: "session-observed", priority: 1, run: () => blocked }));
    }
    await wait(2);
    const second = enqueueOutbound({ sessionId: "session-observed", priority: 1, run: async () => undefined });
    const snapshot = outboundAdmissionSnapshot();
    expect(snapshot.perSession["session-observed"]).toMatchObject({ active: perSessionActive, pending: 1 });
    release();
    await Promise.all([first, second, ...blockers.slice(1)]);
  });

  it("rejects new work once the bounded pending queue is full", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const accepted: Promise<void>[] = [];
    const configuredCap = outboundAdmissionSnapshot().perSessionMaxPending;
    const perSessionActive = outboundAdmissionSnapshot().perSessionActive;
    for (let index = 0; index < configuredCap + perSessionActive; index += 1) {
      accepted.push(enqueueOutbound({
        sessionId: "session-full",
        priority: 1,
        run: async () => {
          await firstFinished;
        },
      }));
    }

    await expect(enqueueOutbound({
      sessionId: "session-full",
      priority: 1,
      run: async () => undefined,
    })).rejects.toThrow(/Outbound (?:session )?admission queue is full/);
    expect(outboundAdmissionSnapshot().pending).toBe(configuredCap);

    releaseFirst();
    await Promise.all(accepted);
  }, 15000);
});
