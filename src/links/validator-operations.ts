import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  LinkBucketStore,
  type LinkBucket,
  type LinkRecord,
} from "./link-bucket-store.js";

export type ValidatorBucket = LinkBucket;

async function withStore<T>(
  fn: (store: LinkBucketStore) => Promise<T>,
): Promise<T> {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1200,
  });
  const store = new LinkBucketStore(redis);
  try {
    return await fn(store);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export async function listValidatorBucket(
  workspaceId: string,
  bucket: ValidatorBucket,
  limit = 40,
): Promise<LinkRecord[]> {
  return withStore(async (store) => {
    const records: LinkRecord[] = [];
    let cursor = 0;
    do {
      const page = await store.list(
        workspaceId,
        bucket,
        cursor,
        Math.min(100, limit - records.length),
      );
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== 0 && records.length < limit);
    return records
      .slice(0, limit)
      .sort(
        (a, b) =>
          (b.lastCheckedAt ?? b.firstSeenAt) -
          (a.lastCheckedAt ?? a.firstSeenAt),
      );
  });
}

export async function listAllValidatorBucket(
  workspaceId: string,
  bucket: ValidatorBucket,
): Promise<LinkRecord[]> {
  return withStore(async (store) =>
    (await listFromStore(store, workspaceId, bucket)).sort(
      (a, b) =>
        (b.lastCheckedAt ?? b.firstSeenAt) - (a.lastCheckedAt ?? a.firstSeenAt),
    ),
  );
}

export async function purgeValidatorBucket(
  workspaceId: string,
  bucket: ValidatorBucket,
): Promise<number> {
  return withStore(async (store) => {
    const records = await listFromStore(store, workspaceId, bucket);
    let removed = 0;
    for (const record of records)
      if (await store.remove(workspaceId, record.canonicalUrl)) removed += 1;
    return removed;
  });
}

export async function mergeValidatorBuckets(
  workspaceId: string,
): Promise<number> {
  return withStore(async (store) => {
    const records = [
      ...(await listFromStore(store, workspaceId, "active")),
      ...(await listFromStore(store, workspaceId, "error")),
    ];
    let moved = 0;
    for (const record of records) {
      const next = await store.move(workspaceId, record.canonicalUrl, "main", {
        metadata: { ...record.metadata, needsValidation: true },
      });
      if (next) moved += 1;
    }
    return moved;
  });
}

async function listFromStore(
  store: LinkBucketStore,
  workspaceId: string,
  bucket: ValidatorBucket,
): Promise<LinkRecord[]> {
  const records: LinkRecord[] = [];
  let cursor = 0;
  do {
    const page = await store.list(workspaceId, bucket, cursor, 100);
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor !== 0);
  return records;
}
