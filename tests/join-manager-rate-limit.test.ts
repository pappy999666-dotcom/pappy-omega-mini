import { describe, expect, it, vi } from "vitest";
import { joinRestrictionStopReached, joinWhatsAppInvite } from "../src/jobs/join-operation.js";

type Plan = {
  throttleAttempts: number;
  restricted?: boolean;
};

function mockSocket(plan: Plan) {
  let acceptCalls = 0;
  return {
    stats: () => ({ acceptCalls }),
    groupGetInviteInfo: async () => ({ id: "120363000000000001@g.us", subject: "Mock Group" }),
    groupAcceptInvite: async () => {
      acceptCalls += 1;
      if (plan.restricted) throw new Error("spam limit temporarily banned");
      if (acceptCalls <= plan.throttleAttempts) {
        throw new Error("invite endpoint rate limit; try again later");
      }
      return "120363000000000001@g.us";
    },
  };
}

async function runWithBackoff(
  socket: ReturnType<typeof mockSocket>,
  target: string,
  sleep: (delayMs: number) => Promise<void>,
  retryBaseMs = 100,
  retryLimit = 3,
) {
  const backoff: number[] = [];
  let retries = 0;
  let result = await joinWhatsAppInvite(socket, target, {
    participatingGroups: {},
  });
  while (
    !result.success &&
    !result.alreadyMember &&
    !result.requestRequired &&
    result.rateLimited &&
    !result.accountRestricted &&
    retries < retryLimit
  ) {
    retries += 1;
    const delay = retryBaseMs * retries;
    backoff.push(delay);
    await sleep(delay);
    result = await joinWhatsAppInvite(socket, target, {
      participatingGroups: {},
    });
  }
  return { result, retries, backoff };
}

describe("Join Manager restriction threshold", () => {
  it("does not stop after one explicit restriction when threshold is five", () => {
    expect(joinRestrictionStopReached(1, 5)).toBe(false);
    expect(joinRestrictionStopReached(4, 5)).toBe(false);
    expect(joinRestrictionStopReached(5, 5)).toBe(true);
  });

  it("clamps unsafe thresholds to the supported range", () => {
    expect(joinRestrictionStopReached(1, 0)).toBe(true);
    expect(joinRestrictionStopReached(4, 99)).toBe(false);
    expect(joinRestrictionStopReached(5, 99)).toBe(true);
  });
});

describe("Join Manager simultaneous account rate limiting", () => {
  it("keeps retry backoff isolated when two accounts are throttled at once", async () => {
    vi.useFakeTimers();
    try {
      const accountA = mockSocket({ throttleAttempts: 2 });
      const accountB = mockSocket({ throttleAttempts: 1 });
      const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const runA = runWithBackoff(accountA, "https://chat.whatsapp.com/ACCOUNT_A", sleep);
      const runB = runWithBackoff(accountB, "https://chat.whatsapp.com/ACCOUNT_B", sleep);

      await vi.runAllTimersAsync();
      const [a, b] = await Promise.all([runA, runB]);

      expect(a.result.success).toBe(true);
      expect(b.result.success).toBe(true);
      expect(a.retries).toBe(2);
      expect(b.retries).toBe(1);
      expect(a.backoff).toEqual([100, 200]);
      expect(b.backoff).toEqual([100]);
      expect(accountA.stats().acceptCalls).toBe(3);
      expect(accountB.stats().acceptCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an account restriction cancel a separately throttled account", async () => {
    vi.useFakeTimers();
    try {
      const restrictedAccount = mockSocket({ throttleAttempts: 0, restricted: true });
      const throttledAccount = mockSocket({ throttleAttempts: 1 });
      const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const restrictedRun = runWithBackoff(
        restrictedAccount,
        "https://chat.whatsapp.com/RESTRICTED_ACCOUNT",
        sleep,
      );
      const throttledRun = runWithBackoff(
        throttledAccount,
        "https://chat.whatsapp.com/THROTTLED_ACCOUNT",
        sleep,
      );

      await vi.runAllTimersAsync();
      const [restricted, throttled] = await Promise.all([restrictedRun, throttledRun]);

      expect(restricted.result.accountRestricted).toBe(true);
      expect(restricted.retries).toBe(0);
      expect(throttled.result.success).toBe(true);
      expect(throttled.retries).toBe(1);
      expect(throttled.backoff).toEqual([100]);
      expect(throttledAccount.stats().acceptCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
