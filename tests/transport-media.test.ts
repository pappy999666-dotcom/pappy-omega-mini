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
  groupGetInviteInfo: vi.fn(async () => ({
    id: "120363999999999999@g.us",
    subject: "Source Invite Group",
    size: 777,
    profilePic: "https://source.example/image.jpg",
  })),
}));

vi.mock("../src/whatsapp/session-manager.js", () => ({
  getWhatsAppSocket: () => ({
    user: { id: "2348012345678:1@s.whatsapp.net" },
    sendMessage: mocks.send,
    sendStatus: mocks.sendStatus,
    getStatusJidList: mocks.getStatusJidList,
    groupMetadata: mocks.groupMetadata,
    groupGetInviteInfo: mocks.groupGetInviteInfo,
  }),
}));

import {
  filterAdminGroupSummaries,
  sendGroupMentions,
  sendGroupStatus,
  sendGroupColorStatus,
  sendGroupText,
  sendPersonalStatus,
} from "../src/whatsapp/transport-adapter.js";

describe("administrator group inventory", () => {
  it("keeps only groups where the WhatsApp identity is an administrator", () => {
    const groups = filterAdminGroupSummaries([
      { jid: "1@g.us", subject: "Admin group", participantCount: 10, isAdmin: true },
      { jid: "2@g.us", subject: "Member group", participantCount: 20, isAdmin: false },
      { jid: "3@g.us", subject: "Unknown group", participantCount: 30 },
    ]);
    expect(groups.map((group) => group.jid)).toEqual(["1@g.us"]);
  });
});

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
      expect(content.groupStatus).toBe(true);
      expect(content.groupStatusMessage).toBeUndefined();
      expect(content[key]).toBe(bytes);
      expect(content.mimetype).toBe(mimeType);
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

  it("uses live group metadata for a hidden-mention WhatsApp invite URL", async () => {
    mocks.send.mockClear();
    const originalFetch = globalThis.fetch;
    const tinyJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8hH//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8hH//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8hH//Z", "base64");
    globalThis.fetch = vi.fn(async (input) =>
      String(input).includes("source.example/image.jpg")
        ? new Response(tinyJpeg, { status: 200, headers: { "content-type": "image/jpeg" } })
        : new Response(null, { status: 503 }),
    ) as typeof fetch;
    const text = "https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN";
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
    expect(content.linkPreview).toMatchObject({
      title: "Source Invite Group",
      description: "777 members · WhatsApp Group",
    });
    expect(content.linkPreview).not.toMatchObject({ title: "Cyber Alpha" });
    expect(content.linkPreview).not.toMatchObject({ title: "WhatsApp Group Invite" });
    globalThis.fetch = originalFetch;
  });

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
