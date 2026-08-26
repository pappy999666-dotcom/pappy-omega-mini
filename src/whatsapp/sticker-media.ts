import { runBoundedSubprocess } from "../core/subprocess.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { WhatsAppMediaPayload } from "./media-payload.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 20_000;
const MAX_ANIMATED_STICKER_FRAMES = 180;

async function runFfmpeg(input: Buffer, args: string[]): Promise<Buffer> {
  const result = await runBoundedSubprocess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args], {
    input,
    timeoutMs: FFMPEG_TIMEOUT_MS,
    maxStdoutBytes: MAX_OUTPUT_BYTES,
    maxStderrBytes: 8 * 1024,
    errorPrefix: "Sticker media conversion",
  });
  return result.stdout;
}

async function runFfmpegFromDirectory(directory: string, args: string[]): Promise<Buffer> {
  const result = await runBoundedSubprocess("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    cwd: directory,
    timeoutMs: FFMPEG_TIMEOUT_MS,
    maxStdoutBytes: MAX_OUTPUT_BYTES,
    maxStderrBytes: 8 * 1024,
    errorPrefix: "Sticker media conversion",
  });
  return result.stdout;
}

async function animatedStickerToMp4(input: Buffer, pages: number): Promise<Buffer> {
  if (!Number.isInteger(pages) || pages < 2)
    throw new Error("The sticker does not contain a valid animated frame sequence.");
  if (pages > MAX_ANIMATED_STICKER_FRAMES)
    throw new Error("The animated sticker exceeds the safe frame limit.");
  const directory = await mkdtemp(join(tmpdir(), "pappy-cs-"));
  try {
    for (let page = 0; page < pages; page += 1) {
      const frame = await sharp(input, { animated: true, page, pages: 1 })
        .png()
        .toBuffer();
      if (!frame.length) throw new Error("An animated sticker frame was empty.");
      await writeFile(join(directory, `frame-${String(page).padStart(4, "0")}.png`), frame);
    }
    return await runFfmpegFromDirectory(directory, [
      "-framerate", "15", "-i", "frame-%04d.png",
      "-movflags", "frag_keyframe+empty_moov", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", "pipe:1",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resizeOptions() {
  return {
    width: 512,
    height: 512,
    fit: "contain" as const,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  };
}

export async function convertMediaToSticker(media: WhatsAppMediaPayload): Promise<WhatsAppMediaPayload> {
  if (media.kind === "video") {
    const bytes = await runFfmpeg(media.bytes, [
      "-vf", "fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p",
      "-an", "-loop", "0", "-c:v", "libwebp", "-q:v", "55", "-compression_level", "4", "-f", "webp", "pipe:1",
    ]);
    return { kind: "sticker", bytes, mimeType: "image/webp", fileName: "pappy-sticker.webp" };
  }
  if (media.kind !== "image") throw new Error("Reply to an image, GIF, or video to create a sticker.");
  const image = sharp(media.bytes, { animated: true });
  const metadata = await image.metadata();
  const bytes = await image.resize(resizeOptions()).webp({ quality: 84, effort: 4, loop: metadata.pages && metadata.pages > 1 ? 0 : undefined }).toBuffer();
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw new Error("The converted sticker exceeded the safe size limit.");
  return { kind: "sticker", bytes, mimeType: "image/webp", fileName: "pappy-sticker.webp" };
}

export async function convertStickerToMedia(media: WhatsAppMediaPayload): Promise<WhatsAppMediaPayload> {
  if (media.kind !== "sticker") throw new Error("Reply to a sticker with .cs to convert it back to media.");
  const metadata = await sharp(media.bytes, { animated: true }).metadata();
  if (metadata.pages && metadata.pages > 1) {
    const bytes = await animatedStickerToMp4(media.bytes, metadata.pages);
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES)
      throw new Error("The converted video exceeded the safe size limit.");
    return { kind: "video", bytes, mimeType: "video/mp4", fileName: "pappy-sticker.mp4" };
  }
  const bytes = await sharp(media.bytes).png().toBuffer();
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw new Error("The converted media exceeded the safe size limit.");
  return { kind: "image", bytes, mimeType: "image/png", fileName: "pappy-sticker.png" };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character] ?? character);
}

function graphemes(value: string): string[] {
  try {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => {
        segment(input: string): Iterable<{ segment: string }>;
      };
    }).Segmenter;
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment);
  } catch {
    // Fall back to code points on runtimes without Intl.Segmenter.
  }
  return Array.from(value);
}

