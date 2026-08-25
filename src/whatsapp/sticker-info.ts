import sharp from "sharp";
import type { WhatsAppMediaPayload } from "./media-payload.js";

export interface StickerInformation {
  bytes: number;
  mimeType: string;
  format?: string;
  width?: number;
  height?: number;
  frames?: number;
  animated: boolean;
  hasAlpha?: boolean;
  packName?: string;
  publisher?: string;
  emojis: string[];
}

function readExifJson(bytes: Buffer): Record<string, unknown> | undefined {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) return undefined;
    if (type === "EXIF") {
      const payload = bytes.subarray(offset + 8, offset + 8 + size);
      const prefix = Buffer.from("Exif\0\0", "ascii");
      const json = payload.subarray(0, prefix.length).equals(prefix) ? payload.subarray(prefix.length).toString("utf8") : payload.toString("utf8");
      try {
        const parsed = JSON.parse(json) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
      } catch {
        return undefined;
      }
    }
    offset = end;
  }
  return undefined;
}

export async function inspectSticker(media: WhatsAppMediaPayload): Promise<StickerInformation> {
  if (media.kind !== "sticker") throw new Error("Reply to a sticker to view its information.");
  const metadata = await sharp(media.bytes, { animated: true }).metadata();
  const exif = readExifJson(media.bytes);
  const emojis = Array.isArray(exif?.emojis) ? exif.emojis.filter((value): value is string => typeof value === "string").slice(0, 8) : [];
  return {
    bytes: media.bytes.length,
    mimeType: media.mimeType ?? "image/webp",
    ...(metadata.format ? { format: metadata.format } : {}),
    ...(metadata.width ? { width: metadata.width } : {}),
    ...(metadata.height ? { height: metadata.height } : {}),
    ...(metadata.pages ? { frames: metadata.pages } : {}),
    animated: Boolean(metadata.pages && metadata.pages > 1),
    ...(metadata.hasAlpha !== undefined ? { hasAlpha: metadata.hasAlpha } : {}),
    ...(typeof exif?.["sticker-pack-name"] === "string" ? { packName: exif["sticker-pack-name"].slice(0, 64) } : {}),
    ...(typeof exif?.["sticker-pack-publisher"] === "string" ? { publisher: exif["sticker-pack-publisher"].slice(0, 64) } : {}),
    emojis,
  };
}
