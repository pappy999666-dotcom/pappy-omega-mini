const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_ALPHA = 0x10;
const VP8X_FLAG_ANIMATION = 0x02;

type WebpChunk = {
  type: string;
  offset: number;
  size: number;
  end: number;
};

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function readChunks(buffer: Buffer): WebpChunk[] {
  if (!isWebp(buffer)) throw new Error("Sticker output is not a valid WebP file.");
  if (buffer.readUInt32LE(4) !== buffer.length - 8)
    throw new Error("Sticker WebP RIFF size is inconsistent.");
  const chunks: WebpChunk[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length) throw new Error("Sticker WebP container is truncated.");
    chunks.push({ type, offset, size, end });
    offset = end;
  }
  if (offset !== buffer.length || !chunks.length) throw new Error("Sticker WebP container has an invalid chunk boundary.");
  return chunks;
}

function webpDimensions(buffer: Buffer, chunk: WebpChunk): { width: number; height: number } | undefined {
  const start = chunk.offset + 8;
  if (chunk.type === "VP8X" && chunk.size >= 10) {
    return {
      width: 1 + buffer[start + 4]! + (buffer[start + 5]! << 8) + (buffer[start + 6]! << 16),
      height: 1 + buffer[start + 7]! + (buffer[start + 8]! << 8) + (buffer[start + 9]! << 16),
    };
  }
  if (chunk.type === "VP8 " && chunk.size >= 10 && buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
    return {
      width: buffer.readUInt16LE(start + 6) & 0x3fff,
      height: buffer.readUInt16LE(start + 8) & 0x3fff,
    };
  }
  if (chunk.type === "VP8L" && chunk.size >= 5 && buffer[start] === 0x2f) {
    const b1 = buffer[start + 1]!;
    const b2 = buffer[start + 2]!;
    const b3 = buffer[start + 3]!;
    const b4 = buffer[start + 4]!;
    return {
      width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
      height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
    };
  }
  return undefined;
}

function exifJson(buffer: Buffer, chunk: WebpChunk): Record<string, unknown> | undefined {
  if (chunk.type !== "EXIF" || chunk.size < 22) return undefined;
  const start = chunk.offset + 8;
  if (buffer.toString("ascii", start, start + 2) !== "II" || buffer.readUInt16LE(start + 2) !== 0x002a)
    return undefined;
  const ifdOffset = buffer.readUInt32LE(start + 4);
  if (ifdOffset + 2 > chunk.size) return undefined;
  const entries = buffer.readUInt16LE(start + ifdOffset);
  for (let index = 0; index < entries; index += 1) {
    const entry = start + ifdOffset + 2 + index * 12;
    if (entry + 12 > start + chunk.size) return undefined;
    if (buffer.readUInt16LE(entry) !== 0x5741 || buffer.readUInt16LE(entry + 2) !== 7) continue;
    const length = buffer.readUInt32LE(entry + 4);
    const offset = buffer.readUInt32LE(entry + 8);
    if (!length || offset + length > chunk.size) return undefined;
    try {
      const value = JSON.parse(buffer.toString("utf8", start + offset, start + offset + length)) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function validateWhatsAppSticker(
  buffer: Buffer,
  options: { requireMetadata?: boolean } = {},
): void {
  if (!buffer.length || buffer.length > MAX_STICKER_BYTES)
    throw new Error("Sticker output is empty or exceeds WhatsApp's safe sticker size limit.");
  const chunks = readChunks(buffer);
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X");
  const image = chunks.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
  if (!image) throw new Error("Sticker WebP has no decodable VP8 image payload.");
  const dimensions = vp8x ? webpDimensions(buffer, vp8x) : webpDimensions(buffer, image);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 512 || dimensions.height > 512)
    throw new Error("Sticker dimensions must be between 1 and 512 pixels.");
  const exif = chunks.find((chunk) => chunk.type === "EXIF");
  if (options.requireMetadata) {
    if (!vp8x || (buffer[vp8x.offset + 8]! & VP8X_FLAG_EXIF) === 0)
      throw new Error("Sticker WebP is missing the VP8X EXIF feature flag.");
    const metadata = exif ? exifJson(buffer, exif) : undefined;
    if (!metadata || typeof metadata["sticker-pack-name"] !== "string" || typeof metadata["sticker-pack-publisher"] !== "string")
      throw new Error("Sticker WebP is missing valid WhatsApp pack metadata.");
  }
}

function sanitizeId(value: string): string {
  return String(value || "pappy").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48) || "pappy";
}

function stickerJson(input: { packName: string; publisher?: string; emojis?: string[] }): Buffer {
  return Buffer.from(JSON.stringify({
    "sticker-pack-id": `com.pappy.omega.${sanitizeId(input.publisher ?? "pappy")}.${sanitizeId(input.packName)}`,
    "sticker-pack-name": input.packName.slice(0, 64),
    "sticker-pack-publisher": (input.publisher ?? "PAPPY OMEGA MINI").slice(0, 64),
    emojis: (input.emojis ?? []).filter((value): value is string => typeof value === "string").slice(0, 8),
  }), "utf8");
}

/** Build the TIFF/WA tag payload used by native WhatsApp stickers. */
function buildExifChunk(input: { packName: string; publisher?: string; emojis?: string[] }): Buffer {
  const json = stickerJson(input);
  const tiffHeaderSize = 22;
  const tiff = Buffer.alloc(tiffHeaderSize + json.length);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x5741, 10);
  tiff.writeUInt16LE(7, 12);
  tiff.writeUInt32LE(json.length, 14);
  tiff.writeUInt32LE(tiffHeaderSize, 18);
  json.copy(tiff, tiffHeaderSize);

  const chunk = Buffer.alloc(8 + tiff.length);
  chunk.write("EXIF", 0, 4, "ascii");
  chunk.writeUInt32LE(tiff.length, 4);
  tiff.copy(chunk, 8);
  return chunk.length % 2 === 0 ? chunk : Buffer.concat([chunk, Buffer.from([0])]);
}