function wrapText(value: string, maxChars = 22, maxLines = 7): string[] {
  const lines: string[] = [];
  let current = "";
  const paragraphs = value.trim().split(/\r?\n/u);
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) {
      if (current) lines.push(current);
      current = "";
      continue;
    }
    for (const word of words) {
      const pieces = graphemes(word);
      if (pieces.length > maxChars) {
        if (current) lines.push(current);
        for (let index = 0; index < pieces.length; index += maxChars) lines.push(pieces.slice(index, index + maxChars).join(""));
        current = "";
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (graphemes(candidate).length > maxChars) {
        if (current) lines.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) lines.push(current);
    current = "";
  }
  return lines.slice(0, maxLines);
}

function isEmojiGrapheme(value: string): boolean {
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Emoji_Component}/u.test(value);
}

function stickerTextRuns(line: string): string {
  return graphemes(line).map((part) => `<tspan font-family="${isEmojiGrapheme(part) ? "Noto Color Emoji" : "DejaVu Sans"}">${escapeXml(part)}</tspan>`).join("");
}

export async function renderTextSticker(input: { text: string; profilePicture?: Buffer; senderName?: string }): Promise<WhatsAppMediaPayload> {
  const lines = wrapText(input.text, 20, 6);
  if (!lines.length) throw new Error("Add text or reply to a text/emoji message to create a sticker.");
  const emojiOnly = lines.every((line) => graphemes(line).every(isEmojiGrapheme));
  const fontSize = emojiOnly ? 78 : 46;
  const lineGap = emojiOnly ? 86 : 64;
  const firstBaseline = emojiOnly ? 560 - ((lines.length - 1) * lineGap) / 2 : 438 - ((lines.length - 1) * lineGap) / 2;
  const textSvg = lines.map((line, index) => `<text x="512" y="${firstBaseline + index * lineGap}" text-anchor="middle" font-family="DejaVu Sans" font-size="${fontSize}" font-weight="700" fill="#172033">${stickerTextRuns(line)}</text>`).join("");
  let avatar = "";
  if (input.profilePicture) {
    try {
      avatar = `data:image/png;base64,${(await sharp(input.profilePicture, { limitInputPixels: 20_000_000 }).resize(156, 156, { fit: "cover" }).png().toBuffer()).toString("base64")}`;
    } catch {
      avatar = "";
    }
  }
  const avatarMarkup = avatar
    ? `<image href="${avatar}" x="434" y="72" width="156" height="156" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<circle cx="512" cy="150" r="78" fill="#dbe7f5"/><text x="512" y="178" text-anchor="middle" font-family="DejaVu Sans" font-size="68" fill="#41536b">●</text>`;
  const senderName = escapeXml((input.senderName ?? "You").slice(0, 32));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="16" stdDeviation="15" flood-color="#243247" flood-opacity="0.24"/></filter><clipPath id="avatarClip"><circle cx="512" cy="150" r="78"/></clipPath></defs>
  <rect width="1024" height="1024" fill="transparent"/>
  <rect x="92" y="76" width="840" height="822" rx="92" fill="#fffdf9" stroke="#1b2635" stroke-width="8" filter="url(#shadow)"/>
  <circle cx="512" cy="150" r="84" fill="#dbe7f5" stroke="#1b2635" stroke-width="7"/>
  ${avatarMarkup}
  <text x="512" y="272" text-anchor="middle" font-family="DejaVu Sans" font-size="29" font-weight="700" fill="#31435a">${senderName}</text>
  <path d="M146 326 Q146 292 180 292 H844 Q878 292 878 326 V754 Q878 788 844 788 H544 L456 852 V788 H180 Q146 788 146 754Z" fill="#edf4ff" stroke="#1b2635" stroke-width="7"/>
  <text x="512" y="356" text-anchor="middle" font-family="DejaVu Sans" font-size="23" letter-spacing="4" fill="#6a7890">PAPPY OMEGA MINI</text>
  ${textSvg}
  <text x="512" y="734" text-anchor="middle" font-family="DejaVu Sans" font-size="25" fill="#6a7890">quoted message</text>
</svg>`;
  const bytes = await sharp(Buffer.from(svg), { limitInputPixels: 20_000_000 }).png().toBuffer();
  const stickerBytes = await sharp(bytes).resize(resizeOptions()).webp({ quality: 88, effort: 4 }).toBuffer();
  if (!stickerBytes.length || stickerBytes.length > MAX_OUTPUT_BYTES) throw new Error("The generated text sticker exceeded the safe size limit.");
  return { kind: "sticker", bytes: stickerBytes, mimeType: "image/webp", fileName: "pappy-text-sticker.webp" };
}
