import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export const GLOBAL_VALIDATOR_SCOPE = "__admin_validator__";

export type LinkBucket =
  | "main"
  | "validating"
  | "active"
  | "dead"
  | "error"
  | "master";

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
    const normalizedInput = { ...input, workspaceId: GLOBAL_VALIDATOR_SCOPE };
    const key = this.recordKey(GLOBAL_VALIDATOR_SCOPE, input.canonicalUrl);
    const existing = await this.get(GLOBAL_VALIDATOR_SCOPE, input.canonicalUrl);
    const record: LinkRecord = existing
      ? { ...existing, ...normalizedInput, duplicateCount: existing.duplicateCount + 1 }
      : {
          ...normalizedInput,
          duplicateCount: input.duplicateCount ?? 0,
          firstSeenAt: Date.now(),
        };
    await this.redis.set(key, JSON.stringify(record));
    await this.redis.sadd(
      this.bucketKey(record.workspaceId, record.bucket),
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
      workspaceId: GLOBAL_VALIDATOR_SCOPE,
      bucket,
      lastCheckedAt: Date.now(),
    };
    await this.redis.set(
      this.recordKey(workspaceId, canonicalUrl),
      JSON.stringify(next),
    );
    for (const oldBucket of ["main", "validating", "active", "dead", "error"] as LinkBucket[])
      await this.redis.srem(
        this.bucketKey(workspaceId, oldBucket),
        canonicalUrl,
      );
    await this.redis.sadd(this.bucketKey(workspaceId, bucket), canonicalUrl);
    return next;
  }

  async clearValidationError(
    workspaceId: string,
    canonicalUrl: string,
  ): Promise<boolean> {
    const existing = await this.get(workspaceId, canonicalUrl);
    if (!existing || existing.validationError === undefined) return false;
    const next = { ...existing };
    delete next.validationError;
    await this.redis.set(
      this.recordKey(workspaceId, canonicalUrl),
      JSON.stringify(next),
    );
    return true;
  }

  async remove(workspaceId: string, canonicalUrl: string): Promise<boolean> {
    const existing = await this.get(workspaceId, canonicalUrl);
    if (!existing) return false;
    await this.redis.del(this.recordKey(workspaceId, canonicalUrl));
    for (const bucket of [
      "main",
      "validating",
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
      const moved = await this.move(workspaceId, canonicalUrl, "validating", {
        ...(sourceSessionId ? { sourceSessionId } : {}),
        metadata: {
          ...(current.metadata ?? {}),
          needsValidation: false,
          validationState: "validating",
        },
      });
      if (!moved) return false;
      await this.clearValidationError(workspaceId, canonicalUrl);
      return true;
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

  async listAll(_workspaceId: string): Promise<LinkRecord[]> {
    const records = new Map<string, LinkRecord>();
    for (const bucket of ["main", "validating", "active", "dead", "error"] as LinkBucket[]) {
      let cursor = 0;
      do {
        const [nextCursor, urls] = await this.redis.sscan(
          this.bucketKey(GLOBAL_VALIDATOR_SCOPE, bucket),
          cursor,
          "COUNT",
          500,
        );
        for (const url of urls) {
          const record = await this.get(GLOBAL_VALIDATOR_SCOPE, url);
          if (record) records.set(record.canonicalUrl, record);
        }
        cursor = Number(nextCursor);
      } while (cursor !== 0);
    }
    return [...records.values()];
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

  async reconcileMaster(_workspaceId: string): Promise<number> {
    return 0;
  }

  async migrateLegacyWorkspacesToGlobal(): Promise<number> {
    const claimKey = "pappy-omega-mini:validator-global-migration";
    const claimed = await this.redis.set(claimKey, "1", "EX", 300, "NX");
    if (claimed !== "OK") return 0;
    let migrated = 0;
    let cursor = "0";
    do {
      const result = await this.redis.scan(cursor, "MATCH", "pappy-omega-mini:link:*", "COUNT", 500);
      cursor = result[0];
      for (const key of result[1]) {
        const parts = key.split(":");
        if (parts.length !== 4 || parts[2] === GLOBAL_VALIDATOR_SCOPE) continue;
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const legacy = JSON.parse(raw) as LinkRecord;
        await this.upsert({ ...legacy, workspaceId: GLOBAL_VALIDATOR_SCOPE });
        await this.redis.del(key);
        migrated += 1;
      }
    } while (cursor !== "0");
    const legacyMasterKeys = await this.redis.keys("pappy-omega-mini:links:*:master");
    if (legacyMasterKeys.length) await this.redis.del(...legacyMasterKeys);
    return migrated;
  }

  private recordKey(_workspaceId: string, canonicalUrl: string): string {
    return `pappy-omega-mini:link:${GLOBAL_VALIDATOR_SCOPE}:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
  }

  private bucketKey(_workspaceId: string, bucket: LinkBucket): string {
    return `pappy-omega-mini:links:${GLOBAL_VALIDATOR_SCOPE}:${bucket}`;
  }
}
