import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
  sendStatus: vi.fn(async () => undefined),
  getStatusJidList: vi.fn(async () => ["2348022222222@s.whatsapp.net"]),
  groupMetadata: vi.fn(async () => ({
    subject: "Cyber Alpha",
    participants: [
      { id: "2348011111111@s.whatsapp.net" },
      { id: "2348022222222@s.whatsapp.net" },
    ],
  })),
}));

vi.mock("../src/whatsapp/session-manager.js", () => ({
  getWhatsAppSocket: () => ({
    user: { id: "2348012345678:1@s.whatsapp.net" },
    sendMessage: mocks.send,
    sendStatus: mocks.sendStatus,
    getStatusJidList: mocks.getStatusJidList,
    groupMetadata: mocks.groupMetadata,
  }),
}));

import {
  sendGroupMentions,
  sendGroupStatus,
  sendGroupColorStatus,
  sendGroupText,
  sendPersonalStatus,
} from "../src/whatsapp/transport-adapter.js";

const mediaCases = [
  { kind: "image", key: "image", mimeType: "image/jpeg" },
  { kind: "video", key: "video", mimeType: "video/mp4" },
  { kind: "audio", key: "audio", mimeType: "audio/mp4" },
  { kind: "document", key: "document", mimeType: "application/pdf" },
  { kind: "sticker", key: "sticker", mimeType: "image/webp" },
] as const;

describe("WhatsApp media transport coverage", () => {
  it.each(mediaCases)(
    "keeps $kind bytes in an immediate group status payload",
    async ({ kind, key, mimeType }) => {
      mocks.send.mockClear();
      const bytes = Buffer.from(`${kind}-payload`);
      await sendGroupStatus("workspace", "session", "120363000000000001@g.us", {
        text: `${kind} status`,
        media: { kind, bytes, mimeType },
      });
      expect(mocks.send).toHaveBeenCalledOnce();
      const [, content] = mocks.send.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      const statusMessage = content.groupStatusMessage as Record<string, unknown> | undefined;
      const statusPayload = statusMessage ?? content;
      expect(statusPayload[key]).toBe(bytes);
      expect(statusPayload.mimetype).toBe(mimeType);
    },
  );

  it("uses Baileys sendStatus for a personal image status and never group status", async () => {
    mocks.send.mockClear();
    mocks.sendStatus.mockClear();
    const bytes = Buffer.from("personal-image-status");
    await sendPersonalStatus("workspace", "session", {
      text: "personal status",
      media: { kind: "image", bytes, mimeType: "image/jpeg" },
    });
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    const [content] = mocks.sendStatus.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(content.status).toBe(true);
    expect(content.statusJidList).toEqual([
      "2348022222222@s.whatsapp.net",
      "2348012345678@s.whatsapp.net",
    ]);
    expect(content.image).toBe(bytes);
    expect(content.caption).toBe("personal status");
    expect(content.mimetype).toBe("image/jpeg");
  });

  it.each(mediaCases)(
    "keeps $kind bytes in an all-group chat payload",
    async ({ kind, key, mimeType }) => {
      mocks.send.mockClear();
      const bytes = Buffer.from(`${kind}-chat-payload`);
      await sendGroupText(
        "workspace",
        "session",
        "120363000000000001@g.us",
        `${kind} chat`,
        { kind, bytes, mimeType },
      );
      expect(mocks.send).toHaveBeenCalledOnce();
      const [, content] = mocks.send.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(content[key]).toBe(bytes);
      expect(content.mimetype).toBe(mimeType);
    },
  );

  it("attaches a native link preview to a hidden-mention URL payload", async () => {
    mocks.send.mockClear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(
      "<html><head><meta property=\"og:title\" content=\"Example Link\"><meta property=\"og:description\" content=\"Example description\"></head></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )) as typeof fetch;
    try {
      const text = "Open https://example.com/tag-preview";
      await sendGroupMentions(
        "workspace",
        "session",
        "120363000000000001@g.us",
        text,
      );
      const [, content] = mocks.send.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(content.text).toBe(text);
      expect(content.linkPreview).toMatchObject({ title: "Example Link" });
      expect(content.mentions).toEqual([
        "2348011111111@s.whatsapp.net",
        "2348022222222@s.whatsapp.net",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(mediaCases)(
    "keeps $kind bytes in a hidden-mention payload",
    async ({ kind, key, mimeType }) => {
      mocks.send.mockClear();
      const bytes = Buffer.from(`${kind}-mention-payload`);
      await sendGroupMentions(
        "workspace",
        "session",
        "120363000000000001@g.us",
        `${kind} mention`,
        undefined,
        { kind, bytes, mimeType },
      );
      expect(mocks.send).toHaveBeenCalledOnce();
      const [, content] = mocks.send.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(content[key]).toBe(bytes);
      expect(content.mimetype).toBe(mimeType);
      expect(content.mentions).toEqual([
        "2348011111111@s.whatsapp.net",
        "2348022222222@s.whatsapp.net",
      ]);
    },
  );
});


describe("styled group status transport", () => {
  it("leaves ordinary text unstyled even when sent through the d-status adapter", async () => {
    mocks.send.mockClear();
    await sendGroupColorStatus(
      "workspace",
      "session",
      "120363000000000001@g.us",
      { text: "ordinary status text" },
    );
    expect(mocks.send).toHaveBeenCalledOnce();
    const [, content, options] = mocks.send.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ];
    expect(content.text).toBe("ordinary status text");
    expect(content.groupStatus).toBe(true);
    expect(options).toBeUndefined();
  });

  it("sends group-aware color metadata through Baileys generation options", async () => {
    mocks.send.mockClear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    try {
      await sendGroupColorStatus("workspace", "session", "120363000000000001@g.us", {
        text: "https://example.com/styled-card",
      });
      expect(mocks.groupMetadata).toHaveBeenCalled();
      expect(mocks.send).toHaveBeenCalledOnce();
      const [, content, options] = mocks.send.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(content.groupStatus).toBe(true);
      expect(content.text).toContain("Cyber Alpha");
      expect(content.text).toContain("https://example.com/styled-card");
      expect(content.backgroundColor).toBeUndefined();
      expect(content.textColor).toBeUndefined();
      expect(options.backgroundColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(options.backgroundColor).not.toBe("#000000");
      expect(typeof options.font).toBe("number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
