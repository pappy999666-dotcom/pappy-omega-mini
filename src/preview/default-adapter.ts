import sharp from "sharp";
import { env } from "../config/env.js";
import {
  PreviewManager,
  assertSafePreviewUrl,
  canonicalize,
  type PreviewAdapter,
  type PreviewRecord,
} from "./preview-manager.js";

const metadataPattern = /<meta\b[^>]*>/gi;
const imageKeys = new Map([
  ["og:image", 40],
  ["og:image:secure_url", 45],
  ["twitter:image", 35],
  ["twitter:image:src", 30],
]);
const maxThumbnailBytes = 8 * 1024 * 1024;
const maxGroupThumbnailBytes = 512 * 1024;
const groupThumbnailEdge = 1920;

export interface WhatsAppGroupPreviewSocket {
  groupGetInviteInfo?: (code: string) => Promise<{
    id?: string;
    subject?: string;
    size?: number;
    [key: string]: unknown;
  }>;
  profilePictureUrl?: (jid: string, type: string) => Promise<string | null>;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match?.[1];
}

/** Decode the entity forms commonly emitted by Open Graph and Twitter cards. */
export function decodeHtmlEntities(value: string): string {
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
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
          : entity;
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
          : entity;
      }
      return named[normalized] ?? entity;
    },
  );
}

interface ImageCandidate {
  url: string;
  priority: number;
  width: number;
  height: number;
}

async function fetchWithSafeRedirects(
  initialUrl: string,
  headers: Record<string, string>,
): Promise<{ response: Response; finalUrl: string }> {
  let url = canonicalize(initialUrl);
  assertSafePreviewUrl(url);
  let response = await fetch(url, {
    headers,
    redirect: "manual",
  });
  for (
    let redirect = 0;
    redirect < 2 && response.status >= 300 && response.status < 400;
    redirect += 1
  ) {
    const location = response.headers.get("location");
    if (!location) break;
    url = canonicalize(new URL(location, url).toString());
    assertSafePreviewUrl(url);
    response = await fetch(url, {
      headers,
      redirect: "manual",
    });
  }
  return { response, finalUrl: url };
}

