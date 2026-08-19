import sharp from "sharp";
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
  const normalized = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    thumbnailUrl: finalUrl,
    thumbnailData: normalized.toString("base64"),
  };
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
    let thumbnail: { thumbnailUrl: string; thumbnailData?: string } | undefined;
    for (const candidate of candidates.slice(0, 4)) {
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
