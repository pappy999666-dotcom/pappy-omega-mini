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

  it("uses the exact native richPreview contract for a URL text message", async () => {
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
        richPreview: true,
        text,
        previewTitle: "Example title",
        previewDescription: "Example description",
      });
      expect(Buffer.isBuffer(content.previewImage)).toBe(true);
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
        richPreview: true,
        groupStatus: true,
        text,
        previewTitle: "Group title",
        previewDescription: "Group description",
      });
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
