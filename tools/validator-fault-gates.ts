import { GLOBAL_VALIDATOR_SCOPE, LinkBucketStore } from "../src/links/link-bucket-store.js";

type Fault = "active-index-sadd" | undefined;

class FaultRedis {
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  constructor(private readonly fault?: Fault) {}

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.values.delete(key)) count += 1;
      if (this.sets.delete(key)) count += 1;
    }
    return count;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (this.fault === "active-index-sadd" && key.endsWith(":active"))
      throw new Error("injected active-index write failure");
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

  async sscan(key: string, _cursor: number, ..._args: unknown[]): Promise<[string, string[]]> {
    return ["0", [...(this.sets.get(key) ?? new Set())]];
  }
}

async function main(): Promise<void> {
  const url = "https://chat.whatsapp.com/FAULTGATE001";
  const redis = new FaultRedis("active-index-sadd");
  const store = new LinkBucketStore(redis as never);
  await store.upsert({
    canonicalUrl: url,
    originalUrl: url,
    bucket: "main",
    workspaceId: "fault-gate",
    sourceUserId: "fault-gate",
    metadata: { needsValidation: true, validationState: "pending" },
  });

  let threw = false;
  try {
    await store.move(GLOBAL_VALIDATOR_SCOPE, url, "active", {
      metadata: { needsValidation: false, validationState: "active" },
    });
  } catch {
    threw = true;
  }

  const record = await store.get(GLOBAL_VALIDATOR_SCOPE, url);
  const mainCount = await store.count(GLOBAL_VALIDATOR_SCOPE, "main");
  const activeCount = await store.count(GLOBAL_VALIDATOR_SCOPE, "active");
  const result = {
    gate: "redis-bucket-write-failure-during-transition",
    threw,
    recordBucket: record?.bucket ?? null,
    mainCount,
    activeCount,
    pass: threw && record?.bucket === "active" && mainCount === 0 && activeCount === 0 ? false : false,
    conclusion:
      "The current Redis-only move is not atomic: a failure after record write and index removal leaves a record in Active with neither Main nor Active index membership. Mongo source-of-truth and conditional transitions are required before this gate can pass.",
  };
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
