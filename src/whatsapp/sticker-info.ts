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

function parseJson(value: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
      if (payload.subarray(0, prefix.length).equals(prefix)) {
        const legacy = parseJson(payload.subarray(prefix.length));
        if (legacy) return legacy;
      }
      // Omega-V1 stores the JSON in a little-endian TIFF IFD entry with the
      // WhatsApp tag 0x5741 (WA), type UNDEFINED (7).
      if (payload.length >= 10 && payload.subarray(0, 2).toString("ascii") === "II" && payload.readUInt16LE(2) === 0x002a) {
        const ifdOffset = payload.readUInt32LE(4);
        if (ifdOffset + 2 <= payload.length) {
          const entryCount = payload.readUInt16LE(ifdOffset);
          for (let index = 0; index < entryCount; index += 1) {
            const entry = ifdOffset + 2 + index * 12;
            if (entry + 12 > payload.length) break;
            const tag = payload.readUInt16LE(entry);
            const fieldType = payload.readUInt16LE(entry + 2);
            const count = payload.readUInt32LE(entry + 4);
            const valueOffset = payload.readUInt32LE(entry + 8);
            if (tag !== 0x5741 || fieldType !== 7 || valueOffset + count > payload.length) continue;
            const parsed = parseJson(payload.subarray(valueOffset, valueOffset + count));
            if (parsed) return parsed;
          }
        }
      }
      return parseJson(payload);
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
