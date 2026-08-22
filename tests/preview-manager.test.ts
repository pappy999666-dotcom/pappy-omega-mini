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
    expect(
      canonicalizePreviewUrl(
        "https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ?s=cl&p=a&mlu=4",
      ),
    ).toBe("https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ");
    expect(canonicalizePreviewUrl("https://example.com/a?x=1")).toBe(
      "https://example.com/a?x=1",
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

  it("resolves parameterized group invites through the bare invite code", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 404 }),
    ) as typeof fetch;
    try {
      const text =
        "Join this group now: https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ?s=cl&p=a&mlu=4 — welcome.";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        socket: {
          groupGetInviteInfo: async (code: string) => {
            calls.push(code);
            return { id: "120363000000000000@g.us", subject: "Pappy bugs", size: 42 };
          },
        },
        cacheScope: `test-query-invite-${Date.now()}`,
      });
      expect(calls).toEqual(["JjF3McLM5gIKNz7zaQKJbZ"]);
      expect(content.text).toBe(text);
      expect(content.linkPreview).toMatchObject({
        "matched-text": "https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ",
        "canonical-url": "https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ",
        title: "Pappy bugs",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("negative-caches failed group invite metadata", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    try {
      const socket = {
        groupGetInviteInfo: async () => {
          calls += 1;
          throw new Error("growth-locked");
        },
      };
      const text = "https://chat.whatsapp.com/NEGATIVE_CACHE_TEST";
      const cacheScope = `negative-cache-${Date.now()}`;
      await prepareCanonicalPreviewContent({ text, content: { text }, socket, cacheScope });
      await prepareCanonicalPreviewContent({ text, content: { text }, socket, cacheScope });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses public metadata without remote invite calls for assigned panel previews", async () => {
    const originalFetch = globalThis.fetch;
    let inviteCalls = 0;
    globalThis.fetch = vi.fn(async () => new Response("<html><head><title>Panel link</title></head></html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    try {
      const text = "https://chat.whatsapp.com/PANEL_PREVIEW_TEST";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        socket: {
          __pappyAssignedWorkload: true,
          groupGetInviteInfo: async () => {
            inviteCalls += 1;
            throw new Error("growth-locked");
          },
        } as never,
        cacheScope: `panel-preview-${Date.now()}`,
      });
      expect(inviteCalls).toBe(0);
      expect(content.text).toBe(text);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the stable public metadata variant for assigned-panel group invites", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const imageBytes = await sharp({
      create: {
        width: 443,
        height: 720,
        channels: 3,
        background: { r: 32, g: 120, b: 88 },
      },
    }).jpeg().toBuffer();
    globalThis.fetch = vi.fn(async (input) => {
      const requestUrl = String(input);
      calls.push(requestUrl);
      if (requestUrl.includes("pps.whatsapp.net"))
        return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
      expect(requestUrl).toContain("https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN?s=cl&p=a&mlu=4");
      return new Response(
        '<html><head><meta property="og:title" content="Gc closed"><meta property="og:description" content="WhatsApp Group Invite"><meta property="og:image" content="https://pps.whatsapp.net/group-preview.jpg"></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      let inviteCalls = 0;
      const text = "https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        socket: {
          __pappyAssignedWorkload: true,
          groupGetInviteInfo: async () => {
            inviteCalls += 1;
            throw new Error("growth-locked");
          },
        } as never,
        cacheScope: `panel-invite-query-${Date.now()}`,
      });
      expect(inviteCalls).toBe(0);
      expect(calls.some((value) => value.includes("?s=cl&p=a&mlu=4"))).toBe(true);
      expect(content.linkPreview).toMatchObject({
        "canonical-url": text,
        title: "Gc closed",
        description: "WhatsApp Group Invite",
      });
      expect(content.linkPreview).toHaveProperty("jpegThumbnail");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to an explicit native invite preview when WhatsApp metadata is rate-limited", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 429 })) as typeof fetch;
    try {
      const text = "https://chat.whatsapp.com/RATE_LIMITED_INVITE";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        socket: { __pappyAssignedWorkload: true } as never,
        cacheScope: `panel-invite-fallback-${Date.now()}`,
      });
      expect(content.linkPreview).toMatchObject({
        "canonical-url": text,
        title: "WhatsApp Group Invite",
        description: "Open this WhatsApp group invitation in WhatsApp.",
      });
      expect(content.linkPreview).toHaveProperty("jpegThumbnail");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts only WhatsApp group invite URLs for Validator Hub", async () => {
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

  it("recovers JSON-escaped image URLs from TikTok-style page data", async () => {
    const originalFetch = globalThis.fetch;
    const imageBytes = await sharp({
      create: {
        width: 720,
        height: 1280,
        channels: 3,
        background: { r: 220, g: 60, b: 100 },
      },
    }).jpeg().toBuffer();
    const encodedImage = "https:" + "\\u002F".repeat(2) + "example.com" + "\\u002Fpreview.jpg";
    globalThis.fetch = vi.fn(async (input) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/preview.jpg"))
        return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
      return new Response(`<html><head><title>TikTok - Make Your Day</title></head><body><script>window.__DATA__={cover:"${encodedImage}"}</script></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      const text = "https://vt.tiktok.com/ZSV5kDvDQ/";
      const content = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        cacheScope: `tiktok-embedded-image-${Date.now()}`,
      });
      expect(content.linkPreview).toMatchObject({
        "canonical-url": text,
        title: "TikTok - Make Your Day",
      });
      expect(content.linkPreview).toHaveProperty("jpegThumbnail");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
          previewType: 0,
          linkPreviewMetadata: {
            linkMediaDuration: 0,
            socialMediaPostType: 4,
          },
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
      ).toMatchObject({ directPath: "/thumbnail", width: 900, height: 600 });
      expect(
        (second.linkPreview as Record<string, unknown>).highQualityThumbnail,
      ).toMatchObject({ directPath: "/thumbnail", width: 900, height: 600 });
      expect(uploads).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves a bare domain into a native preview", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("https://example.com/article");
      return new Response(
        '<meta property="og:title" content="Bare domain"><meta property="og:description" content="Resolved safely">',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const content = { text: "Read example.com/article" };
      const prepared = await prepareCanonicalPreviewContent({
        text: content.text,
        content,
        cacheScope: `test-bare-domain-${Date.now()}`,
      });
      expect(prepared.linkPreview).toMatchObject({
        "matched-text": "https://example.com/article",
        "canonical-url": "https://example.com/article",
        title: "Bare domain",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves media bytes and adds a preview for a caption URL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        '<meta property="og:title" content="Caption link"><meta property="og:description" content="Native caption preview">',
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as typeof fetch;
    try {
      const content = {
        image: Buffer.from("image"),
        caption: "See https://example.com/article",
      };
      const prepared = await prepareCanonicalPreviewContent({
        text: content.caption,
        content,
        cacheScope: `test-media-${Date.now()}`,
      });
      expect(prepared.image).toBe(content.image);
      expect(prepared.caption).toBe(content.caption);
      expect(prepared.linkPreview).toMatchObject({ title: "Caption link" });
    } finally {
      globalThis.fetch = originalFetch;
    }
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
