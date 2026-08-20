import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  LinkBucketStore,
  type LinkBucket,
  type LinkRecord,
} from "./link-bucket-store.js";

export interface ValidatorSnapshot {
  counts: Record<LinkBucket, number>;
  recent: LinkRecord[];
  capturedAt: number;
}

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 1200,
  lazyConnect: false,
});
const store = new LinkBucketStore(redis);

export async function getValidatorSnapshot(
  workspaceId: string,
): Promise<ValidatorSnapshot> {
  await store.reconcileMaster(workspaceId);
  const buckets: LinkBucket[] = [
    "main",
    "validating",
    "active",
    "dead",
    "error",
    "master",
  ];
  const counts = {} as Record<LinkBucket, number>;
  for (const bucket of buckets)
    counts[bucket] = await store.count(workspaceId, bucket);
  const recentRecords = [
    ...(await store.list(workspaceId, "validating", 0, 40)).records,
    ...(await store.list(workspaceId, "active", 0, 40)).records,
    ...(await store.list(workspaceId, "main", 0, 20)).records,
    ...(await store.list(workspaceId, "dead", 0, 8)).records,
    ...(await store.list(workspaceId, "error", 0, 8)).records,
  ];
  const recent = [...new Map(recentRecords.map((record) => [record.canonicalUrl, record])).values()]
    .sort((left, right) => (right.lastCheckedAt ?? right.firstSeenAt) - (left.lastCheckedAt ?? left.firstSeenAt))
    .slice(0, 24);
  return { counts, recent, capturedAt: Date.now() };
}

export async function closeValidatorSnapshot(): Promise<void> {
  await redis.quit().catch(() => undefined);
}
