import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Redis } from "ioredis";
import sharp from "sharp";
import { env } from "../config/env.js";
import { canonicalizeHttpUrl } from "../links/url-canonicalization.js";

// v9 invalidates records created when destination-group metadata was incorrectly used as URL preview metadata.
const PREVIEW_CACHE_VERSION = "v9";
const PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;
const PREVIEW_FAILURE_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const NORMALIZED_PREVIEW_MAX_DIMENSION = 1920;
const NORMALIZED_PREVIEW_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const PREVIEW_CONCURRENCY = 8;
const LOCAL_CACHE_MAX_ENTRIES = 512;
const URL_PATTERN = /(?:https?:\/\/|(?:www\.)?\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[^\s<>"']*)?)/gi;
const TRAILING_URL_PUNCTUATION = /[),.;!?]+$/;

const imagePriorities = new Map([
  ["og:image", 100],
  ["og:image:secure_url", 95],
  ["twitter:image", 90],
  ["twitter:image:src", 85],
]);

export interface PreviewSocket {
  groupGetInviteInfo?: (code: string) => Promise<Record<string, unknown>>;
  profilePictureUrl?: (jid: string, type: string) => Promise<string | null>;
  waUploadToServer?: (...args: unknown[]) => Promise<unknown>;
}

export interface CanonicalPreviewRecord {
  schemaVersion: 4;
  canonicalUrl: string;
  title?: string;
  description?: string;
  siteName?: string;
  selectedImageUrl?: string;
  imageData?: string;
  imageMimeType?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  fetchedAt: number;
  expiresAt: number;
}

export interface PreviewDebugSnapshot {
  url: string;
  canonicalUrl: string;
  title?: string;
  description?: string;
  selectedImageUrl?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceBytes?: number;
  processing: "NONE" | "NORMALIZED";
  crop: "NO";
  compression: "NONE" | "JPEG_QUALITY_85_95";
  nativeFlag: "richPreview" | "linkPreview" | "NONE";
  payload: "READY" | "FAILED";
  cache: "HIT" | "MISS" | "BYPASS";
  result: "READY" | "FALLBACK";
  reason?: string;
}

export interface CanonicalPreviewInput {
  text?: string;
  content: Record<string, unknown>;
  socket?: unknown;
  cacheScope?: string;
  target?: "group-status";
}

let redis: Redis | undefined;
const inFlight = new Map<string, Promise<CanonicalPreviewRecord | undefined>>();
const nativeUploadCache = new Map<string, Promise<Record<string, unknown> | undefined>>();
const localPreviewCache = new Map<string, CanonicalPreviewRecord>();
const previewQueue: Array<() => void> = [];
let activePreviewTasks = 0;
const lastDebug = new Map<string, PreviewDebugSnapshot>();
let fallbackInviteImage: Promise<Pick<CanonicalPreviewRecord, "imageData" | "imageMimeType" | "sourceWidth" | "sourceHeight">> | undefined;

function pumpPreviewQueue(): void {
  while (activePreviewTasks < PREVIEW_CONCURRENCY && previewQueue.length) {
    const next = previewQueue.shift();
    next?.();
  }
}

async function withPreviewSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    previewQueue.push(() => {
      activePreviewTasks += 1;
      void task().then(resolve, reject).finally(() => {
        activePreviewTasks -= 1;
        pumpPreviewQueue();
      });
    });
    pumpPreviewQueue();
  });
}

function rememberLocalPreview(key: string, value: CanonicalPreviewRecord): void {
  localPreviewCache.delete(key);
  localPreviewCache.set(key, value);
  while (localPreviewCache.size > LOCAL_CACHE_MAX_ENTRIES) {
    const oldest = localPreviewCache.keys().next().value;
    if (typeof oldest !== "string") break;
    localPreviewCache.delete(oldest);
  }
}

function getRedis(): Redis {
  if (redis) return redis;
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    enableReadyCheck: true,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  return redis;
}