function updateRiffSize(buffer: Buffer): Buffer {
  const result = Buffer.from(buffer);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export function applyStickerPackMetadata(
  buffer: Buffer,
  input: { packName: string; publisher?: string; emojis?: string[] } = { packName: "PAPPY OMEGA MINI" },
): Buffer {
  const chunks = readChunks(buffer);
  const first = chunks[0]!;
  const exif = buildExifChunk(input);
  const withoutExif = Buffer.concat([
    buffer.subarray(0, 12),
    ...chunks.filter((chunk) => chunk.type !== "EXIF").map((chunk) => buffer.subarray(chunk.offset, chunk.end)),
  ]);
  const remaining = readChunks(withoutExif);
  const vp8x = remaining.find((chunk) => chunk.type === "VP8X");
  let result: Buffer;

  if (vp8x) {
    result = Buffer.from(withoutExif);
    result[vp8x.offset + 8] = result[vp8x.offset + 8]! | VP8X_FLAG_EXIF;
    const animated = (result[vp8x.offset + 8]! & VP8X_FLAG_ANIMATION) !== 0;
    if (animated) {
      result = Buffer.concat([result, exif]);
    } else {
      const insertAt = vp8x.end;
      result = Buffer.concat([result.subarray(0, insertAt), exif, result.subarray(insertAt)]);
    }
  } else {
    const dimensions = webpDimensions(buffer, first);
    if (!dimensions) throw new Error("Sticker dimensions could not be read from WebP output.");
    const hasAlpha = first.type !== "VP8 ";
    const vp8x = Buffer.alloc(18);
    vp8x.write("VP8X", 0, 4, "ascii");
    vp8x.writeUInt32LE(10, 4);
    vp8x.writeUInt32LE(VP8X_FLAG_EXIF | (hasAlpha ? VP8X_FLAG_ALPHA : 0), 8);
    const width = Math.max(1, Math.min(16_777_216, dimensions.width)) - 1;
    const height = Math.max(1, Math.min(16_777_216, dimensions.height)) - 1;
    vp8x.writeUIntLE(width, 12, 3);
    vp8x.writeUIntLE(height, 15, 3);
    result = Buffer.concat([withoutExif.subarray(0, 12), vp8x, exif, withoutExif.subarray(12)]);
  }

  result = updateRiffSize(result);
  if (result.length > MAX_STICKER_BYTES) throw new Error("Sticker metadata made the WebP exceed WhatsApp's safe sticker size limit.");
  validateWhatsAppSticker(result, { requireMetadata: true });
  return result;
}
