import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import { pappyHeader } from "./response-designs.js";

export type PlayMode = "audio" | "video";

export interface PlayMetadata {
  title: string;
  uploader?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  webpageUrl?: string;
  sourceUrl: string;
  provider?: "yt-dlp" | "piped";
  sourceId?: string;
}

export interface LyricsResult {
  title: string;
  artist: string;
  album?: string;
  plainLyrics: string;
  syncedLyrics?: string;
}

const COMMAND_TIMEOUT_MS = 45_000;
const LYRICS_TIMEOUT_MS = 8_000;
const MAX_LYRICS_CHARS = 12_000;
const MAX_MEDIA_BYTES = Math.max(1_000_000, Number(process.env.PLAY_MAX_BYTES ?? process.env.MAX_MEDIA_BYTES ?? 50 * 1024 * 1024));
const MAX_MEDIA_SIZE_ARG = process.env.PLAY_MAX_FILESIZE?.trim() || "50M";
const YT_DLP_BIN = process.env.YT_DLP_BIN?.trim() || "yt-dlp";
const FFPROBE_BIN = process.env.FFPROBE_BIN?.trim() || "ffprobe";
const MAX_CONCURRENT_MEDIA_JOBS = 2;
const PIPED_API_BASES = (process.env.PIPED_API_BASES ?? "https://api.piped.private.coffee,https://pipedapi.kavin.rocks,https://pipedapi.leptons.xyz")
  .split(",")
  .map((value) => value.trim().replace(/\/$/u, ""))
  .filter(Boolean);

let activeMediaJobs = 0;
const mediaJobWaiters: Array<() => void> = [];

export async function withMediaDownloadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeMediaJobs >= MAX_CONCURRENT_MEDIA_JOBS) await new Promise<void>((resolve) => mediaJobWaiters.push(resolve));
  activeMediaJobs += 1;
  try {
    return await task();
  } finally {
    activeMediaJobs -= 1;
    mediaJobWaiters.shift()?.();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("The media source did not respond before the download timeout."));
    }, timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function runExternalCommand(binary: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  let childProcess: ReturnType<typeof spawn> | undefined;
  return withTimeout(new Promise((resolve, reject) => {
    childProcess = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const child = childProcess;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim().slice(-800) || `yt-dlp exited with code ${code ?? "unknown"}`)));
  }), timeoutMs, () => { childProcess?.kill("SIGKILL"); });
}

function runCommand(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return runExternalCommand(YT_DLP_BIN, args, timeoutMs);
}

function sourceFor(input: string): string {
  const value = input.trim();
  return /^https?:\/\//iu.test(value) ? value : `ytsearch1:${value}`;
}

function parseMetadata(raw: string, sourceUrl: string): PlayMetadata {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const duration = Number(parsed.duration);
  return {
    title: String(parsed.title ?? parsed.fulltitle ?? "Untitled"),
    ...(parsed.uploader ? { uploader: String(parsed.uploader) } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: Math.round(duration) } : {}),
    ...(parsed.thumbnail ? { thumbnailUrl: String(parsed.thumbnail) } : {}),
    ...(parsed.webpage_url ? { webpageUrl: String(parsed.webpage_url) } : {}),
    sourceUrl,
  };
}

function videoIdFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/(?:youtube\.com|youtu\.be)$/iu.test(parsed.hostname.replace(/^www\./iu, ""))) return undefined;
    return parsed.searchParams.get("v") ?? parsed.pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