export function extractPreviewUrls(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)]
    .map((match) => cleanUrl(match[0]))
    .filter((url): url is string => Boolean(url));
}

export function firstHttpUrl(text: string): string | undefined {
  return extractPreviewUrls(text)[0];
}

function cleanUrl(value: string): string | undefined {
  const cleaned = value.replace(TRAILING_URL_PUNCTUATION, "");
  const withScheme = /^https?:\/\//i.test(cleaned)
    ? cleaned
    : `https://${cleaned}`;
  try {
    return canonicalizePreviewUrl(withScheme);
  } catch {
    return undefined;
  }
}

export function canonicalizePreviewUrl(value: string): string {
  return canonicalizeHttpUrl(value);
}

export function assertSafePreviewUrl(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol))
    throw new Error("Preview URLs must use HTTP or HTTPS.");
  if (url.username || url.password)
    throw new Error("Preview URLs cannot contain credentials.");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname === "::1"
  )
    throw new Error("Preview host is not allowed.");
  if (isPrivateIp(hostname)) throw new Error("Preview host is not allowed.");
}

async function assertSafeNetworkUrl(value: string): Promise<string> {
  const source = new URL(value);
  const canonical = new URL(canonicalizePreviewUrl(value));
  if (source.hostname.toLowerCase() === "chat.whatsapp.com" && source.search && !canonical.search)
    canonical.search = source.search;
  const safeUrl = canonical.toString();
  assertSafePreviewUrl(safeUrl);
  const hostname = new URL(safeUrl).hostname;
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address)))
      throw new Error("Preview host resolved to a private address.");
  }
  return safeUrl;
}

function isPrivateIp(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[\[\]]/g, "");
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = -1, b = -1] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return false;
}

async function fetchSafe(
  initialUrl: string,
  accept: "html" | "image",
  userAgent = "pappy-omega-mini-preview/4",
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = await assertSafeNetworkUrl(initialUrl);
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        accept:
          accept === "html"
            ? "text/html,application/xhtml+xml;q=0.9"
            : "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
        "user-agent": userAgent,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400)
      return { response, finalUrl: currentUrl };
    if (redirect >= MAX_REDIRECTS)
      throw new Error("Preview redirect limit reached.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Preview redirect had no location.");
    currentUrl = await assertSafeNetworkUrl(new URL(location, currentUrl).toString());
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) throw new Error("Preview response is too large.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error("Preview response is empty or too large.");
  return bytes;
}

function contentType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
}

async function retryPreview<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Preview operation failed."));
}

async function readHtml(
  url: string,
  userAgent?: string,
): Promise<{ html: string; finalUrl: string }> {
  const { response, finalUrl } = await fetchSafe(url, "html", userAgent);
  if (!response.ok) throw new Error(`Preview page returned HTTP ${response.status}.`);
  const type = contentType(response);
  if (type && !type.includes("html") && type !== "text/plain")
    throw new Error("Preview page did not return HTML.");
  const bytes = await readResponseBytes(response, MAX_HTML_BYTES);
  return { html: bytes.toString("utf8"), finalUrl };
}

async function normalizePreviewImage(
  bytes: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const qualities = [95, 90, 85] as const;
  let normalized = bytes;
  for (const quality of qualities) {
    normalized = await sharp(bytes, { limitInputPixels: 100_000_000 })
      .resize({
        width: NORMALIZED_PREVIEW_MAX_DIMENSION,
        height: NORMALIZED_PREVIEW_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, chromaSubsampling: "4:4:4", progressive: true })
      .toBuffer();
    if (normalized.length <= NORMALIZED_PREVIEW_MAX_BYTES || quality === 85)
      break;
  }
  if (!normalized.length || width < 1 || height < 1)
    throw new Error("Preview image normalization produced no bytes.");
  return normalized;
}

