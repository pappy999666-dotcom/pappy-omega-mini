import { describe, expect, it } from "vitest";
import {
  PreviewManager,
  assertSafePreviewUrl,
  canonicalize,
} from "../src/preview/preview-manager.js";
import sharp from "sharp";
import {
  decodeHtmlEntities,
  firstHttpUrl,
  linkPreviewPayload,
  resolveWhatsAppGroupInvitePreview,
} from "../src/preview/default-adapter.js";
import { buildNativeGroupStatusPreviewContent } from "../src/whatsapp/outbound-preview.js";
import {
  extractWhatsAppGroupInviteUrls,
  isWhatsAppGroupInviteUrl,
} from "../src/links/link-collector.js";

function redisMock() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
  } as never;
}

describe("preview acceptance safeguards", () => {
  it("resolves a WhatsApp group avatar from the connected socket at high quality", async () => {
    const source = await sharp({
      create: {
        width: 1500,
        height: 1000,
        channels: 3,
        background: { r: 36, g: 84, b: 140 },
      },
    })
      .jpeg({ quality: 98 })
      .toBuffer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const requested = String(input);
      if (requested === "https://cdn.example.test/group-avatar.jpg") {
        return new Response(source, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const resolved = await resolveWhatsAppGroupInvitePreview(
        "https://chat.whatsapp.com/ABC123",
        {
          groupGetInviteInfo: async () => ({
            id: "120363000000000001@g.us",
            subject: "Earthens",
            size: 42,
          }),
          profilePictureUrl: async () =>
            "https://cdn.example.test/group-avatar.jpg",
        },
      );
      expect(resolved?.title).toBe("Earthens");
      expect(resolved?.description).toBe("42 members");
      expect(resolved?.thumbnailData).toBeTruthy();
      const output = await sharp(
        Buffer.from(resolved!.thumbnailData!, "base64"),
      ).metadata();
      expect(output.width).toBe(1500);
      expect(output.height).toBe(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("canonicalizes URLs and removes fragments", () => {
    expect(canonicalize("HTTPS://Example.com/a#fragment")).toBe(
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

  it("decodes escaped metadata and detects URLs embedded in text", () => {
    expect(decodeHtmlEntities("Channel &#x1f4e2; &amp; news")).toBe(
      "Channel 📢 & news",
    );
    expect(
      firstHttpUrl("Join this text: https://chat.whatsapp.com/ABC123."),
    ).toBe("https://chat.whatsapp.com/ABC123");
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

  it("emits normalized thumbnail bytes when the resolver has them", () => {
    const payload = linkPreviewPayload(
      {
        schemaVersion: 2,
        canonicalUrl: "https://example.com/a",
        title: "Title",
        description: "Description",
        thumbnailData: Buffer.from("jpeg").toString("base64"),
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        fallback: false,
      },
      "Read https://example.com/a",
    );
    expect(payload).toMatchObject({
      text: "Read https://example.com/a",
      linkPreview: { title: "Title", jpegThumbnail: Buffer.from("jpeg") },
    });
  });

  it("builds the native Bailey group-status preview contract", () => {
    const content = buildNativeGroupStatusPreviewContent(
      { groupStatus: true },
      {
        schemaVersion: 2,
        canonicalUrl: "https://chat.whatsapp.com/ABC123",
        title: "Mythic Vault",
        description: "A channel preview",
        thumbnailUrl: "https://cdn.example.com/card.jpg",
        thumbnailData: Buffer.from("low-res-cache").toString("base64"),
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        fallback: false,
      },
    );
    expect(content).toMatchObject({
      groupStatus: true,
      richPreview: true,
      text: "https://chat.whatsapp.com/ABC123",
      previewTitle: "Mythic Vault",
      previewDescription: "A channel preview",
      previewImage: Buffer.from("low-res-cache"),
    });
    expect(content).not.toHaveProperty("jpegThumbnail");
  });

  it("returns a safe fallback when the adapter fails", async () => {
    const manager = new PreviewManager(redisMock(), {
      fetch: async () => {
        throw new Error("upstream failure");
      },
    });
    const result = await manager.resolve("https://example.com/article");
    expect(result.fallback).toBe(true);
    expect(result.canonicalUrl).toBe("https://example.com/article");
  });
});
