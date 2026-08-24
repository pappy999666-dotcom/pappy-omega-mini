import { describe, expect, it } from "vitest";
import {
  GLOBAL_VALIDATOR_SCOPE,
  LinkBucketStore,
} from "../src/links/link-bucket-store.js";

type RedisSet = Set<string>;

class ScaleRedis {
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, RedisSet>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
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
    for (const member of members) if (set.delete(member)) removed += 1;
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

  async scan(cursor: string, ..._args: unknown[]): Promise<[string, string[]]> {
    if (cursor !== "0") return ["0", []];
    return ["0", [...this.values.keys(), ...this.sets.keys()]];
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
}

describe("Validator Hub scale invariants", () => {
  it("keeps 5,000 unique Main records unique and preserves Active on duplicate intake", async () => {
    const store = new LinkBucketStore(new ScaleRedis() as never);
    const total = 5_000;

    for (let index = 0; index < total; index += 1) {
      const code = `SCALE${String(index).padStart(5, "0")}`;
      await store.upsert({
        canonicalUrl: `https://chat.whatsapp.com/${code}`,
        originalUrl: `https://chat.whatsapp.com/${code}?source=scale`,
        bucket: "main",
        workspaceId: "workspace-scale",
        sourceUserId: "stress-fixture",
        metadata: { needsValidation: true, validationState: "pending" },
      });
    }

    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "main")).toBe(total);
    expect(
      (await store.list(GLOBAL_VALIDATOR_SCOPE, "main", 0, total + 1)).records,
    ).toHaveLength(total);

    const activeUrl = "https://chat.whatsapp.com/SCALE00000";
    await store.move(GLOBAL_VALIDATOR_SCOPE, activeUrl, "active", {
      metadata: { needsValidation: false, validationState: "active" },
    });
    await store.upsert({
      canonicalUrl: activeUrl,
      originalUrl: activeUrl,
      bucket: "main",
      workspaceId: "workspace-scale",
      sourceUserId: "second-source",
      metadata: { needsValidation: true },
    });

    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "active")).toBe(1);
    expect(await store.count(GLOBAL_VALIDATOR_SCOPE, "main")).toBe(total - 1);
    expect(
      (await store.get(GLOBAL_VALIDATOR_SCOPE, activeUrl))?.duplicateCount,
    ).toBe(1);
  });
});
