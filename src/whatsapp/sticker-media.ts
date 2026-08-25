import { spawn } from "node:child_process";
import sharp from "sharp";
import type { WhatsAppMediaPayload } from "./media-payload.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 20_000;

function runFfmpeg(input: Buffer, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Sticker media conversion timed out."));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("Converted sticker media exceeded the safe size limit."));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(output));
      reject(new Error(errors.join("").toString().trim().slice(-600) || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(input);
  });
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
    const bytes = await runFfmpeg(media.bytes, [
      "-movflags", "frag_keyframe+empty_moov", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", "pipe:1",
    ]);
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

export async function renderTextSticker(input: { text: string; profilePicture?: Buffer }): Promise<WhatsAppMediaPayload> {
  const lines = wrapText(input.text);
  if (!lines.length) throw new Error("Add text or reply to a text/emoji message to create a sticker.");
  const textSvg = lines.map((line, index) => `<text x="512" y="${390 + index * 74}" text-anchor="middle" font-family="DejaVu Sans, Noto Color Emoji, sans-serif" font-size="52" font-weight="700" fill="#172033">${escapeXml(line)}</text>`).join("");
  const avatar = input.profilePicture
    ? `data:image/png;base64,${(await sharp(input.profilePicture).resize(180, 180, { fit: "cover" }).png().toBuffer()).toString("base64")}`
    : "";
  const avatarMarkup = avatar
    ? `<image href="${avatar}" x="422" y="95" width="180" height="180" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<text x="512" y="210" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="82" fill="#172033">✦</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#26314b" flood-opacity="0.22"/></filter><clipPath id="avatarClip"><circle cx="512" cy="185" r="90"/></clipPath></defs>
  <rect width="1024" height="1024" fill="transparent"/>
  <rect x="76" y="72" width="872" height="820" rx="116" fill="#fffdf8" stroke="#172033" stroke-width="10" filter="url(#shadow)"/>
  <circle cx="512" cy="185" r="96" fill="#dce8ff" stroke="#172033" stroke-width="8"/>
  ${avatarMarkup}
  <path d="M164 330 Q164 296 198 296 H826 Q860 296 860 330 V790 Q860 824 826 824 H500 L408 884 V824 H198 Q164 824 164 790Z" fill="#e8f0ff" stroke="#172033" stroke-width="8"/>
  <text x="512" y="355" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="25" letter-spacing="5" fill="#52617c">PAPPY OMEGA MINI</text>
  ${textSvg}
  <text x="512" y="758" text-anchor="middle" font-family="DejaVu Sans, Noto Color Emoji, sans-serif" font-size="30" fill="#52617c">quoted message sticker</text>
</svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const stickerBytes = await sharp(bytes).resize(resizeOptions()).webp({ quality: 86, effort: 4 }).toBuffer();
  if (!stickerBytes.length || stickerBytes.length > MAX_OUTPUT_BYTES) throw new Error("The generated text sticker exceeded the safe size limit.");
  return { kind: "sticker", bytes: stickerBytes, mimeType: "image/webp", fileName: "pappy-text-sticker.webp" };
}
