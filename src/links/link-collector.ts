import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { LinkBucketStore } from "./link-bucket-store.js";

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const buckets = new LinkBucketStore(redis);

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[),.;!?]+$/, "")))];
}

export async function collectLinks(input: {
  workspaceId: string;
  text: string;
  sourceUserId: string;
  sourceSessionId?: string;
  originalUrl?: string;
}): Promise<{ found: number; added: number; urls: string[] }> {
  const urls = extractUrls(input.text);
  let added = 0;
  for (const originalUrl of urls) {
    try {
      const canonicalUrl = new URL(originalUrl).toString();
      const before = await buckets.get(input.workspaceId, canonicalUrl);
      await buckets.upsert({
        canonicalUrl,
        originalUrl: input.originalUrl ?? originalUrl,
        bucket: "main",
        workspaceId: input.workspaceId,
        sourceUserId: input.sourceUserId,
        ...(input.sourceSessionId
          ? { sourceSessionId: input.sourceSessionId }
          : {}),
      });
      if (!before) added += 1;
    } catch {
      // Ignore malformed links while preserving valid links from the same payload.
    }
  }
  return { found: urls.length, added, urls };
}

export async function closeLinkCollector(): Promise<void> {
  await redis.quit();
}
