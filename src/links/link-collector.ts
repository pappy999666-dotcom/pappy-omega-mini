import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { LinkBucketStore } from "./link-bucket-store.js";

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const buckets = new LinkBucketStore(redis);

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[),.;!?]+$/, "")))];
}

type CollectionInput = {
  workspaceId: string;
  sourceUserId: string;
  sourceSessionId?: string;
  originalUrl?: string;
};

export async function collectLinks(
  input: CollectionInput & { text: string },
): Promise<{
  found: number;
  added: number;
  urls: string[];
}> {
  return collectUrlValues(input, extractUrls(input.text));
}

/**
 * Collect links from a streamed text source. A short carry window protects URLs
 * split between network chunks while preventing the whole document from being
 * retained in memory.
 */
export async function collectLinksFromChunks(
  input: CollectionInput & { chunks: AsyncIterable<string> },
): Promise<{ found: number; added: number; urls: string[] }> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let carry = "";
  for await (const chunk of input.chunks) {
    carry += chunk;
    if (carry.length <= 4096) continue;
    const boundary = carry.length - 512;
    for (const url of extractUrls(carry.slice(0, boundary))) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    carry = carry.slice(boundary);
  }
  for (const url of extractUrls(carry)) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return collectUrlValues(input, urls);
}

async function collectUrlValues(
  input: CollectionInput,
  urls: string[],
): Promise<{ found: number; added: number; urls: string[] }> {
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
