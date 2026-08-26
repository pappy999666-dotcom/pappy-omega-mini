import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
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
  provider?: "yt-dlp" | "piped" | "noelia";
  sourceId?: string;
  downloadUrl?: string;
  expiresAt?: string;
}

export interface LyricsResult {
  title: string;
  artist: string;
  album?: string;
  plainLyrics: string;
  syncedLyrics?: string;
}

// Keep media failures isolated and responsive; ordinary commands never enter this path.
const COMMAND_TIMEOUT_MS = 20_000;
const PLAY_METADATA_TIMEOUT_MS = 8_000;
const PIPED_REQUEST_TIMEOUT_MS = 5_000;
const PIPED_STREAM_TIMEOUT_MS = 15_000;
const LYRICS_TIMEOUT_MS = 8_000;
const MAX_LYRICS_CHARS = 12_000;
const MAX_MEDIA_BYTES = Math.max(1_000_000, Number(process.env.PLAY_MAX_BYTES ?? process.env.MAX_MEDIA_BYTES ?? 50 * 1024 * 1024));
const MAX_MEDIA_SIZE_ARG = process.env.PLAY_MAX_FILESIZE?.trim() || "50M";
const YT_DLP_BIN = process.env.YT_DLP_BIN?.trim() || "yt-dlp";
const FFMPEG_BIN = process.env.FFMPEG_BIN?.trim() || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN?.trim() || "ffprobe";
const MAX_CONCURRENT_MEDIA_JOBS = 2;
const PIPED_API_BASES = (process.env.PIPED_API_BASES ?? "https://api.piped.private.coffee,https://pipedapi.kavin.rocks,https://pipedapi.leptons.xyz")
  .split(",")
  .map((value) => value.trim().replace(/\/$/u, ""))
  .filter(Boolean);
const DEFAULT_NOELIA_MUSIC_API_BASE = "https://noelia.noeldfa.dpdns.org/api/music";
const NOELIA_REQUEST_TIMEOUT_MS = 15_000;
const NOELIA_FAST_PATH_TIMEOUT_MS = 5_000;
const NOELIA_DOWNLOAD_TIMEOUT_MS = 60_000;

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
      const response = await withTimeout(fetch(`${base}${path}`, { headers: { "User-Agent": "Pappy-Omega-Mini/1.0" } }), PIPED_REQUEST_TIMEOUT_MS, () => undefined);
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

function noeliaApiBase(): string {
  return (process.env.NOELIA_MUSIC_API_BASE?.trim() || DEFAULT_NOELIA_MUSIC_API_BASE).replace(/\/$/u, "");
}

function noeliaDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const candidate = new URL(value);
    const base = new URL(noeliaApiBase());
    if (candidate.protocol !== "https:" || candidate.origin !== base.origin) return undefined;
    return candidate.toString();
  } catch {
    return undefined;
  }
}