async function resolveThumbnail(
  candidate: ImageCandidate,
): Promise<{ thumbnailUrl: string; thumbnailData?: string }> {
  const { response, finalUrl } = await fetchWithSafeRedirects(candidate.url, {
    accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
  });
  if (!response.ok)
    throw new Error(`Thumbnail upstream returned ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxThumbnailBytes)
    throw new Error("Preview thumbnail exceeds the configured size limit.");
  const input = Buffer.from(await response.arrayBuffer());
  if (!input.length || input.length > maxThumbnailBytes)
    throw new Error("Preview thumbnail is empty or too large.");
  const normalized = await normalizeImageBuffer(input);
  return {
    thumbnailUrl: finalUrl,
    thumbnailData: normalized.toString("base64"),
  };
}

async function normalizeImageBuffer(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .sharpen({ sigma: 0.7, m1: 0.5, m2: 1.2 })
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function normalizeGroupImageBuffer(
  input: Buffer,
): Promise<Buffer | undefined> {
  try {
    const metadata = await sharp(input, {
      limitInputPixels: 40_000_000,
    }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < 100 ||
      metadata.height < 100
    )
      return undefined;
    const attempts = [
      { quality: 95, mozjpeg: true },
      { quality: 90, mozjpeg: true },
      { quality: 85, mozjpeg: true },
    ];
    for (const attempt of attempts) {
      const output = await sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({
          width: groupThumbnailEdge,
          height: groupThumbnailEdge,
          fit: "inside",
          withoutEnlargement: true,
          kernel: "lanczos3",
        })
        .sharpen({ sigma: 0.55, m1: 0.4, m2: 1.1 })
        .jpeg({ ...attempt, chromaSubsampling: "4:4:4" })
        .toBuffer();
      if (output.length <= maxGroupThumbnailBytes) return output;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function imageUrlFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || !value) return undefined;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "url",
    "url_direct",
    "directPath",
    "direct_path",
    "imageUrl",
    "image_url",
    "profilePictureUrl",
    "profile_picture_url",
    "thumbnail",
    "picture",
    "image",
    "preview",
  ]) {
    const candidate = imageUrlFromValue(record[key], depth + 1);
    if (candidate) return candidate;
  }
  return undefined;
}

function groupInviteCode(url: string): string | undefined {
  return url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)?.[1];
}

async function downloadGroupImage(
  imageUrl: string,
): Promise<{ thumbnailUrl: string; thumbnailData: string } | undefined> {
  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(imageUrl, {
      accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
    });
    if (!response.ok) return undefined;
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxGroupThumbnailBytes) return undefined;
    const input = Buffer.from(await response.arrayBuffer());
    if (!input.length || input.length > maxGroupThumbnailBytes)
      return undefined;
    const normalized = await normalizeGroupImageBuffer(input);
    return normalized
      ? { thumbnailUrl: finalUrl, thumbnailData: normalized.toString("base64") }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveWhatsAppGroupInvitePreview(
  url: string,
  socket: WhatsAppGroupPreviewSocket,
): Promise<
  | Pick<
      PreviewRecord,
      | "canonicalUrl"
      | "title"
      | "description"
      | "thumbnailUrl"
      | "thumbnailData"
    >
  | undefined
> {
  const code = groupInviteCode(url);
  if (!code || !socket.groupGetInviteInfo || !socket.profilePictureUrl)
    return undefined;
  try {
    const info = await socket.groupGetInviteInfo(code);
    if (!info?.id) return undefined;
    const invite = info as Record<string, unknown>;
    const candidates = [
      imageUrlFromValue(invite.profilePic),
      imageUrlFromValue(invite.profile_picture),
      imageUrlFromValue(invite.profilePicture),
      imageUrlFromValue(invite.profilePictureUrl),
      imageUrlFromValue(invite.profile_picture_url),
      imageUrlFromValue(invite.picture),
      imageUrlFromValue(invite.image),
      imageUrlFromValue(invite.thumbnail),
      imageUrlFromValue(invite.preview),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const profileUrl = await socket
      .profilePictureUrl(info.id, "image")
      .catch(() => null);
    if (profileUrl && !candidates.includes(profileUrl))
      candidates.push(profileUrl);
    let thumbnail: { thumbnailUrl: string; thumbnailData: string } | undefined;
    for (const candidate of [...new Set(candidates)]) {
      thumbnail = await downloadGroupImage(candidate);
      if (thumbnail) break;
    }
    return {
      canonicalUrl: url,
      title: String(info.subject ?? "WhatsApp Group"),
      description: `${Number(info.size ?? 0) || 0} members`,
      ...(thumbnail ?? {}),
    };
  } catch {
    return undefined;
  }
}

function telegramPublicUsername(url: string): string | undefined {
  const match = url.match(
    /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{5,32})\/?$/i,
  );
  return match?.[1];
}

async function resolveTelegramProfileImage(
  url: string,
): Promise<string | undefined> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const username = telegramPublicUsername(url);
  if (!token || !username) return undefined;
  const api = `https://api.telegram.org/bot${token}`;
  const chatResponse = await fetch(
    `${api}/getChat?chat_id=${encodeURIComponent(`@${username}`)}`,
    { signal: AbortSignal.timeout(3_000) },
  );
  if (!chatResponse.ok) return undefined;
  const chat = (await chatResponse.json()) as {
    ok?: boolean;
    result?: { photo?: { big_file_id?: string } };
  };
  const fileId = chat.result?.photo?.big_file_id;
  if (!chat.ok || !fileId) return undefined;
  const fileResponse = await fetch(`${api}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!fileResponse.ok) return undefined;
  const file = (await fileResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string };
  };
  const filePath = file.result?.file_path;
  if (!file.ok || !filePath) return undefined;
  const imageResponse = await fetch(
    `${api.replace("api.telegram.org", "api.telegram.org/file")}/${filePath}`,
    {
      signal: AbortSignal.timeout(3_000),
    },
  );
  if (!imageResponse.ok) return undefined;
  const input = Buffer.from(await imageResponse.arrayBuffer());
  if (!input.length || input.length > maxThumbnailBytes) return undefined;
  return (await normalizeImageBuffer(input)).toString("base64");
}

const adapter: PreviewAdapter = {
  async fetch(url) {
    const { response } = await fetchWithSafeRedirects(url, {
      accept: "text/html,application/xhtml+xml",
    });
    if (!response.ok)
      throw new Error(`Preview upstream returned ${response.status}.`);
    const html = (await response.text()).slice(0, 512_000);
    const tags = html.match(metadataPattern) ?? [];
    const values = new Map<string, string>();
    const candidates: ImageCandidate[] = [];
    for (const tag of tags) {
      const key = (
        attribute(tag, "property") ??
        attribute(tag, "name") ??
        ""
      ).toLowerCase();
      const rawValue = attribute(tag, "content");
      if (!key || !rawValue) continue;
      const value = decodeHtmlEntities(rawValue).trim().slice(0, 2_000);
      values.set(key, value);
      const priority = imageKeys.get(key);
      if (priority !== undefined) {
        try {
          const imageUrl = canonicalize(new URL(value, url).toString());
          assertSafePreviewUrl(imageUrl);
          candidates.push({
            url: imageUrl,
            priority,
            width: Number(values.get("og:image:width") ?? 0),
            height: Number(values.get("og:image:height") ?? 0),
          });
        } catch {
          // Ignore malformed or unsafe image metadata and keep text metadata.
        }
      }
    }
    candidates.sort(
      (left, right) =>
        right.width * right.height - left.width * left.height ||
        right.priority - left.priority,
    );
    const title = values.get("og:title") ?? values.get("twitter:title");
    const description =
      values.get("og:description") ?? values.get("description");
    const siteName = values.get("og:site_name");
    let thumbnail:
      { thumbnailUrl?: string; thumbnailData?: string } | undefined;
    const telegramThumbnail = await resolveTelegramProfileImage(url).catch(
      () => undefined,
    );
    if (telegramThumbnail) thumbnail = { thumbnailData: telegramThumbnail };
    for (const candidate of thumbnail ? [] : candidates.slice(0, 4)) {
      try {
        thumbnail = await resolveThumbnail(candidate);
        break;
      } catch {
        // Try the next declared image source before falling back to metadata only.
      }
    }
    return {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(thumbnail ?? {}),
      ...(siteName ? { siteName } : {}),
    };
  },
};

export function createDefaultPreviewManager(
  redis: ConstructorParameters<typeof PreviewManager>[0],
): PreviewManager {
  return new PreviewManager(redis, adapter);
}

export function firstHttpUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;!?]+$/, "");
}

export function linkPreviewPayload(
  record: PreviewRecord,
  text: string,
): Record<string, unknown> | undefined {
  if (record.fallback || !record.title) return undefined;
  return {
    text,
    linkPreview: {
      canonicalUrl: record.canonicalUrl,
      matchedText: record.canonicalUrl,
      title: record.title,
      description: record.description,
      ...(record.thumbnailData
        ? { jpegThumbnail: Buffer.from(record.thumbnailData, "base64") }
        : record.thumbnailUrl
          ? { jpegThumbnail: record.thumbnailUrl }
          : {}),
      siteName: record.siteName,
    },
  };
}
