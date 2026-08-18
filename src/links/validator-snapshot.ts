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

export async function getValidatorSnapshot(
  workspaceId: string,
): Promise<ValidatorSnapshot> {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1200,
    lazyConnect: false,
  });
  const store = new LinkBucketStore(redis);
  try {
    const buckets: LinkBucket[] = ["main", "active", "dead", "error", "master"];
    const counts = {} as Record<LinkBucket, number>;
    for (const bucket of buckets)
      counts[bucket] = await store.count(workspaceId, bucket);
    const recent = (await store.list(workspaceId, "master", 0, 12)).records;
    return { counts, recent, capturedAt: Date.now() };
  } finally {
    await redis.quit().catch(() => undefined);
  }
}
