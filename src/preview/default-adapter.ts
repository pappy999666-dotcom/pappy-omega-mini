import {
  PreviewManager,
  assertSafePreviewUrl,
  canonicalize,
  type PreviewAdapter,
  type PreviewRecord,
} from "./preview-manager.js";

const metadataPattern = /<meta\b[^>]*>/gi;
function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match?.[1];
}
const adapter: PreviewAdapter = {
  async fetch(url) {
    let response = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    });
    for (
      let redirect = 0;
      redirect < 2 && response.status >= 300 && response.status < 400;
      redirect += 1
    ) {
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = canonicalize(new URL(location, url).toString());
      assertSafePreviewUrl(nextUrl);
      response = await fetch(nextUrl, {
        headers: { accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
      });
      url = nextUrl;
    }
    if (!response.ok)
      throw new Error(`Preview upstream returned ${response.status}.`);
    const html = (await response.text()).slice(0, 512_000);
    const tags = html.match(metadataPattern) ?? [];
    const values = new Map<string, string>();
    for (const tag of tags) {
      const key = attribute(tag, "property") ?? attribute(tag, "name");
      const value = attribute(tag, "content");
      if (
        key &&
        value &&
        /^(?:og:title|twitter:title|description|og:description|og:image|og:site_name)$/i.test(
          key,
        )
      )
        values.set(key.toLowerCase(), value.trim().slice(0, 2_000));
    }
    const title = values.get("og:title") ?? values.get("twitter:title");
    const description =
      values.get("og:description") ?? values.get("description");
    const thumbnailUrl = values.get("og:image");
    const siteName = values.get("og:site_name");
    return {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
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
      jpegThumbnail: record.thumbnailUrl,
      siteName: record.siteName,
    },
  };
}
