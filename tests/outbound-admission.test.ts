import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueOutbound,
  outboundAdmissionSnapshot,
  resetOutboundAdmissionForTests,
} from "../src/whatsapp/outbound-admission.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded outbound admission", () => {
  afterEach(() => resetOutboundAdmissionForTests());

  it("serializes sends for one session", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, index) => enqueueOutbound({
      sessionId: "session-a",
      priority: 1,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await wait(3);
        order.push(index);
        active -= 1;
      },
    }));

    await Promise.all(tasks);
    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(outboundAdmissionSnapshot().active).toBe(0);
  });

  it("gives another session a turn instead of letting one burst starve it", async () => {
    const order: string[] = [];
    const tasks: Promise<void>[] = [];
    for (let index = 0; index < 6; index += 1) {
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
    expect(order.slice(0, 2)).toContain("b-0");
    expect(order).toContain("b-1");
  });

  it("runs lower numeric priority first after the active send", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tasks = [
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { await firstFinished; order.push(9); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 4, run: async () => { order.push(4); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 1, run: async () => { order.push(1); } }),
      enqueueOutbound({ sessionId: "session-p", priority: 2, run: async () => { order.push(2); } }),
    ];

    await wait(1);
    releaseFirst();
    await Promise.all(tasks);
    expect(order).toEqual([9, 1, 2, 4]);
  });

  it("rejects new work once the bounded pending queue is full", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const accepted: Promise<void>[] = [];
    const configuredCap = outboundAdmissionSnapshot().maxPending;
    for (let index = 0; index < configuredCap + 1; index += 1) {
      accepted.push(enqueueOutbound({
        sessionId: "session-full",
        priority: 1,
        run: async () => {
          if (index === 0) await firstFinished;
        },
      }));
    }

    await expect(enqueueOutbound({
      sessionId: "session-full",
      priority: 1,
      run: async () => undefined,
    })).rejects.toThrow("Outbound admission queue is full");
    expect(outboundAdmissionSnapshot().pending).toBe(configuredCap);

    releaseFirst();
    await Promise.all(accepted);
  }, 15000);
});
