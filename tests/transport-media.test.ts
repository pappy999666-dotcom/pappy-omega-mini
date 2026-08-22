import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
  sendStatus: vi.fn(async () => undefined),
  groupMetadata: vi.fn(async () => ({
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
    groupMetadata: mocks.groupMetadata,
  }),
}));

import {
  sendGroupMentions,
  sendGroupStatus,
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
    expect(content.statusJidList).toEqual(["2348012345678:1@s.whatsapp.net"]);
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
