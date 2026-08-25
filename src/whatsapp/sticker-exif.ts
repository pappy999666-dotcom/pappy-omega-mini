const MAX_STICKER_BYTES = 1_000_000;

function readUint32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function stripExifChunks(buffer: Buffer): Buffer {
  if (!isWebp(buffer)) throw new Error("Sticker output is not a valid WebP file.");
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = readUint32LE(buffer, offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length) throw new Error("Sticker WebP container is truncated.");
    if (type !== "EXIF") chunks.push(buffer.subarray(offset, end));
    offset = end;
  }
  if (offset !== buffer.length) throw new Error("Sticker WebP container has an invalid chunk boundary.");
  return Buffer.concat([buffer.subarray(0, 12), ...chunks]);
}

export function applyStickerPackMetadata(
  buffer: Buffer,
  input: { packName: string; publisher?: string; emojis?: string[] } = { packName: "PAPPY OMEGA MINI" },
): Buffer {
  const base = stripExifChunks(buffer);
  const metadata = Buffer.from(JSON.stringify({
    "sticker-pack-id": "pappy-omega-mini",
    "sticker-pack-name": input.packName.slice(0, 64),
    "sticker-pack-publisher": (input.publisher ?? "PAPPY OMEGA MINI").slice(0, 64),
    emojis: (input.emojis ?? []).slice(0, 8),
  }), "utf8");
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), metadata]);
  const chunk = Buffer.alloc(8);
  chunk.write("EXIF", 0, 4, "ascii");
  chunk.writeUInt32LE(exifPayload.length, 4);
  const padding = exifPayload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const result = Buffer.concat([base, chunk, exifPayload, padding]);
  let offset = 12;
  while (offset + 18 <= result.length) {
    const type = result.subarray(offset, offset + 4).toString("ascii");
    const size = result.readUInt32LE(offset + 4);
    if (type === "VP8X" && size >= 10) {
      // VP8X flags: 0x08 advertises that an EXIF chunk is present.
      result[offset + 8] = (result[offset + 8] ?? 0) | 0x08;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  result.writeUInt32LE(result.length - 8, 4);
  if (result.length > MAX_STICKER_BYTES) throw new Error("Sticker metadata made the WebP exceed WhatsApp's safe sticker size limit.");
  return result;
}
