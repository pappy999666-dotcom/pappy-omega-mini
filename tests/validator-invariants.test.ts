import { describe, expect, it } from "vitest";
import {
  LinkBucketStore,
  GLOBAL_VALIDATOR_SCOPE,
} from "../src/links/link-bucket-store.js";
import { isHealthyWhatsAppSession } from "../src/whatsapp/session-allocator.js";

type SetValue = Set<string>;

class FakeRedis {
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, SetValue>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return Number(this.values.delete(key));
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    this.sets.set(key, set);
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    this.sets.set(key, set);
    return removed;
  }

  async scard(key: string): Promise<number> {
    return (this.sets.get(key) ?? new Set()).size;
  }

  async sscan(
    key: string,
    _cursor: number,
    ..._args: unknown[]
  ): Promise<[string, string[]]> {
    return ["0", [...(this.sets.get(key) ?? new Set())]];
  }

  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    return {
      set: (key: string, value: string) => {
        operations.push(() => this.set(key, value));
        return this;
      },
      sadd: (key: string, ...members: string[]) => {
        operations.push(() => this.sadd(key, ...members));
        return this;
      },
      srem: (key: string, ...members: string[]) => {
        operations.push(() => this.srem(key, ...members));
        return this;
      },
      exec: async () => {
        for (const operation of operations) await operation();
        return [];
      },
    };
  }

  async eval(..._args: unknown[]): Promise<number> {
    return 1;
  }
}

function makeStore(): LinkBucketStore {
  return new LinkBucketStore(new FakeRedis() as never);
}

const base = {
  canonicalUrl: "https://chat.whatsapp.com/ABC123",
  originalUrl: "https://chat.whatsapp.com/ABC123?x=1",
  workspaceId: "workspace",
  sourceUserId: "user",
};

describe("Validator Hub bucket invariants", () => {
  it("preserves an already-active link when the same invite is collected again", async () => {
    const store = makeStore();
    await store.upsert({
      ...base,
      bucket: "active",
      duplicateCount: 0,
      metadata: {
        validationState: "active",
        needsValidation: false,
        validationLeaseToken: "lease-a",
      },
    });

    const next = await store.upsert({
      ...base,
      originalUrl: "https://chat.whatsapp.com/ABC123?s=another-source",
      bucket: "main",
      metadata: { needsValidation: true },
    });

    expect(next.bucket).toBe("active");
    expect(next.metadata?.validationState).toBe("active");
    expect(next.metadata?.validationLeaseToken).toBe("lease-a");
    expect(next.metadata?.needsValidation).toBe(false);
    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "active")).toBe(1);
    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "main")).toBe(0);
  });

  it("rejects an automatic Active-to-Main transition at the canonical store boundary", async () => {
    const store = makeStore();
    await store.upsert({
      ...base,
      bucket: "active",
      metadata: { validationState: "active", needsValidation: false },
    });

    expect(
      await store.move(GLOBAL_VALIDATOR_SCOPE, base.canonicalUrl, "main"),
    ).toBeUndefined();
    expect(
      (await store.get(GLOBAL_VALIDATOR_SCOPE, base.canonicalUrl))?.bucket,
    ).toBe("active");
    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "active")).toBe(1);
    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "main")).toBe(0);
  });

  it("admits only fresh ACTIVE/VALID sessions to validation", () => {
    const baseSession = {
      sessionId: "session",
      workspaceId: "workspace",
      sessionName: "Validator",
      status: "ACTIVE" as const,
      prefix: ".",
      sudoList: [],
      autoJoinEnabled: false,
      authHealth: "VALID" as const,
      connectedAt: Date.now(),
      lastHealthyAt: Date.now(),
    };
    expect(isHealthyWhatsAppSession(baseSession)).toBe(true);
    expect(
      isHealthyWhatsAppSession({ ...baseSession, authHealth: "UNKNOWN" }),
    ).toBe(false);
    expect(
      isHealthyWhatsAppSession({ ...baseSession, authHealth: "DEGRADED" }),
    ).toBe(false);
    expect(
      isHealthyWhatsAppSession({ ...baseSession, status: "DEGRADED" }),
    ).toBe(false);
    expect(
      isHealthyWhatsAppSession({
        ...baseSession,
        validatorRetiredUntil: Date.now() + 60_000,
        validatorRetireReason: "rate-limited during validation",
      }),
    ).toBe(true);
    expect(
      isHealthyWhatsAppSession({
        ...baseSession,
        validatorRetiredUntil: Date.now() + 60_000,
        validatorRetireReason: "three consecutive rate-limited validations",
        validatorConsecutiveRateLimitCount: 3,
      }),
    ).toBe(false);
  });

  it("preserves a validating lease and a confirmed dead record on duplicate intake", async () => {
    const store = makeStore();
    const validating = await store.upsert({
      ...base,
      bucket: "validating",
      metadata: {
        validationState: "validating",
        validationLeaseToken: "lease-b",
      },
    });
    expect((await store.upsert({ ...base, bucket: "main" })).bucket).toBe(
      "validating",
    );
    expect(
      (await store.get(GLOBAL_VALIDATOR_SCOPE, validating.canonicalUrl))
        ?.metadata?.validationLeaseToken,
    ).toBe("lease-b");

    const deadUrl = "https://chat.whatsapp.com/DEAD123";
    await store.upsert({
      ...base,
      canonicalUrl: deadUrl,
      bucket: "dead",
      metadata: { validationState: "dead", needsValidation: false },
      validationError: "expired invite",
    });
    const dead = await store.upsert({
      ...base,
      canonicalUrl: deadUrl,
      bucket: "main",
      metadata: { needsValidation: true },
    });
    expect(dead.bucket).toBe("dead");
    expect(dead.metadata?.validationState).toBe("dead");
    expect(dead.validationError).toBe("expired invite");
  });
});