async function pipedJson(path: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const base of PIPED_API_BASES) {
    try {
      const response = await withTimeout(fetch(`${base}${path}`, { headers: { "User-Agent": "Pappy-Omega-Mini/1.0" } }), 12_000, () => undefined);
      if (!response.ok) throw new Error(`Piped HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No Piped API instance responded.");
}

async function resolvePipedMetadata(input: string): Promise<PlayMetadata> {
  const search = await pipedJson(`/search?q=${encodeURIComponent(input.trim())}&filter=videos`);
  const items = Array.isArray(search.items) ? search.items as Array<Record<string, unknown>> : [];
  const item = items.find((candidate) => candidate.type === "stream" && typeof candidate.url === "string");
  if (!item) throw new Error("No public Piped result was found for that search.");
  const itemUrl = String(item.url);
  const id = videoIdFromUrl(`https://www.youtube.com${itemUrl}`) ?? itemUrl.match(/[?&]v=([^&]+)/u)?.[1];
  if (!id) throw new Error("The public search result did not contain a usable video identity.");
  return {
    title: String(item.title ?? input),
    ...(item.uploaderName ? { uploader: String(item.uploaderName) } : {}),
    ...(Number.isFinite(Number(item.duration)) && Number(item.duration) > 0 ? { durationSeconds: Math.round(Number(item.duration)) } : {}),
    ...(item.thumbnail ? { thumbnailUrl: String(item.thumbnail) } : {}),
    webpageUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceUrl: input,
    provider: "piped",
    sourceId: id,
  };
}

export async function resolvePlayMetadata(input: string): Promise<PlayMetadata> {
  const source = sourceFor(input);
  try {
    const result = await runCommand(["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", source], 20_000);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error("No media metadata was returned for that search.");
    return parseMetadata(line, source);
  } catch (primaryError) {
    if (/^https?:\/\//iu.test(input.trim())) throw primaryError;
    return resolvePipedMetadata(input);
  }
}

async function downloadPipedMedia(metadata: PlayMetadata, mode: PlayMode): Promise<WhatsAppMediaPayload> {
  if (!metadata.sourceId) throw new Error("Piped media identity is missing.");
  const streamPayload = await pipedJson(`/streams/${encodeURIComponent(metadata.sourceId)}`);
  const streams = mode === "audio" ? streamPayload.audioStreams : streamPayload.videoStreams;
  const candidates = Array.isArray(streams) ? streams as Array<Record<string, unknown>> : [];
  const candidate = candidates
    .filter((item) => typeof item.url === "string" && item.url && item.videoOnly !== true)
    .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0];
  if (!candidate?.url) throw new Error(`Piped did not expose a playable ${mode} stream.`);
  const response = await withTimeout(fetch(String(candidate.url), { headers: { "User-Agent": "Pappy-Omega-Mini/1.0" } }), 30_000, () => undefined);
  if (!response.ok) throw new Error(`Piped stream HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_MEDIA_BYTES) throw new Error("The media output exceeds the configured size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error("The media output exceeds the configured size limit.");
  const directory = await mkdtemp(join(tmpdir(), `pappy-piped-${randomUUID()}-`));
  const filePath = join(directory, mode === "audio" ? "media.m4a" : "media.mp4");
  try {
    await writeFile(filePath, bytes);
    await runExternalCommand(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], 10_000);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    kind: mode,
    bytes,
    mimeType: mode === "audio" ? "audio/mp4" : "video/mp4",
    fileName: `${metadata.title.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 80) || "pappy-media"}.${mode === "audio" ? "m4a" : "mp4"}`,
    ...(mode === "audio" ? { ptt: false } : {}),
  };
}

function isMediaFile(name: string, mode: PlayMode): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".part") || lower.endsWith(".ytdl") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) return false;
  return mode === "audio" ? /\.(mp3|m4a|opus|ogg|wav|flac)$/u.test(lower) : /\.(mp4|mkv|webm|mov|avi)$/u.test(lower);
}

export function buildDownloadArgs(mode: PlayMode, output: string, source: string): string[] {
  const args = ["--no-playlist", "--no-warnings", "--restrict-filenames", "--max-filesize", MAX_MEDIA_SIZE_ARG, "-o", output];
  if (mode === "audio") args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-thumbnail", "--embed-metadata");
  else args.push("-f", "bv*+ba/b", "--merge-output-format", "mp4");
  args.push(source);
  return args;
}

export async function downloadPlay(input: string, mode: PlayMode, resolvedMetadata?: PlayMetadata): Promise<{ metadata: PlayMetadata; media: WhatsAppMediaPayload }> {
  const metadata = resolvedMetadata ?? await resolvePlayMetadata(input);
  if (metadata.provider === "piped") return { metadata, media: await downloadPipedMedia(metadata, mode) };
  const directory = await mkdtemp(join(tmpdir(), `pappy-play-${randomUUID()}-`));
  try {
    const output = join(directory, "media.%(ext)s");
    const args = buildDownloadArgs(mode, output, metadata.webpageUrl ?? input);
    await runCommand(args);
    const files = await readdir(directory);
    const mediaName = files.find((name) => isMediaFile(name, mode));
    if (!mediaName) throw new Error("The media file was not produced by the downloader.");
    const mediaPath = join(directory, mediaName);
    const fileInfo = await stat(mediaPath);
    if (fileInfo.size > MAX_MEDIA_BYTES) throw new Error("The media output exceeds the configured size limit.");
    await runExternalCommand(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mediaPath], 10_000);
    const bytes = await readFile(mediaPath);
    return {
      metadata,
      media: {
        kind: mode,
        bytes,
        mimeType: mode === "audio" ? "audio/mpeg" : "video/mp4",
        fileName: `${metadata.title.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 80) || "pappy-media"}.${mode === "audio" ? "mp3" : "mp4"}`,
        ...(mode === "audio" ? { ptt: false } : {}),
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function fetchLyrics(input: string): Promise<LyricsResult> {
  const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(input.trim())}`;
  const response = await withTimeout(fetch(searchUrl, { headers: { "User-Agent": "Pappy-Omega-Mini/1.0 (lyrics lookup)" } }), LYRICS_TIMEOUT_MS, () => undefined);
  if (!response.ok) throw new Error(response.status === 404 ? "No lyrics were found for that search." : `Lyrics lookup failed with HTTP ${response.status}.`);
  const records = await response.json() as Array<Record<string, unknown>>;
  const record = records.find((value) => typeof value.plainLyrics === "string" && value.plainLyrics.trim()) ?? records[0];
  if (!record || typeof record.plainLyrics !== "string" || !record.plainLyrics.trim()) throw new Error("No lyrics were found for that search.");
  return {
    title: String(record.trackName ?? record.name ?? input),
    artist: String(record.artistName ?? "Unknown artist"),
    ...(record.albumName ? { album: String(record.albumName) } : {}),
    plainLyrics: record.plainLyrics.slice(0, MAX_LYRICS_CHARS),
    ...(typeof record.syncedLyrics === "string" && record.syncedLyrics.trim() ? { syncedLyrics: record.syncedLyrics.slice(0, MAX_LYRICS_CHARS) } : {}),
  };
}

export function playUsageText(): string {
  return [
    ...pappyHeader("play", "PLAY COMMAND USAGE"),
    "⎔ Commands    · ⇆ .play <song or video>",
    "⎔ Video       · ⇆ .video <song or video>",
    "⎔ Lyrics      · ⇆ .lyrics <song title>",
    "─────────────",
    "» *Examples:*",
    "· .play Blinding Lights",
    "· .video Big Buck Bunny",
    "· .lyrics Blinding Lights The Weeknd",
    "─────────────",
    "» *Note:* Metadata is resolved first. Media download begins only after the preview is prepared.",
  ].join("\n");
}

export function buildPlayPreviewText(metadata: PlayMetadata, mode: PlayMode): string {
  const duration = metadata.durationSeconds ? `${Math.floor(metadata.durationSeconds / 60)}m ${metadata.durationSeconds % 60}s` : "Unavailable";
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ${mode === "audio" ? "🎵" : "🎬"} ˎˊ˗  *${mode === "audio" ? "MUSIC" : "VIDEO"} PREVIEW*  ✦`,
    "─────────────",
    `⎔ Title       · ⇆ ${metadata.title.slice(0, 180)}`,
    `⎔ Creator     · ⇆ ${(metadata.uploader ?? "Unknown").slice(0, 120)}`,
    `⎔ Duration    · ⇆ ${duration}`,
    `⎔ Source      · ⇆ ${metadata.webpageUrl ?? metadata.sourceUrl}`,
    "─────────────",
    "» *Action:* Preparing the requested media now.",
    "ℹ️ _Preview resolved before download; failures stay isolated to this request._",
  ].join("\n");
}

export function buildMediaJobText(metadata: PlayMetadata, mode: PlayMode, jobCode: string): string {
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ ⚙︎ ˎˊ˗  *MEDIA JOB*  ✦",
    "─────────────",
    `⎔ Type        · ⇆ ${mode === "audio" ? "Audio" : "Video"}`,
    `⎔ Title       · ⇆ ${metadata.title.slice(0, 180)}`,
    `⎔ Job ID      · ⇆ ${jobCode.slice(0, 80)}`,
    "─────────────",
    "» *Progress:* The isolated worker is downloading this public or authorized source.",
    "» *Delivery:* The media will arrive in this chat when complete.",
  ].join("\n");
}

export function buildLyricsText(lyrics: LyricsResult): string {
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ 🎵 ˎˊ˗  *LYRICS RESULT*  ✦",
    "─────────────",
    `⎔ Title       · ⇆ ${lyrics.title.slice(0, 180)}`,
    `⎔ Artist      · ⇆ ${lyrics.artist.slice(0, 120)}`,
    ...(lyrics.album ? [`⎔ Album       · ⇆ ${lyrics.album.slice(0, 120)}`] : []),
    "─────────────",
    lyrics.plainLyrics,
    "─────────────",
    "ℹ️ _Lyrics provided by the lookup service; availability depends on its catalogue._",
  ].join("\n");
}
