import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  createDefaultPreviewManager,
  firstHttpUrl,
} from "../preview/default-adapter.js";
import type { PreviewRecord } from "../preview/preview-manager.js";

export interface OutboundPreviewInput {
  text?: string;
  content: Record<string, unknown>;
  existingPreview?: Record<string, unknown>;
  target?: "group-status";
}

let redis: Redis | undefined;
let manager: ReturnType<typeof createDefaultPreviewManager> | undefined;

function getPreviewManager(): ReturnType<typeof createDefaultPreviewManager> {
  if (manager) return manager;
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  redis.on("error", () => undefined);
  manager = createDefaultPreviewManager(redis);
  return manager;
}
const inFlight = new Map<string, Promise<PreviewRecord>>();

/**
 * One shared URL pipeline for every WhatsApp outbound route.
 *
 * Complete supplied previews are preserved. Incomplete text previews are
 * enriched with resolver metadata and sent through the installed Baileys
 * richPreview path. Media captions are resolved for cache/failure isolation but
 * never receive richPreview, because Baileys requires a top-level text field.
 */
export async function prepareOutboundContent(
  input: OutboundPreviewInput,
): Promise<Record<string, unknown>> {
  const content = { ...input.content };
  const text = input.text ?? readText(content);
  const url = firstHttpUrl(text ?? "");
  if (!url) return content;

  const supplied = input.existingPreview ?? readExistingPreview(content);
  if (isCompletePreview(supplied)) return content;

  let record: PreviewRecord;
  try {
    record = await resolveOnce(url);
  } catch {
    return content;
  }
  const hasMedia = ["image", "video", "audio", "document", "sticker"].some(
    (key) => key in content,
  );
  if (input.target === "group-status" && !hasMedia && !record.fallback) {
    return buildNativeGroupStatusPreviewContent(content, record);
  }
  if (hasMedia) return content;
  const thumbnail = record.thumbnailData
    ? Buffer.from(record.thumbnailData, "base64")
    : undefined;
  return {
    ...content,
    linkPreview: {
      "matched-text": record.canonicalUrl,
      ...(record.title ? { title: record.title } : {}),
      ...(record.description ? { description: record.description } : {}),
      ...(thumbnail ? { jpegThumbnail: thumbnail } : {}),
    },
  };
}

export function buildNativeGroupStatusPreviewContent(
  content: Record<string, unknown>,
  record: PreviewRecord,
): Record<string, unknown> {
  return {
    ...content,
    richPreview: true,
    text: record.canonicalUrl,
    ...(record.title ? { previewTitle: record.title } : {}),
    ...(record.description ? { previewDescription: record.description } : {}),
    ...(record.thumbnailUrl ? { previewImage: record.thumbnailUrl } : {}),
    groupStatus: true,
  };
}

export function readText(content: Record<string, unknown>): string | undefined {
  if (typeof content.text === "string") return content.text;
  if (typeof content.caption === "string") return content.caption;
  return undefined;
}

export function isCompletePreview(
  preview: Record<string, unknown> | undefined,
): boolean {
  if (!preview) return false;
  const title = preview.title ?? preview.previewTitle;
  const description = preview.description ?? preview.previewDescription;
  const image =
    preview.thumbnailUrl ?? preview.previewImage ?? preview.jpegThumbnail;
  return Boolean(title && description && image);
}

async function resolveOnce(url: string): Promise<PreviewRecord> {
  const canonicalUrl = safeCanonicalUrl(url);
  const running = inFlight.get(canonicalUrl);
  if (running) return running;
  const promise = getPreviewManager()
    .resolve(canonicalUrl)
    .finally(() => {
      if (inFlight.get(canonicalUrl) === promise) inFlight.delete(canonicalUrl);
    });
  inFlight.set(canonicalUrl, promise);
  return promise;
}

function safeCanonicalUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function readExistingPreview(
  content: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (content.linkPreview && typeof content.linkPreview === "object")
    return content.linkPreview as Record<string, unknown>;
  if (
    content.richPreview === true &&
    (content.previewTitle || content.previewDescription || content.previewImage)
  ) {
    return {
      previewTitle: content.previewTitle,
      previewDescription: content.previewDescription,
      previewImage: content.previewImage,
    };
  }
  return undefined;
}

export async function closeOutboundPreview(): Promise<void> {
  await redis?.quit().catch(() => undefined);
  redis = undefined;
  manager = undefined;
}