async function resolveNoeliaMetadata(input: string): Promise<PlayMetadata> {
  const key = process.env.NOELIA_MUSIC_API_KEY?.trim();
  if (!key) throw new Error("Noelia Music API is not configured.");
  if (/^https?:\/\//iu.test(input.trim())) throw new Error("Noelia search accepts a song query, not a direct URL.");
  const endpoint = `${noeliaApiBase()}/search?q=${encodeURIComponent(input.trim())}`;
  const response = await withTimeout(fetch(endpoint, {
    headers: {
      "x-api-key": key,
      "User-Agent": "Pappy-Omega-Mini/1.0 (music downloader)",
      Accept: "application/json",
    },
  }), NOELIA_REQUEST_TIMEOUT_MS, () => undefined);
  let body: Record<string, unknown> = {};
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    // Keep the provider error below generic and avoid exposing upstream bodies.
  }
  if (!response.ok || body.success !== true) {
    const status = response.status;
    throw new Error(status === 401 ? "Noelia Music API rejected the configured key." : status === 429 ? "Noelia Music API rate limit reached." : status >= 500 ? "Noelia Music API is temporarily unavailable." : String(body.error ?? `Noelia Music API search failed (${status}).`));
  }
  const track = body.track && typeof body.track === "object" ? body.track as Record<string, unknown> : {};
  const downloadUrl = noeliaDownloadUrl(track.downloadUrl);
  if (!downloadUrl) throw new Error("Noelia Music API returned an invalid temporary download URL.");
  const expiresAt = typeof track.expiresAt === "string" ? track.expiresAt : undefined;
  if (expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now())
    throw new Error("Noelia Music API returned an expired download URL.");
  return {
    title: String(track.title ?? input).trim().slice(0, 180) || input.trim(),
    ...(track.author ? { uploader: String(track.author).slice(0, 120) } : {}),
    webpageUrl: input.trim(),
    sourceUrl: input.trim(),
    provider: "noelia",
    downloadUrl,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function resolveFallbackPlayMetadata(input: string, source: string): Promise<PlayMetadata> {
  try {
    const result = await runCommand(["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", source], PLAY_METADATA_TIMEOUT_MS);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error("No media metadata was returned for that search.");
    return parseMetadata(line, source);
  } catch (primaryError) {
    if (/^https?:\/\//iu.test(input.trim())) throw primaryError;
    return resolvePipedMetadata(input);
  }
}

export async function resolvePlayMetadata(input: string, mode: PlayMode = "audio"): Promise<PlayMetadata> {
  const source = sourceFor(input);
  const hasNoelia = mode === "audio" && Boolean(process.env.NOELIA_MUSIC_API_KEY?.trim()) && !/^https?:\/\//iu.test(input.trim());
  if (hasNoelia) {
    try {
      return await withTimeout(resolveNoeliaMetadata(input), NOELIA_FAST_PATH_TIMEOUT_MS, () => undefined);
    } catch {
      try {
        return await resolveFallbackPlayMetadata(input, source);
      } catch {
        // Both compliant provider paths failed; preserve the normal failure response.
        throw new Error("No music provider returned a usable result.");
      }
    }
  }
  return resolveFallbackPlayMetadata(input, source);
}

interface TranscodedAudio {
  bytes: Buffer;
  durationSeconds?: number;
  waveform?: number[];
}

async function inspectAudioPresentation(filePath: string): Promise<Pick<TranscodedAudio, "durationSeconds" | "waveform">> {
  let durationSeconds: number | undefined;
  try {
    const probe = await runExternalCommand(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], 5_000);
    const parsed = Number.parseFloat(probe.stdout.trim());
    if (Number.isFinite(parsed) && parsed > 0) durationSeconds = Math.min(86_400, Math.round(parsed));
  } catch {
    // A missing probe is non-fatal; Baileys can still send a ptt audio payload.
  }
  let waveform: number[] | undefined;
  const pcmPath = `${filePath}.pcm`;
  try {
    await runExternalCommand(FFMPEG_BIN, ["-v", "error", "-i", filePath, "-ac", "1", "-ar", "8000", "-f", "s16le", pcmPath], COMMAND_TIMEOUT_MS);
    const pcm = await readFile(pcmPath);
    const bins = 64;
    const samplesPerBin = Math.max(1, Math.floor(pcm.length / 2 / bins));
    waveform = Array.from({ length: bins }, (_, bin) => {
      const start = bin * samplesPerBin * 2;
      const end = Math.min(pcm.length, start + samplesPerBin * 2);
      let peak = 0;
      for (let offset = start; offset + 1 < end; offset += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
      return Math.max(0, Math.min(100, Math.round((peak / 32767) * 100)));
    });
  } catch {
    waveform = undefined;
  } finally {
    await rm(pcmPath, { force: true }).catch(() => undefined);
  }
  return {
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(waveform ? { waveform } : {}),
  };
}

async function transcodeAudioBytes(
  media: WhatsAppMediaPayload,
  output: "mp3" | "voice-note",
): Promise<TranscodedAudio> {
  if (media.kind !== "audio" && media.kind !== "video")
    throw new Error("Only audio or video media can be converted to audio.");
  if (!media.bytes.length || media.bytes.length > MAX_MEDIA_BYTES)
    throw new Error("The source media exceeds the configured size limit.");
  const directory = await mkdtemp(join(tmpdir(), `pappy-audio-${randomUUID()}-`));
  const inputPath = join(directory, media.kind === "video" ? "input.mp4" : "input.audio");
  const outputPath = join(directory, output === "mp3" ? "output.mp3" : "output.ogg");
  try {
    await writeFile(inputPath, media.bytes);
    const args = output === "mp3"
      ? ["-y", "-i", inputPath, "-vn", "-map_metadata", "0", "-c:a", "libmp3lame", "-q:a", "2", outputPath]
      : ["-y", "-i", inputPath, "-vn", "-map_metadata", "-1", "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", "-application", "voip", outputPath];
    await runExternalCommand(FFMPEG_BIN, args, COMMAND_TIMEOUT_MS);
    const info = await stat(outputPath);
    if (!info.size || info.size > MAX_MEDIA_BYTES) throw new Error("The converted audio exceeds the configured size limit.");
    const bytes = await readFile(outputPath);
    return { bytes, ...(await inspectAudioPresentation(outputPath)) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function convertMediaToMp3(media: WhatsAppMediaPayload): Promise<WhatsAppMediaPayload> {
  const { bytes } = await transcodeAudioBytes(media, "mp3");
  return {
    kind: "audio",
    bytes,
    mimeType: "audio/mpeg",
    fileName: "pappy-audio.mp3",
    ptt: false,
  };
}

async function convertMediaToVoiceNote(media: WhatsAppMediaPayload): Promise<WhatsAppMediaPayload> {
  const converted = await transcodeAudioBytes(media, "voice-note");
  return {
    kind: "audio",
    bytes: converted.bytes,
    mimeType: "audio/ogg; codecs=opus",
    fileName: "pappy-voice-note.ogg",
    ptt: true,
    ...(converted.durationSeconds !== undefined ? { durationSeconds: converted.durationSeconds } : {}),
    ...(converted.waveform ? { waveform: converted.waveform } : {}),
  };
}

async function downloadNoeliaAudio(metadata: PlayMetadata): Promise<WhatsAppMediaPayload> {
  const url = noeliaDownloadUrl(metadata.downloadUrl);
  if (!url) throw new Error("Noelia temporary download URL is missing or invalid.");
  if (metadata.expiresAt && Number.isFinite(Date.parse(metadata.expiresAt)) && Date.parse(metadata.expiresAt) <= Date.now())
    throw new Error("The Noelia temporary download URL has expired; retry the command.");
  const response = await withTimeout(fetch(url, {
    headers: { "User-Agent": "Pappy-Omega-Mini/1.0 (music downloader)", Accept: "audio/mpeg,audio/*" },
  }), NOELIA_DOWNLOAD_TIMEOUT_MS, () => undefined);
  if (!response.ok) throw new Error(response.status === 404 ? "The Noelia temporary download URL expired or is invalid." : `Noelia audio download failed (${response.status}).`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.startsWith("audio/")) throw new Error("Noelia returned a non-audio response.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_MEDIA_BYTES) throw new Error("The audio output exceeds the configured size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error("The audio output exceeds the configured size limit.");
  return {
    kind: "audio",
    bytes,
    mimeType: "audio/mpeg",
    fileName: `${metadata.title.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 80) || "pappy-music"}.mp3`,
    ptt: false,
  };
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
  const response = await withTimeout(fetch(String(candidate.url), { headers: { "User-Agent": "Pappy-Omega-Mini/1.0" } }), PIPED_STREAM_TIMEOUT_MS, () => undefined);
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
  const metadata = resolvedMetadata ?? await resolvePlayMetadata(input, mode);
  if (metadata.provider === "noelia") {
    if (mode !== "audio") throw new Error("Noelia Music API provides audio; use .play for this request.");
    return { metadata, media: await convertMediaToVoiceNote(await downloadNoeliaAudio(metadata)) };
  }
  if (metadata.provider === "piped") {
    const media = await downloadPipedMedia(metadata, mode);
    return { metadata, media: mode === "audio" ? await convertMediaToVoiceNote(media) : media };
  }
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
    const media: WhatsAppMediaPayload = {
      kind: mode,
      bytes,
      mimeType: mode === "audio" ? "audio/mpeg" : "video/mp4",
      fileName: `${metadata.title.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 80) || "pappy-media"}.${mode === "audio" ? "mp3" : "mp4"}`,
      ...(mode === "audio" ? { ptt: false } : {}),
    };
    return { metadata, media: mode === "audio" ? await convertMediaToVoiceNote(media) : media };
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

export function buildPlayHeadsUpText(query: string, mode: PlayMode = "audio"): string {
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ${mode === "audio" ? "🎵" : "🎬"} ˎˊ˗  *${mode === "audio" ? "MUSIC" : "VIDEO"} REQUEST*  ✦`,
    "─────────────",
    `⎔ Request     · ⇆ ${query.slice(0, 180)}`,
    "⎔ Status      · ⇆ Accepted",
    `⎔ Action      · ⇆ Finding ${mode === "audio" ? "the track" : "the video"} now…`,
    "─────────────",
    "» *Next:* A rich preview will arrive before the clean media.",
  ].join("\n");
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

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" })[character] ?? character);
}

async function fetchThumbnail(url: string): Promise<Buffer | undefined> {
  try {
    const response = await withTimeout(fetch(url, { headers: { "User-Agent": "Pappy-Omega-Mini/1.0 (music preview)" } }), 1_200, () => undefined);
    if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return undefined;
    await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    return bytes;
  } catch {
    return undefined;
  }
}

export async function buildMusicPreviewMedia(metadata: PlayMetadata, mode: PlayMode): Promise<WhatsAppMediaPayload> {
  let image = metadata.thumbnailUrl ? await fetchThumbnail(metadata.thumbnailUrl) : undefined;
  if (!image) {
    const title = escapeXml(metadata.title.slice(0, 96));
    const creator = escapeXml((metadata.uploader ?? "Unknown artist").slice(0, 64));
    const label = mode === "audio" ? "MUSIC EXTRACTION" : "VIDEO EXTRACTION";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111820"/><stop offset="0.58" stop-color="#27323a"/><stop offset="1" stop-color="#b14f2a"/></linearGradient><linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd166" stop-opacity="0.85"/><stop offset="1" stop-color="#ff6b35" stop-opacity="0.15"/></linearGradient></defs><rect width="1280" height="720" fill="url(#bg)"/><circle cx="1080" cy="120" r="260" fill="url(#glow)" opacity="0.45"/><circle cx="180" cy="590" r="260" fill="#0b1015" opacity="0.5"/><text x="92" y="118" fill="#ffd166" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="700" letter-spacing="7">PAPPY OMEGA MINI</text><text x="96" y="300" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="92" font-weight="700">♫</text><text x="230" y="284" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="42" font-weight="700">${escapeXml(label)}</text><text x="230" y="368" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="38" font-weight="700" textLength="940" lengthAdjust="spacingAndGlyphs">${title}</text><text x="230" y="430" fill="#d9e2e8" font-family="DejaVu Sans, sans-serif" font-size="30">${creator}</text><path d="M96 572h1088" stroke="#ffd166" stroke-width="4" opacity="0.75"/><text x="96" y="635" fill="#d9e2e8" font-family="DejaVu Sans, sans-serif" font-size="24">Preparing a clean media delivery</text></svg>`;
    image = Buffer.from(svg);
  }
  const bytes = await sharp(image, { limitInputPixels: 100_000_000 })
    .resize(1280, 720, { fit: "cover" })
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { kind: "image", bytes, mimeType: "image/jpeg", fileName: "pappy-music-preview.jpg" };
}

export function buildPlayPreviewText(metadata: PlayMetadata, mode: PlayMode): string {
  const duration = metadata.durationSeconds ? `${Math.floor(metadata.durationSeconds / 60)}m ${metadata.durationSeconds % 60}s` : "Unavailable";
  const source = /^https?:\/\//iu.test(metadata.webpageUrl ?? "")
    ? metadata.webpageUrl
    : metadata.provider === "noelia"
      ? "Noelia Music API"
      : metadata.sourceUrl;
  const extraction = metadata.provider === "noelia"
    ? "NOELIA MUSIC EXTRACTION"
    : mode === "audio"
      ? "MUSIC EXTRACTION"
      : "VIDEO EXTRACTION";
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ${mode === "audio" ? "🎵" : "🎬"} ˎˊ˗  *${extraction}*  ✦`,
    "─────────────",
    `⎔ Title       · ⇆ ${metadata.title.slice(0, 180)}`,
    `⎔ Author      · ⇆ ${(metadata.uploader ?? "Unknown artist").slice(0, 120)}`,
    `⎔ Duration    · ⇆ ${duration}`,
    `⎔ Link        · ⇆ ${String(source).slice(0, 300)}`,
    "─────────────",
    `» *Status:* Extracting ${mode === "audio" ? "audio" : "video"}…`,
    "ℹ️ _A clean media attachment will be delivered next._",
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
