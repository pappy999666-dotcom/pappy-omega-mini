import { firstHttpUrl } from "../preview/default-adapter.js";
import type { PreviewRecord } from "../preview/preview-manager.js";

export interface OutboundPreviewInput {
  text?: string;
  content: Record<string, unknown>;
  existingPreview?: Record<string, unknown>;
  target?: "group-status";
}

/**
 * One shared URL pipeline for every WhatsApp outbound route.
 *
 * URL-only content is intentionally left intact so the active Bailey socket can
 * run its native getUrlInfo -> uploadImage flow. This produces a flowing URL
 * preview with a real highQualityThumbnail instead of a manually injected small
 * jpegThumbnail. Media content is also left intact and is never converted into
 * a standalone preview image.
 */
export async function prepareOutboundContent(
  input: OutboundPreviewInput,
): Promise<Record<string, unknown>> {
  const content = { ...input.content };
  const text = input.text ?? readText(content);
  const url = firstHttpUrl(text ?? "");
  if (!url) return content;

  const hasMedia = ["image", "video", "audio", "document", "sticker"].some(
    (key) => key in content,
  );
  if (hasMedia) return content;

  // Leave URL-only chat and group-status messages untouched. The active Bailey
  // socket now has generateHighQualityLinkPreview enabled, so sendMessage can
  // run its native getUrlInfo -> uploadImage flow and attach a real
  // highQualityThumbnail alongside the flowing URL text. Supplying our own
  // jpegThumbnail here would bypass that upload path and recreate the small
  // preview problem.
  return content;
}

export function buildNativeGroupStatusPreviewContent(
  content: Record<string, unknown>,
  record: PreviewRecord,
): Record<string, unknown> {
  const previewImage = record.thumbnailData
    ? Buffer.from(record.thumbnailData, "base64")
    : record.thumbnailUrl;
  return {
    ...content,
    richPreview: true,
    text: record.canonicalUrl,
    ...(record.title ? { previewTitle: record.title } : {}),
    ...(record.description ? { previewDescription: record.description } : {}),
    ...(previewImage ? { previewImage } : {}),
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
  // Bailey owns the native preview resolver and upload lifecycle on each socket.
}
