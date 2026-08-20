import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export type LinkBucket = "main" | "active" | "dead" | "error" | "master";

export interface LinkRecord {
  canonicalUrl: string;
  originalUrl: string;
  bucket: LinkBucket;
  workspaceId: string;
  sourceUserId: string;
  sourceSessionId?: string;
  firstSeenAt: number;
  lastCheckedAt?: number;
  duplicateCount: number;
  metadata?: {
    title?: string;
    memberCount?: number;
    imageUrl?: string;
    inviteCode?: string;
    joinClassification?:
      | "already-member"
      | "invalid-invite"
      | "forbidden"
      | "rate-limit"
      | "transport"
      | "request-required"
      | "joined"
      | "dead-link"
      | "failed";
    joinRetryable?: boolean;
    needsValidation?: boolean;
    validationState?: "pending" | "validating" | "active" | "dead" | "retryable-error";
  };
  validationError?: string;
}

export class LinkBucketStore {
  constructor(private readonly redis: Redis) {}

  async upsert(
    input: Omit<LinkRecord, "duplicateCount" | "firstSeenAt"> & {
      duplicateCount?: number;
    },
  ): Promise<LinkRecord> {
    const key = this.recordKey(input.workspaceId, input.canonicalUrl);
    const existing = await this.get(input.workspaceId, input.canonicalUrl);
    const record: LinkRecord = existing
      ? { ...existing, ...input, duplicateCount: existing.duplicateCount + 1 }
      : {
          ...input,
          duplicateCount: input.duplicateCount ?? 0,
          firstSeenAt: Date.now(),
        };
    await this.redis.set(key, JSON.stringify(record));
    await this.redis.sadd(
      this.bucketKey(record.workspaceId, record.bucket),
      record.canonicalUrl,
    );
    await this.redis.sadd(
      this.bucketKey(record.workspaceId, "master"),
      record.canonicalUrl,
    );
    return record;
  }

  async get(
    workspaceId: string,
    canonicalUrl: string,
  ): Promise<LinkRecord | undefined> {
    const value = await this.redis.get(
      this.recordKey(workspaceId, canonicalUrl),
    );
    return value ? (JSON.parse(value) as LinkRecord) : undefined;
  }

  async move(
    workspaceId: string,
    canonicalUrl: string,
    bucket: LinkBucket,
    patch: Partial<LinkRecord> = {},
  ): Promise<LinkRecord | undefined> {
    const current = await this.get(workspaceId, canonicalUrl);
    if (!current) return undefined;
    const next: LinkRecord = {
      ...current,
      ...patch,
      bucket,
      lastCheckedAt: Date.now(),
    };
    await this.redis.set(
      this.recordKey(workspaceId, canonicalUrl),
      JSON.stringify(next),
    );
    for (const oldBucket of ["main", "active", "dead", "error"] as LinkBucket[])
      await this.redis.srem(
        this.bucketKey(workspaceId, oldBucket),
        canonicalUrl,
      );
    await this.redis.sadd(this.bucketKey(workspaceId, bucket), canonicalUrl);
    await this.redis.sadd(this.bucketKey(workspaceId, "master"), canonicalUrl);
    return next;
  }

  async remove(workspaceId: string, canonicalUrl: string): Promise<boolean> {
    const existing = await this.get(workspaceId, canonicalUrl);
    if (!existing) return false;
    await this.redis.del(this.recordKey(workspaceId, canonicalUrl));
    for (const bucket of [
      "main",
      "active",
      "dead",
      "error",
      "master",
    ] as LinkBucket[])
      await this.redis.srem(this.bucketKey(workspaceId, bucket), canonicalUrl);
    return true;
  }

  async list(
    workspaceId: string,
    bucket: LinkBucket,
    cursor = 0,
    count = 100,
  ): Promise<{ records: LinkRecord[]; nextCursor: number }> {
    const urls = await this.redis.sscan(
      this.bucketKey(workspaceId, bucket),
      cursor,
      "COUNT",
      count,
    );
    const records: LinkRecord[] = [];
    for (const url of urls[1]) {
      const record = await this.get(workspaceId, url);
      if (record) records.push(record);
    }
    return { records, nextCursor: Number(urls[0]) };
  }

  async count(workspaceId: string, bucket: LinkBucket): Promise<number> {
    return this.redis.scard(this.bucketKey(workspaceId, bucket));
  }

  async claimMainForValidation(
    workspaceId: string,
    canonicalUrl: string,
    sourceSessionId?: string,
  ): Promise<boolean> {
    const lockKey = `pappy-omega-mini:validator-claim:${workspaceId}:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const token = randomUUID();
    const acquired = await this.redis.set(lockKey, token, "EX", 60, "NX");
    if (acquired !== "OK") return false;
    try {
      const current = await this.get(workspaceId, canonicalUrl);
      if (!current || current.bucket !== "main") return false;
      return Boolean(
        await this.move(workspaceId, canonicalUrl, "active", {
          ...(sourceSessionId ? { sourceSessionId } : {}),
          metadata: {
            ...(current.metadata ?? {}),
            needsValidation: false,
            validationState: "validating",
          },
        }),
      );
    } finally {
      await this.redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token,
        )
        .catch(() => undefined);
    }
  }

  async listAll(workspaceId: string): Promise<LinkRecord[]> {
    const records: LinkRecord[] = [];
    let cursor = 0;
    do {
      const [nextCursor, urls] = await this.redis.sscan(
        this.bucketKey(workspaceId, "master"),
        cursor,
        "COUNT",
        500,
      );
      for (const url of urls) {
        const record = await this.get(workspaceId, url);
        if (record) records.push(record);
      }
      cursor = Number(nextCursor);
    } while (cursor !== 0);
    return records;
  }

  async removeSourceSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<number> {
    const records = await this.listAll(workspaceId);
    let removed = 0;
    for (const record of records) {
      if (
        record.sourceSessionId === sessionId &&
        (await this.remove(workspaceId, record.canonicalUrl))
      )
        removed += 1;
    }
    return removed;
  }

  async reconcileMaster(workspaceId: string): Promise<number> {
    let added = 0;
    for (const bucket of ["main", "active", "dead", "error"] as LinkBucket[]) {
      let cursor = 0;
      do {
        const [nextCursor, urls] = await this.redis.sscan(
          this.bucketKey(workspaceId, bucket),
          cursor,
          "COUNT",
          500,
        );
        if (urls.length) {
          added += await this.redis.sadd(
            this.bucketKey(workspaceId, "master"),
            ...urls,
          );
        }
        cursor = Number(nextCursor);
      } while (cursor !== 0);
    }
    return added;
  }

  private recordKey(workspaceId: string, canonicalUrl: string): string {
    return `pappy-omega-mini:link:${workspaceId}:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
  }

  private bucketKey(workspaceId: string, bucket: LinkBucket): string {
    return `pappy-omega-mini:links:${workspaceId}:${bucket}`;
  }
}
