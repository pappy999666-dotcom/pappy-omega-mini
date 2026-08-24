import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { attachRedisErrorHandler } from "../core/redis-events.js";
import {
  LinkBucketStore,
  type LinkBucket,
  type LinkRecord,
} from "./link-bucket-store.js";

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
  const redis = attachRedisErrorHandler(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 }),
    "link-export",
  );
  try {
    const store = new LinkBucketStore(redis);
    const records: LinkRecord[] = [];
    let cursor = 0;
    do {
      const page = await store.list(workspaceId, bucket, cursor, 500);
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== 0);

    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    if (format === "txt")
      return {
        fileName: `pappy-${bucket}-${stamp}.txt`,
        mimeType: "text/plain",
        content:
          records.map((record) => record.canonicalUrl).join("\n") ||
          "No links in this bucket.\n",
      };

    const cards = records.length
      ? records.map(renderCard).join("\n")
      : `<section class="empty">No links in this bucket.</section>`;
    const bucketLabel = bucket.toUpperCase();
    return {
      fileName: `pappy-${bucket}-${stamp}.html`,
      mimeType: "text/html",
      content: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pappy Omega Mini · ${escapeHtml(bucketLabel)}</title>
<style>
:root{color-scheme:dark;--bg:#070b12;--panel:#101827;--line:#23324b;--text:#e7edf7;--muted:#91a0b8;--accent:#6ee7b7;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#070b12,#0b1220);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px}
main{max-width:1180px;margin:0 auto}.eyebrow{color:var(--accent);font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.header{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:24px}.header h1{font-size:clamp(24px,4vw,42px);margin:6px 0}.summary{color:var(--muted);margin:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}.card{position:relative;overflow:hidden;background:rgba(16,24,39,.92);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 12px 30px rgba(0,0,0,.18)}.card:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--accent)}.card.validating:before{background:var(--warn)}.card.dead:before{background:#fb7185}.card.retryable-error:before{background:#f97316}.card-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.title{font-weight:700;font-size:17px;overflow-wrap:anywhere}.status{border:1px solid var(--line);border-radius:999px;color:var(--accent);font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 8px;white-space:nowrap}.status.validating{color:var(--warn)}.status.dead{color:#fb7185}.status.retryable-error{color:#f97316}.url{display:block;color:#9bdcff;margin:14px 0;overflow-wrap:anywhere;text-decoration:none}.url:hover{text-decoration:underline}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}.meta div{border-top:1px solid var(--line);padding-top:8px}.label{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.value{display:block;margin-top:3px;overflow-wrap:anywhere}.empty{border:1px dashed var(--line);border-radius:16px;color:var(--muted);padding:34px;text-align:center}@media(max-width:560px){body{padding:16px}.header{display:block}.meta{grid-template-columns:1fr}}
</style>
</head>
<body><main><header class="header"><div><div class="eyebrow">PAPPY OMEGA MINI · VALIDATOR HUB</div><h1>${escapeHtml(bucketLabel)} LINKS</h1><p class="summary">${records.length} link${records.length === 1 ? "" : "s"} · exported ${escapeHtml(new Date().toISOString())}</p></div></header><div class="grid">${cards}</div></main></body></html>`,
    };
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function renderCard(record: LinkRecord): string {
  const title = record.metadata?.title || "Untitled WhatsApp group";
  const memberCount =
    record.metadata?.memberCount === undefined
      ? "—"
      : String(record.metadata.memberCount);
  const status = record.metadata?.validationState ?? record.metadata?.joinClassification ?? record.bucket;
  const statusClass = status.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const checked = record.lastCheckedAt
    ? new Date(record.lastCheckedAt).toISOString()
    : "Not checked";
  const firstSeen = new Date(record.firstSeenAt).toISOString();
  return `<article class="card ${escapeHtml(statusClass)}"><div class="card-head"><div><div class="eyebrow">WHATSAPP GROUP</div><div class="title">${escapeHtml(title)}</div></div><span class="status ${escapeHtml(statusClass)}">${escapeHtml(status)}</span></div><a class="url" href="${escapeHtml(record.canonicalUrl)}">${escapeHtml(record.canonicalUrl)}</a><div class="meta"><div><span class="label">Members</span><span class="value">${escapeHtml(memberCount)}</span></div><div><span class="label">Duplicates</span><span class="value">${escapeHtml(String(record.duplicateCount))}</span></div><div><span class="label">First seen</span><span class="value">${escapeHtml(firstSeen)}</span></div><div><span class="label">Last checked</span><span class="value">${escapeHtml(checked)}</span></div></div></article>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
