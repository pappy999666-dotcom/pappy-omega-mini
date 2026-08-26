import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WhatsAppMediaPayload } from "./media-payload.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 30_000;

type A2vExpected = "music" | "image/video";
interface A2vCacheEntry { media: WhatsAppMediaPayload; createdAt: number; }
const a2vCache = new Map<string, A2vCacheEntry>();

function cacheKey(workspaceId: string, sessionId: string, chatJid: string): string {
  return `${workspaceId}\u0000${sessionId}\u0000${chatJid}`;
}

function prune(now = Date.now()): void {
  for (const [key, value] of a2vCache) if (now - value.createdAt > CACHE_TTL_MS) a2vCache.delete(key);
  while (a2vCache.size > MAX_CACHE_ENTRIES) {
    const oldest = a2vCache.keys().next().value;
    if (typeof oldest !== "string") break;
    a2vCache.delete(oldest);
  }
}

function mediaLabel(media: WhatsAppMediaPayload): "music" | "image/video" {
  return media.kind === "audio" ? "music" : "image/video";
}

function extensionFor(media: WhatsAppMediaPayload): string {
  if (media.kind === "video") return ".mp4";
  if (media.kind === "image") return media.mimeType?.includes("png") ? ".png" : media.mimeType?.includes("webp") ? ".webp" : ".jpg";
  if (media.mimeType?.includes("mpeg") || media.fileName?.toLowerCase().endsWith(".mp3")) return ".mp3";
  if (media.mimeType?.includes("wav")) return ".wav";
  return ".ogg";
}

function runFfmpeg(args: string[], directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { cwd: directory, stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Audio injection timed out.")); }, FFMPEG_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(errors.join("").toString().trim().slice(-800) || `FFmpeg exited with code ${code ?? "unknown"}.`)));
  });
}

export async function mergeAudioWithVisual(visual: WhatsAppMediaPayload, audio: WhatsAppMediaPayload): Promise<WhatsAppMediaPayload> {
  if (visual.kind !== "image" && visual.kind !== "video") throw new Error("a2v needs an image or video as the visual media.");
  if (audio.kind !== "audio") throw new Error("a2v needs music or a voice note as the audio media.");
  if (!visual.bytes.length || !audio.bytes.length) throw new Error("The selected media is empty.");
  if (visual.bytes.length > MAX_MEDIA_BYTES || audio.bytes.length > MAX_MEDIA_BYTES) throw new Error("The selected media exceeds the safe size limit.");
  const directory = await mkdtemp(join(tmpdir(), `pappy-a2v-${randomUUID()}-`));
  const visualPath = join(directory, `visual${extensionFor(visual)}`);
  const audioPath = join(directory, `audio${extensionFor(audio)}`);
  const outputPath = join(directory, "pappy-a2v.mp4");
  try {
    await writeFile(visualPath, visual.bytes);
    await writeFile(audioPath, audio.bytes);
    const visualArgs = visual.kind === "image" ? ["-loop", "1", "-framerate", "30", "-i", visualPath] : ["-i", visualPath];
    await runFfmpeg(["-y", ...visualArgs, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", "-f", "mp4", outputPath], directory);
    const info = await stat(outputPath);
    if (!info.size || info.size > MAX_MEDIA_BYTES) throw new Error("The a2v output exceeds the safe size limit.");
    return { kind: "video", bytes: await readFile(outputPath), mimeType: "video/mp4", fileName: "pappy-a2v.mp4" };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stageA2v(workspaceId: string, sessionId: string, chatJid: string, media: WhatsAppMediaPayload): Promise<{ state: "cached" | "wrong-order" | "merged"; expected: A2vExpected; media?: WhatsAppMediaPayload }> {
  prune();
  if (media.kind !== "audio" && media.kind !== "image" && media.kind !== "video") throw new Error("Reply to music, a voice note, an image, or a video with a2v.");
  const key = cacheKey(workspaceId, sessionId, chatJid);
  const previous = a2vCache.get(key);
  if (!previous) {
    a2vCache.set(key, { media, createdAt: Date.now() });
    return { state: "cached", expected: media.kind === "audio" ? "image/video" : "music" };
  }
  const previousLabel = mediaLabel(previous.media);
  const currentLabel = mediaLabel(media);
  if (previousLabel === currentLabel) return { state: "wrong-order", expected: previousLabel === "music" ? "image/video" : "music" };
  const merged = previousLabel === "music" ? await mergeAudioWithVisual(media, previous.media) : await mergeAudioWithVisual(previous.media, media);
  a2vCache.delete(key);
  return { state: "merged", expected: "music", media: merged };
}

export function a2vUsageText(prefix: string): string {
  return [`⌬ ⤷ *A2V USAGE* ⚙︎`, "", "─────────────", `⎔ Command     · ⇆ ${prefix}a2v`, "─────────────", "» *How to use:*", `· Reply to music or a voice note with ${prefix}a2v, then reply to an image or video with ${prefix}a2v.`, `· Or reply to an image/video first, then reply to music or a voice note with ${prefix}a2v.`, "", "» *Note:* The first media is cached for 5 minutes and the second media must be the opposite type."].join("\n");
}

export function a2vCacheStatusText(expected: A2vExpected, prefix: string): string {
  return ["⌬ ⤷ *A2V MEDIA CACHED* ⚙︎", "", "─────────────", `⎔ Status      · ⇆ Waiting for ${expected}`, "⎔ Cache       · ⇆ Valid for 5 minutes", `⎔ Next        · ⇆ Reply to the opposite media with ${prefix}a2v`].join("\n");
}

export function a2vMergedText(): string {
  return ["⌬ ⤷ *A2V MEDIA READY* ⚙︎", "", "─────────────", "⎔ Output      · ⇆ MP4 video with injected audio", "⎔ Status      · ⇆ Delivered"].join("\n");
}

export function a2vWrongOrderText(expected: A2vExpected): string {
  return `⛔ A2V needs ${expected} next. The cached media is still valid for 5 minutes.`;
}

export function clearA2vCacheForTests(): void { a2vCache.clear(); }
export function a2vCacheSizeForTests(): number { prune(); return a2vCache.size; }
export const A2V_CACHE_TTL_MS = CACHE_TTL_MS;
