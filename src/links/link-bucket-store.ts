import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  mirrorDurableValidatorLinkState,
  type DurableValidatorState,
} from "./validator-persistence.js";

export const GLOBAL_VALIDATOR_SCOPE = "__admin_validator__";

export type LinkBucket =
  | "main"
  | "validating"
  | "active"
  | "dead"
  | "error"
  | "master";

function durableStateForBucket(bucket: LinkBucket): DurableValidatorState | undefined {
  if (bucket === "main") return "MAIN";
  if (bucket === "validating") return "PROCESSING";
  if (bucket === "active") return "ACTIVE";
  if (bucket === "dead") return "DEAD";
  if (bucket === "error") return "ERROR";
  return undefined;
}

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
    groupJid?: string;
    groupTitle?: string;
    memberCount?: number;
    imageUrl?: string;
    inviteCode?: string;
    joinClassification?:
      | "already-member"
      | "invalid-invite"
      | "expired"
      | "group-unavailable"
      | "forbidden"
      | "permission-denied"
      | "rate-limit"
      | "timeout"
      | "network-error"
      | "transport"
      | "internal-error"
      | "request-required"
      | "joined"
      | "dead-link"
      | "failed";
    joinRetryable?: boolean;
    needsValidation?: boolean;
    validationState?: "pending" | "validating" | "active" | "dead" | "retryable-error";
    validationLeaseToken?: string;
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
      ? {
          ...existing,
          // Re-seeing a URL is deduplication, not a new validation request.
          // Preserve the authoritative bucket and any active validation lease.
          bucket: existing.bucket,
          originalUrl: existing.originalUrl || input.originalUrl,
          sourceUserId: existing.sourceUserId || input.sourceUserId,
          ...(existing.sourceSessionId || !input.sourceSessionId
            ? {}
            : { sourceSessionId: input.sourceSessionId }),
          duplicateCount: existing.duplicateCount + 1,
          ...(existing.bucket === "main"
            ? {
                metadata: {
                  ...(existing.metadata ?? {}),
                  ...(input.metadata ?? {}),
                  needsValidation: true,
                },
              }
            : {}),
        }
      : {
          ...normalizedInput,
          duplicateCount: input.duplicateCount ?? 0,
          firstSeenAt: Date.now(),
        };
    const upsertTransaction = this.redis.multi();
    upsertTransaction.set(key, JSON.stringify(record));
    for (const bucketName of ["main", "validating", "active", "dead", "error"] as LinkBucket[])
      upsertTransaction.srem(
        this.bucketKey(GLOBAL_VALIDATOR_SCOPE, bucketName),
        record.canonicalUrl,
      );
    upsertTransaction.sadd(
      this.bucketKey(GLOBAL_VALIDATOR_SCOPE, record.bucket),
      record.canonicalUrl,
    );
    await upsertTransaction.exec();
    if (env.VALIDATOR_DURABLE_DUAL_WRITE) {
      const state = durableStateForBucket(record.bucket);
      if (state) {
        await mirrorDurableValidatorLinkState({
          normalizedUrl: record.canonicalUrl,
          originalUrl: record.originalUrl,
          workspaceId: record.workspaceId,
          ownerUserId: record.sourceUserId,
          ...(record.sourceSessionId ? { sourceSessionId: record.sourceSessionId } : {}),
          state,
          ...(record.validationError ? { error: record.validationError } : {}),
        }).catch((error) => {
          console.error(
            "[pappy-omega-mini] durable validator dual-write upsert failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
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
    // Active is a confirmed terminal validation state. Automatic writers must
    // never recycle it into Main; explicit operational revalidation needs a
    // separate, auditable transition rather than a generic move call.
    if (current.bucket === "active" && bucket === "main") return undefined;
    const next: LinkRecord = {
      ...current,
      ...patch,
      workspaceId: GLOBAL_VALIDATOR_SCOPE,
      bucket,
      lastCheckedAt: Date.now(),
    };
    const moveTransaction = this.redis.multi();
    moveTransaction.set(
      this.recordKey(workspaceId, canonicalUrl),
      JSON.stringify(next),
    );
    for (const oldBucket of ["main", "validating", "active", "dead", "error"] as LinkBucket[])
      moveTransaction.srem(
        this.bucketKey(workspaceId, oldBucket),
        canonicalUrl,
      );
    moveTransaction.sadd(this.bucketKey(workspaceId, bucket), canonicalUrl);
    await moveTransaction.exec();
    if (env.VALIDATOR_DURABLE_DUAL_WRITE) {
      const durableState = durableStateForBucket(bucket);
      if (durableState) {
        await mirrorDurableValidatorLinkState({
          normalizedUrl: next.canonicalUrl,
          originalUrl: next.originalUrl,
          workspaceId: next.workspaceId,
          ownerUserId: next.sourceUserId,
          ...(next.sourceSessionId ? { sourceSessionId: next.sourceSessionId } : {}),
          state: durableState,
          ...(next.validationError ? { error: next.validationError } : {}),
        }).catch((error) => {
          console.error(
            "[pappy-omega-mini] durable validator dual-write move failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
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

  async sample(
    workspaceId: string,
    bucket: LinkBucket,
    count: number,
  ): Promise<LinkRecord[]> {
    const limit = Math.max(1, Math.min(10_000, Math.floor(count)));
    const urls = await this.redis.srandmember(this.bucketKey(workspaceId, bucket), limit);
    const records = await Promise.all(urls.map((url) => this.get(workspaceId, url)));
    return records.filter((record): record is LinkRecord => record !== undefined && record.bucket === bucket);
  }

  async reconcileGlobalIndexes(): Promise<{ removed: number; restored: number }> {
    let removed = 0;
    let restored = 0;
    const bucketNames = ["main", "validating", "active", "dead", "error"] as LinkBucket[];
    for (const bucket of bucketNames) {
      let cursor = "0";
      do {
        const [nextCursor, urls] = await this.redis.sscan(
          this.bucketKey(GLOBAL_VALIDATOR_SCOPE, bucket),
          cursor,
          "COUNT",
          500,
        );
        cursor = nextCursor;
        for (const url of urls) {
          const record = await this.get(GLOBAL_VALIDATOR_SCOPE, url);
          if (!record || record.bucket !== bucket) {
            removed += Number(
              await this.redis.srem(this.bucketKey(GLOBAL_VALIDATOR_SCOPE, bucket), url),
            );
          }
        }
      } while (cursor !== "0");
    }
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.recordKey(GLOBAL_VALIDATOR_SCOPE, "")}*`,
        "COUNT",
        500,
      );
      cursor = nextCursor;
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const record = JSON.parse(raw) as LinkRecord;
        if (!bucketNames.includes(record.bucket)) continue;
        restored += Number(
          await this.redis.sadd(
            this.bucketKey(GLOBAL_VALIDATOR_SCOPE, record.bucket),
            record.canonicalUrl,
          ),
        );
      }
    } while (cursor !== "0");
    return { removed, restored };
  }

  async claimMainForValidation(
    workspaceId: string,
    canonicalUrl: string,
    sourceSessionId?: string,
    validationLeaseToken?: string,
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
          ...(validationLeaseToken ? { validationLeaseToken } : {}),
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
    let masterCursor = "0";
    do {
      const [nextCursor, legacyMasterKeys] = await this.redis.scan(
        masterCursor,
        "MATCH",
        "pappy-omega-mini:links:*:master",
        "COUNT",
        500,
      );
      if (legacyMasterKeys.length) await this.redis.del(...legacyMasterKeys);
      masterCursor = nextCursor;
    } while (masterCursor !== "0");
    return migrated;
  }

  private recordKey(_workspaceId: string, canonicalUrl: string): string {
    return `pappy-omega-mini:link:${GLOBAL_VALIDATOR_SCOPE}:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
  }

  private bucketKey(_workspaceId: string, bucket: LinkBucket): string {
    return `pappy-omega-mini:links:${GLOBAL_VALIDATOR_SCOPE}:${bucket}`;
  }
}