async function readImage(url: string): Promise<{
  bytes: Buffer;
  finalUrl: string;
  mimeType: string;
  width: number;
  height: number;
}> {
  const { response, finalUrl } = await fetchSafe(url, "image");
  if (!response.ok) throw new Error(`Preview image returned HTTP ${response.status}.`);
  const type = contentType(response);
  if (type && !type.startsWith("image/"))
    throw new Error("Preview image response is not an image.");
  const bytes = await readResponseBytes(response, MAX_IMAGE_BYTES);
  const metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format)
    throw new Error("Preview image could not be decoded.");
  return {
    bytes: await normalizePreviewImage(bytes, metadata.width, metadata.height),
    finalUrl,
    mimeType: "image/jpeg",
    width: metadata.width,
    height: metadata.height,
  };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, token: string) => {
      const normalized = token.toLowerCase();
      if (normalized.startsWith("#x")) {
        const point = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(point) ? String.fromCodePoint(Math.min(point, 0x10ffff)) : entity;
      }
      if (normalized.startsWith("#")) {
        const point = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(point) ? String.fromCodePoint(Math.min(point, 0x10ffff)) : entity;
      }
      return named[normalized] ?? entity;
    },
  );
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const value = match[3];
    if (key && value !== undefined) attributes.set(key, decodeHtmlEntities(value).trim());
  }
  return attributes;
}

interface ImageCandidate {
  url: string;
  priority: number;
  width: number;
  height: number;
}

function extractEmbeddedImageCandidates(html: string, baseUrl: string): ImageCandidate[] {
  const normalized = html
    .replaceAll("\\u002F", "/")
    .replaceAll("\\/", "/")
    .replaceAll("\\u003F", "?")
    .replaceAll("\\u003D", "=")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u003A", ":");
  const candidates: ImageCandidate[] = [];
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    const value = decodeHtmlEntities(match[0]);
    let parsed: URL;
    try {
      parsed = new URL(value, baseUrl);
      assertSafePreviewUrl(parsed.toString());
    } catch {
      continue;
    }
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const hasImageExtension = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(pathname);
    const isTikTokCdn = hostname.includes("tiktokcdn") || hostname.includes("muscdn");
    const isTikTokPoster = isTikTokCdn && /(?:~tplv-|\/tos-)/i.test(pathname);
    const imageLike = isTikTokCdn ? isTikTokPoster : hasImageExtension;
    if (!imageLike) continue;
    const sizeMatch = pathname.match(/:(\d+):(?:\d+)(?:\.[a-z0-9]+)?$/i);
    const size = sizeMatch ? Number(sizeMatch[1]) : 0;
    candidates.push({
      url: parsed.toString(),
      priority: isTikTokCdn ? 82 + Math.min(size / 1000, 10) : 35,
      width: size,
      height: size,
    });
    if (candidates.length >= 24) break;
  }
  return candidates;
}

function parsePageMetadata(html: string, baseUrl: string): {
  title?: string;
  description?: string;
  siteName?: string;
  canonicalUrl?: string;
  images: ImageCandidate[];
} {
  const values = new Map<string, string>();
  const rawImageKeys: Array<{ key: string; value: string }> = [];
  let canonicalUrl: string | undefined;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const value = attrs.get("content");
    if (!key || !value) continue;
    values.set(key, value);
    if (imagePriorities.has(key)) rawImageKeys.push({ key, value });
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (attrs.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) {
      const href = attrs.get("href");
      if (href) canonicalUrl = href;
    }
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const images: ImageCandidate[] = [];
  for (const { key, value } of rawImageKeys) {
    try {
      const imageUrl = canonicalizePreviewUrl(new URL(value, baseUrl).toString());
      assertSafePreviewUrl(imageUrl);
      images.push({
        url: imageUrl,
        priority: imagePriorities.get(key) ?? 0,
        width: Number(values.get("og:image:width") ?? 0) || 0,
        height: Number(values.get("og:image:height") ?? 0) || 0,
      });
    } catch {
      // Unsafe or malformed candidates are rejected without affecting text metadata.
    }
  }
  for (const candidate of extractEmbeddedImageCandidates(html, baseUrl)) {
    if (!images.some((existing) => existing.url === candidate.url)) images.push(candidate);
  }
  images.sort(
    (left, right) =>
      right.width * right.height - left.width * left.height || right.priority - left.priority,
  );
  const title = values.get("og:title") || values.get("twitter:title") || (titleTag ? decodeHtmlEntities(titleTag) : undefined);
  const description = values.get("og:description") || values.get("twitter:description") || values.get("description");
  const siteName = values.get("og:site_name");
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    images,
  };
}

function imageUrlFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value) return undefined;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "url",
    "url_direct",
    "imageUrl",
    "image_url",
    "profilePictureUrl",
    "profile_picture_url",
    "thumbnail",
    "picture",
    "image",
    "preview",
  ]) {
    const found = imageUrlFromValue(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function groupInviteCode(url: string): string | undefined {
  return url.match(/^https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)?.[1];
}

type PublicInviteMetadataCandidate = {
  url: string;
  userAgent?: string;
  format: "html" | "markdown";
};

function publicInviteMetadataCandidates(
  canonicalUrl: string,
): PublicInviteMetadataCandidate[] {
  const candidates: PublicInviteMetadataCandidate[] = [];
  try {
    const parsed = new URL(canonicalUrl);
    const code = groupInviteCode(canonicalUrl);
    if (parsed.hostname.toLowerCase() === "chat.whatsapp.com" && code) {
      const direct = new URL(parsed.toString());
      if (!direct.search) direct.search = "s=cl&p=a&mlu=4";
      candidates.push({ url: direct.toString(), format: "html" });
      candidates.push({
        url: `https://chat.whatsapp.com/invite/${code}`,
        userAgent: "WhatsApp/2.24.2",
        format: "html",
      });
      candidates.push({
        url: `https://chat.whatsapp.com/invite/${code}?s=cl&p=a&mlu=4`,
        userAgent: "WhatsApp/2.24.2",
        format: "html",
      });
      candidates.push({
        url: `https://r.jina.ai/http://chat.whatsapp.com/invite/${code}`,
        format: "markdown",
      });
    } else {
      candidates.push({ url: canonicalUrl, format: "html" });
    }
  } catch {
    candidates.push({ url: canonicalUrl, format: "html" });
  }
  return candidates;
}

function parseRelayInviteMetadata(
  markdown: string,
  sourceUrl: string,
): ReturnType<typeof parsePageMetadata> {
  const title = markdown.match(/^###\s+([^\n]+)$/m)?.[1]?.trim();
  const description = markdown.match(/^####\s+([^\n]+)$/m)?.[1]?.trim();
  const imageValue = markdown.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/i)?.[1];
  const images: ImageCandidate[] = [];
  if (imageValue) {
    try {
      const url = canonicalizePreviewUrl(imageValue);
      assertSafePreviewUrl(url);
      images.push({ url, priority: 120, width: 0, height: 0 });
    } catch {
      // Unsafe relay image candidates are discarded.
    }
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    canonicalUrl: sourceUrl,
    images,
  };
}

async function readPublicInviteMetadata(
  canonicalUrl: string,
): Promise<ReturnType<typeof parsePageMetadata>> {
  let lastError: unknown;
  for (const candidate of publicInviteMetadataCandidates(canonicalUrl)) {
    try {
      const page = await readHtml(candidate.url, candidate.userAgent);
      const metadata = candidate.format === "markdown"
        ? parseRelayInviteMetadata(page.html, canonicalUrl)
        : parsePageMetadata(page.html, page.finalUrl);
      if (metadata.title || metadata.description || metadata.images.length) return metadata;
      lastError = new Error("WhatsApp invite metadata response was empty.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("WhatsApp invite metadata was unavailable.");
}

function socketCandidate(value: unknown): PreviewSocket | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as PreviewSocket;
}

async function resolveImageCandidates(
  candidates: string[],
): Promise<Pick<CanonicalPreviewRecord, "selectedImageUrl" | "imageData" | "imageMimeType" | "sourceWidth" | "sourceHeight"> | undefined> {
  for (const candidate of [...new Set(candidates)]) {
    try {
      const image = await retryPreview(() => readImage(candidate));
      return {
        selectedImageUrl: image.finalUrl,
        imageData: image.bytes.toString("base64"),
        imageMimeType: image.mimeType,
        sourceWidth: image.width,
        sourceHeight: image.height,
      };
    } catch {
      // Candidate selection remains deterministic; a bad candidate is skipped.
    }
  }
  return undefined;
}

async function getFallbackInviteImage(): Promise<Pick<CanonicalPreviewRecord, "imageData" | "imageMimeType" | "sourceWidth" | "sourceHeight">> {
  if (!fallbackInviteImage) {
    fallbackInviteImage = (async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b3b2e"/><stop offset="1" stop-color="#16a085"/></linearGradient></defs><rect width="1200" height="630" rx="36" fill="url(#bg)"/><circle cx="180" cy="315" r="92" fill="#25d366"/><path d="M132 438l18-68a78 78 0 1 1 34 29z" fill="none" stroke="#fff" stroke-width="18" stroke-linejoin="round"/><path d="M157 332c19 32 39 49 71 63 12 5 20 1 28-8l15-18-34-22-14 16c-17-8-29-20-38-37l15-14-22-33-18 9c-9 5-10 19-3 44z" fill="#fff"/><text x="330" y="285" fill="#fff" font-family="Arial, sans-serif" font-size="62" font-weight="700">WhatsApp Group Invite</text><text x="334" y="365" fill="#d5fff0" font-family="Arial, sans-serif" font-size="32">Open this invitation in WhatsApp</text><text x="334" y="435" fill="#b9f5df" font-family="Arial, sans-serif" font-size="25">Preview metadata is temporarily unavailable</text></svg>`;
      const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 92, chromaSubsampling: "4:4:4", progressive: true }).toBuffer();
      return {
        imageData: bytes.toString("base64"),
        imageMimeType: "image/jpeg",
        sourceWidth: 1200,
        sourceHeight: 630,
      };
    })();
  }
  return fallbackInviteImage;
}

async function fallbackInviteRecord(canonicalUrl: string): Promise<CanonicalPreviewRecord> {
  return {
    schemaVersion: 4,
    canonicalUrl,
    title: "WhatsApp Group Invite",
    description: "Open this WhatsApp group invitation in WhatsApp.",
    siteName: "WhatsApp",
    ...(await getFallbackInviteImage()),
    fetchedAt: Date.now(),
    expiresAt: Date.now() + PREVIEW_TTL_SECONDS * 1000,
  };
}

async function resolveRecord(
  canonicalUrl: string,
  socket: PreviewSocket | undefined,
): Promise<CanonicalPreviewRecord | undefined> {
  const groupCode = groupInviteCode(canonicalUrl);
  if (groupCode && socket?.groupGetInviteInfo) {
    let info: Record<string, unknown> | undefined;
    try {
      info = await retryPreview(() => socket.groupGetInviteInfo!(groupCode));
    } catch {
      info = undefined;
    }
    if (info) {
      const groupId = typeof info.id === "string" ? info.id : undefined;
      const candidates = [
        imageUrlFromValue(info.profilePic),
        imageUrlFromValue(info.profile_picture),
        imageUrlFromValue(info.profilePicture),
        imageUrlFromValue(info.profilePictureUrl),
        imageUrlFromValue(info.profile_picture_url),
        imageUrlFromValue(info.picture),
        imageUrlFromValue(info.image),
        imageUrlFromValue(info.thumbnail),
        imageUrlFromValue(info.preview),
      ].filter((value): value is string => Boolean(value));
      if (groupId && socket.profilePictureUrl) {
        const profileUrl = await socket.profilePictureUrl(groupId, "image").catch(() => null);
        if (profileUrl) candidates.push(profileUrl);
      }
      let image = await resolveImageCandidates(candidates);
      if (!image) {
        try {
          const metadata = await retryPreview(() => readPublicInviteMetadata(canonicalUrl));
          for (const candidate of metadata.images.slice(0, 8)) {
            image = await resolveImageCandidates([candidate.url]);
            if (image) break;
          }
        } catch {
          // Socket metadata remains usable even when the public page image fails.
        }
      }
      const inviteImage = image ?? await getFallbackInviteImage();
      return {
        schemaVersion: 4,
        canonicalUrl,
        title: String(info.subject ?? "WhatsApp Group"),
        description: `${Number(info.size ?? info.participantsCount ?? 0) || 0} members · WhatsApp Group`,
        ...inviteImage,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + PREVIEW_TTL_SECONDS * 1000,
      };
    }
  }

  try {
    const metadata = await retryPreview(() => groupInviteCode(canonicalUrl)
      ? readPublicInviteMetadata(canonicalUrl)
      : readHtml(canonicalUrl).then((page) => parsePageMetadata(page.html, page.finalUrl)));
    let image: Pick<CanonicalPreviewRecord, "selectedImageUrl" | "imageData" | "imageMimeType" | "sourceWidth" | "sourceHeight"> | undefined;
    for (const candidate of metadata.images.slice(0, 8)) {
      image = await resolveImageCandidates([candidate.url]);
      if (image) break;
    }
    if (!metadata.title && !metadata.description && !image && !groupInviteCode(canonicalUrl)) return undefined;
    const inviteImage = groupInviteCode(canonicalUrl) && !image ? await getFallbackInviteImage() : undefined;
    const resolvedCanonical = groupInviteCode(canonicalUrl)
      ? canonicalUrl
      : metadata.canonicalUrl
        ? canonicalizePreviewUrl(new URL(metadata.canonicalUrl, canonicalUrl).toString())
        : canonicalUrl;
    return {
      schemaVersion: 4,
      canonicalUrl: resolvedCanonical,
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.siteName ? { siteName: metadata.siteName } : {}),
      ...(image ?? inviteImage ?? {}),
      fetchedAt: Date.now(),
      expiresAt: Date.now() + PREVIEW_TTL_SECONDS * 1000,
    };
  } catch {
    if (groupInviteCode(canonicalUrl)) return fallbackInviteRecord(canonicalUrl);
    return undefined;
  }
}

function cacheKey(scope: string | undefined, canonicalUrl: string): string {
  const namespace = scope?.trim() || "global";
  const digest = createHash("sha256").update(`${namespace}\n${canonicalUrl}`).digest("hex");
  return `pappy-omega-mini:preview:${PREVIEW_CACHE_VERSION}:${digest}`;
}

async function readCached(
  key: string,
  expectedCanonicalUrl: string,
): Promise<CanonicalPreviewRecord | undefined> {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as CanonicalPreviewRecord;
    if (value.schemaVersion !== 4 || value.expiresAt <= Date.now()) return undefined;
    if (value.canonicalUrl !== expectedCanonicalUrl) {
      await getRedis().del(key).catch(() => undefined);
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function writeCached(key: string, value: CanonicalPreviewRecord): Promise<void> {
  try {
    const ttl = value.imageData ? PREVIEW_TTL_SECONDS : PREVIEW_FAILURE_TTL_SECONDS;
    await getRedis().set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    // Redis failure cannot block a WhatsApp send.
  }
}

async function resolveCached(
  url: string,
  scope: string | undefined,
  socket: PreviewSocket | undefined,
): Promise<{ record: CanonicalPreviewRecord | undefined; cache: "HIT" | "MISS" | "BYPASS" }> {
  const canonicalUrl = canonicalizePreviewUrl(url);
  const key = cacheKey(scope, canonicalUrl);
  const local = localPreviewCache.get(key);
  if (local && local.canonicalUrl === canonicalUrl && local.expiresAt > Date.now()) {
    rememberLocalPreview(key, local);
    return { record: local, cache: "HIT" };
  }
  if (local) localPreviewCache.delete(key);

  // Coalesce before any asynchronous Redis lookup. Otherwise two callers can
  // both miss Redis, then each create a resolver and fetch the same URL.
  const runningKey = `${scope ?? "global"}:${canonicalUrl}`;
  const running = inFlight.get(runningKey);
  if (running) return { record: await running, cache: "MISS" };

  let cacheResult: "HIT" | "MISS" = "MISS";
  const promise = (async (): Promise<CanonicalPreviewRecord> => {
    const cached = await readCached(key, canonicalUrl);
    if (cached) {
      cacheResult = "HIT";
      rememberLocalPreview(key, cached);
      return cached;
    }
    const record = await withPreviewSlot(() => resolveRecord(canonicalUrl, socket));
    const cachedRecord: CanonicalPreviewRecord = record ?? {
      schemaVersion: 4,
      canonicalUrl,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + PREVIEW_FAILURE_TTL_SECONDS * 1000,
    };
    rememberLocalPreview(key, cachedRecord);
    await writeCached(key, cachedRecord);
    return cachedRecord;
  })();
  inFlight.set(runningKey, promise);
  promise.finally(() => {
    if (inFlight.get(runningKey) === promise) inFlight.delete(runningKey);
  }).catch(() => undefined);
  const record = await promise;
  return { record, cache: cacheResult };
}

function readText(content: Record<string, unknown>): string | undefined {
  if (typeof content.text === "string") return content.text;
  if (typeof content.caption === "string") return content.caption;
  return undefined;
}

function hasMedia(content: Record<string, unknown>): boolean {
  return ["image", "video", "audio", "document", "sticker"].some((key) => key in content);
}

function mediaCaptionCanCarryPreview(content: Record<string, unknown>): boolean {
  return (
    typeof content.caption === "string" &&
    ["image", "video", "document"].some((key) => key in content)
  );
}

export function isCompletePreview(preview: Record<string, unknown> | undefined): boolean {
  if (!preview) return false;
  return Boolean(
    (preview.title ?? preview.previewTitle) &&
      (preview.description ?? preview.previewDescription) &&
      (preview.thumbnailUrl ?? preview.previewImage ?? preview.jpegThumbnail),
  );
}

function readExistingPreview(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (content.linkPreview && typeof content.linkPreview === "object")
    return content.linkPreview as Record<string, unknown>;
  if (content.richPreview === true) return content;
  return undefined;
}

function previewMatchesUrl(preview: Record<string, unknown>, url: string): boolean {
  const candidate = preview["canonical-url"] ?? preview.canonicalUrl ?? preview["matched-text"];
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  try {
    return canonicalizePreviewUrl(candidate) === canonicalizePreviewUrl(url);
  } catch {
    return candidate.trim() === url.trim();
  }
}

async function nativeLinkPreview(
  record: CanonicalPreviewRecord,
  matchedUrl: string,
  socket: PreviewSocket | undefined,
  cacheScope: string | undefined,
): Promise<Record<string, unknown>> {
  const thumbnail = record.imageData
    ? Buffer.from(record.imageData, "base64")
    : undefined;
  let highQualityThumbnail: Record<string, unknown> | undefined;
  if (thumbnail && socket?.waUploadToServer) {
    const uploadKey = `${cacheScope ?? "global"}:${record.canonicalUrl}`;
    const current = nativeUploadCache.get(uploadKey);
    if (current) {
      highQualityThumbnail = await current;
    } else {
      const pending = (async () => {
        try {
          const { prepareWAMessageMedia } = (await import(
            "@crysnovax/baileys"
          )) as unknown as {
            prepareWAMessageMedia: (
              message: Record<string, unknown>,
              options: Record<string, unknown>,
            ) => Promise<{ imageMessage?: Record<string, unknown> }>;
          };
          const prepared = await prepareWAMessageMedia(
            { image: thumbnail },
            {
              upload: socket.waUploadToServer,
              mediaTypeOverride: "thumbnail-link",
            },
          );
          return prepared.imageMessage;
        } catch {
          return undefined;
        }
      })();
      nativeUploadCache.set(uploadKey, pending);
      highQualityThumbnail = await pending;
      if (!highQualityThumbnail) nativeUploadCache.delete(uploadKey);
    }
  }
  return {
    "matched-text": matchedUrl,
    "canonical-url": record.canonicalUrl,
    ...(record.title ? { title: record.title } : {}),
    ...(record.description ? { description: record.description } : {}),
    previewType: 0,
    ...(thumbnail ? { jpegThumbnail: thumbnail } : {}),
    ...(highQualityThumbnail
      ? {
          highQualityThumbnail: {
            ...highQualityThumbnail,
            ...(highQualityThumbnail.width ? {} : { width: 480 }),
            ...(highQualityThumbnail.height ? {} : { height: 720 }),
          },
        }
      : {}),
    linkPreviewMetadata: {
      linkMediaDuration: 0,
      socialMediaPostType: 4,
    },
  };
}

export async function prepareCanonicalPreviewContent(
  input: CanonicalPreviewInput,
): Promise<Record<string, unknown>> {
  const content = { ...input.content };
  const text = input.text ?? readText(content);
  const url = text ? firstHttpUrl(text) : undefined;
  const existing = readExistingPreview(content);
  if (
    !text ||
    !url ||
    (existing && isCompletePreview(existing) && previewMatchesUrl(existing, url))
 ||
    (hasMedia(content) && !mediaCaptionCanCarryPreview(content))
  )
    return content;

  const snapshotBase: PreviewDebugSnapshot = {
    url,
    canonicalUrl: url,
    processing: "NONE",
    crop: "NO",
    compression: "NONE",
    nativeFlag: "NONE",
    payload: "FAILED",
    cache: "BYPASS",
    result: "FALLBACK",
  };
  try {
    const { record, cache } = await resolveCached(url, input.cacheScope, socketCandidate(input.socket));
    if (!record || (!record.title && !record.description && !record.imageData)) {
      lastDebug.set(input.cacheScope ?? "global", { ...snapshotBase, cache, reason: "no-valid-preview" });
      return content;
    }
    const prepared = {
      ...content,
      text,
      linkPreview: await nativeLinkPreview(
        record,
        url,
        socketCandidate(input.socket),
        input.cacheScope,
      ),
      ...(input.target === "group-status" ? { groupStatus: true } : {}),
    };
    lastDebug.set(input.cacheScope ?? "global", {
      ...snapshotBase,
      canonicalUrl: record.canonicalUrl,
      ...(record.title ? { title: record.title } : {}),
      ...(record.description ? { description: record.description } : {}),
      ...(record.selectedImageUrl ? { selectedImageUrl: record.selectedImageUrl } : {}),
      ...(record.sourceWidth ? { sourceWidth: record.sourceWidth } : {}),
      ...(record.sourceHeight ? { sourceHeight: record.sourceHeight } : {}),
      ...(record.imageData ? { sourceBytes: Buffer.byteLength(record.imageData, "base64") } : {}),
      processing: record.imageData ? "NORMALIZED" : "NONE",
      compression: record.imageData ? "JPEG_QUALITY_85_95" : "NONE",
      nativeFlag: "linkPreview",
      payload: "READY",
      cache,
      result: "READY",
    });
    return prepared;
  } catch (error) {
    lastDebug.set(input.cacheScope ?? "global", {
      ...snapshotBase,
      reason: error instanceof Error ? error.message : String(error),
    });
    return content;
  }
}

export function getPreviewDebugSnapshot(scope = "global"): PreviewDebugSnapshot | undefined {
  return lastDebug.get(scope);
}

export async function closeCanonicalPreview(): Promise<void> {
  await redis?.quit().catch(() => undefined);
  redis = undefined;
  inFlight.clear();
  nativeUploadCache.clear();
  localPreviewCache.clear();
  previewQueue.length = 0;
  lastDebug.clear();
}
