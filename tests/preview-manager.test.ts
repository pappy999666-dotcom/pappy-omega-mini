import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  assertSafePreviewUrl,
  canonicalizePreviewUrl,
  extractPreviewUrls,
  firstHttpUrl,
  isCompletePreview,
  prepareCanonicalPreviewContent,
} from "../src/whatsapp/baileys-native-preview.js";
import {
  extractWhatsAppGroupInviteUrls,
  isWhatsAppGroupInviteUrl,
} from "../src/links/link-collector.js";

describe("canonical Baileys-native preview pipeline", () => {
  it("canonicalizes URLs and removes fragments", () => {
    expect(canonicalizePreviewUrl("HTTPS://Example.com/a#fragment")).toBe(
      "https://example.com/a",
    );
  });

  it("blocks private and metadata hosts", () => {
    expect(() => assertSafePreviewUrl("http://127.0.0.1/internal")).toThrow();
    expect(() =>
      assertSafePreviewUrl("http://169.254.169.254/latest/meta-data"),
    ).toThrow();
    expect(() => assertSafePreviewUrl("https://example.com")).not.toThrow();
  });

  it("detects all URLs embedded in text without changing the original text", () => {
    const text = "Open https://example.com/a and https://example.org/b.";
    expect(extractPreviewUrls(text)).toEqual([
      "https://example.com/a",
      "https://example.org/b",
    ]);
    expect(firstHttpUrl("Join https://chat.whatsapp.com/ABC123.")).toBe(
      "https://chat.whatsapp.com/ABC123",
    );
  });

  it("accepts only WhatsApp group invite URLs for Validator Hub", () => {
    expect(isWhatsAppGroupInviteUrl("https://chat.whatsapp.com/ABC123")).toBe(
      true,
    );
    expect(isWhatsAppGroupInviteUrl("https://whatsapp.com/channel/123")).toBe(
      false,
    );
    expect(
      extractWhatsAppGroupInviteUrls(
        "https://example.com/a https://chat.whatsapp.com/ABC123",
      ),
    ).toEqual(["https://chat.whatsapp.com/ABC123"]);
  });

  it("uses the exact native linkPreview contract for a URL text message", async () => {
    const source = await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 36, g: 84, b: 140 },
      },
    })
      .jpeg({ quality: 98 })
      .toBuffer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const requested = String(input);
      if (requested === "https://example.com/card.jpg")
        return new Response(source, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      return new Response(
        '<html><head><meta property="og:title" content="Example title"><meta property="og:description" content="Example description"><meta property="og:image" content="https://example.com/card.jpg"></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const text = "Read this: https://example.com/article";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        cacheScope: `test-${Date.now()}`,
      });
      expect(content).toMatchObject({
        text,
        linkPreview: {
          "matched-text": "https://example.com/article",
          title: "Example title",
          description: "Example description",
          previewType: 5,
        },
      });
      const preview = content.linkPreview as Record<string, unknown>;
      expect(Buffer.isBuffer(preview.jpegThumbnail)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves hidden mentions while using the native linkPreview path", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        '<html><head><meta property="og:title" content="Mentioned"><meta property="og:description" content="Preview"></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as typeof fetch;
    try {
      const text = "https://example.com/mention";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: {
          text,
          mentions: ["2347000000000@s.whatsapp.net"],
        },
        cacheScope: `test-mentions-${Date.now()}`,
      });
      expect(content).toMatchObject({
        linkPreview: {
          title: "Mentioned",
          description: "Preview",
        },
        mentions: ["2347000000000@s.whatsapp.net"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses native group-status wrapping without replacing the original URL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        '<html><head><meta property="og:title" content="Group title"><meta property="og:description" content="Group description"></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as typeof fetch;
    try {
      const text = "https://example.com/group";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        target: "group-status",
        cacheScope: `test-status-${Date.now()}`,
      });
      expect(content).toMatchObject({
        groupStatus: true,
        text,
        linkPreview: {
          title: "Group title",
          description: "Group description",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes a tall source without upscaling or cropping", async () => {
    const source = await sharp({
      create: {
        width: 420,
        height: 2400,
        channels: 3,
        background: { r: 130, g: 60, b: 20 },
      },
    })
      .png()
      .toBuffer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("tall.png"))
        return new Response(source, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      return new Response(
        '<meta property="og:title" content="Tall"><meta property="og:description" content="Complete"><meta property="og:image" content="https://example.com/tall.png">',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const content = await prepareCanonicalPreviewContent({
        text: "https://example.com/tall-page",
        content: { text: "https://example.com/tall-page" },
        cacheScope: `test-tall-${Date.now()}`,
      });
      const preview = content.linkPreview as Record<string, unknown>;
      const metadata = await sharp(preview.jpegThumbnail as Buffer).metadata();
      expect(metadata.format).toBe("jpeg");
      expect(metadata.width).toBe(336);
      expect(metadata.height).toBe(1920);
      expect(metadata.width! / metadata.height!).toBeCloseTo(420 / 2400, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses a socket uploader once for repeated native preview sends", async () => {
    const originalFetch = globalThis.fetch;
    let uploads = 0;
    const source = await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 42, g: 82, b: 140 },
      },
    })
      .jpeg()
      .toBuffer();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("card.jpg"))
        return new Response(source, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      return new Response(
        '<meta property="og:title" content="Uploaded"><meta property="og:description" content="Native"><meta property="og:image" content="https://example.com/card.jpg">',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const socket = {
        waUploadToServer: async () => {
          uploads += 1;
          return {
            directPath: "/thumbnail",
            mediaKey: Buffer.alloc(32),
            fileSha256: Buffer.alloc(32),
            fileEncSha256: Buffer.alloc(32),
            mediaKeyTimestamp: 1,
          };
        },
      };
      const text = "https://example.com/uploaded";
      const scope = `test-upload-${Date.now()}`;
      const first = await prepareCanonicalPreviewContent({ text, content: { text }, socket, cacheScope: scope });
      const second = await prepareCanonicalPreviewContent({ text, content: { text }, socket, cacheScope: scope });
      expect(
        (first.linkPreview as Record<string, unknown>).highQualityThumbnail,
      ).toMatchObject({ directPath: "/thumbnail" });
      expect(
        (second.linkPreview as Record<string, unknown>).highQualityThumbnail,
      ).toMatchObject({ directPath: "/thumbnail" });
      expect(uploads).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves media captions and original payload when the native hybrid is unsupported", async () => {
    const content = {
      image: Buffer.from("image"),
      caption: "See https://example.com/article",
    };
    await expect(
      prepareCanonicalPreviewContent({
        text: content.caption,
        content,
        cacheScope: `test-media-${Date.now()}`,
      }),
    ).resolves.toEqual(content);
  });

  it("does not alter an already complete preview", async () => {
    const content = {
      text: "https://example.com/article",
      linkPreview: {
        title: "Complete",
        description: "Already built",
        jpegThumbnail: Buffer.from("jpeg"),
      },
    };
    await expect(
      prepareCanonicalPreviewContent({
        text: content.text,
        content,
        cacheScope: `test-complete-${Date.now()}`,
      }),
    ).resolves.toEqual(content);
    expect(isCompletePreview(content.linkPreview)).toBe(true);
  });

  it("coalesces concurrent sends of one URL into one resolver pass", async () => {
    let htmlFetches = 0;
    let imageFetches = 0;
    const source = await sharp({
      create: {
        width: 800,
        height: 500,
        channels: 3,
        background: { r: 12, g: 80, b: 160 },
      },
    })
      .jpeg()
      .toBuffer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const requested = String(input);
      if (requested.endsWith("card.jpg")) {
        imageFetches += 1;
        return new Response(source, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      htmlFetches += 1;
      return new Response(
        '<meta property="og:title" content="Cached"><meta property="og:description" content="Once"><meta property="og:image" content="https://example.com/card.jpg">',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const text = "https://example.com/cached";
      const scope = `test-coalesce-${Date.now()}`;
      await Promise.all([
        prepareCanonicalPreviewContent({ text, content: { text }, cacheScope: scope }),
        prepareCanonicalPreviewContent({ text, content: { text }, cacheScope: scope }),
      ]);
      expect(htmlFetches).toBe(1);
      expect(imageFetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the exact original content when metadata fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 503 }),
    ) as typeof fetch;
    try {
      const content = { text: "https://example.com/failing" };
      await expect(
        prepareCanonicalPreviewContent({
          text: content.text,
          content,
          cacheScope: `test-failure-${Date.now()}`,
        }),
      ).resolves.toEqual(content);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
