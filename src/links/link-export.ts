import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { LinkBucketStore, type LinkBucket } from "./link-bucket-store.js";

export interface BucketExport {
  fileName: string;
  mimeType: string;
  content: string;
}

export async function exportBucket(
  workspaceId: string,
  bucket: LinkBucket,
  format: "txt" | "html",
): Promise<BucketExport> {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    const store = new LinkBucketStore(redis);
    const records: Awaited<ReturnType<LinkBucketStore["list"]>>["records"] = [];
    let cursor = 0;
    do {
      const page = await store.list(workspaceId, bucket, cursor, 250);
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== 0 && records.length < 10_000);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    if (format === "txt")
      return {
        fileName: `pappy-${bucket}-${stamp}.txt`,
        mimeType: "text/plain",
        content:
          records.map((record) => record.canonicalUrl).join("\n") ||
          "No links in this bucket.\n",
      };
    const rows = records
      .map(
        (record) =>
          `<tr><td><a href="${escapeHtml(record.canonicalUrl)}">${escapeHtml(record.canonicalUrl)}</a></td><td>${escapeHtml(record.metadata?.title ?? "")}</td><td>${escapeHtml(record.bucket)}</td></tr>`,
      )
      .join("\n");
    return {
      fileName: `pappy-${bucket}-${stamp}.html`,
      mimeType: "text/html",
      content: `<!doctype html><meta charset="utf-8"><title>Pappy Omega Mini · ${escapeHtml(bucket)}</title><h1>Pappy Omega Mini · ${escapeHtml(bucket)}</h1><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>URL</th><th>Title</th><th>Bucket</th></tr></thead><tbody>${rows}</tbody></table>`,
    };
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
