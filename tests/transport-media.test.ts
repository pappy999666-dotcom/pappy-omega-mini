import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
  groupMetadata: vi.fn(async () => ({
    participants: [
      { id: "2348011111111@s.whatsapp.net" },
      { id: "2348022222222@s.whatsapp.net" },
    ],
  })),
  query: vi.fn(async () => ({
    content: [
      {
        tag: "participating",
        content: [
          { tag: "group", attrs: { id: "120363000000000001@g.us" } },
          { tag: "group", attrs: { jid: "120363000000000002@g.us" } },
          { tag: "group", attrs: { id: "user@s.whatsapp.net" } },
        ],
      },
    ],
  })),
}));

vi.mock("../src/whatsapp/session-manager.js", () => ({
  getWhatsAppSocket: () => ({
    sendMessage: mocks.send,
    groupMetadata: mocks.groupMetadata,
    query: mocks.query,
  }),
}));

import {
  listGroupJids,
  sendGroupMentions,
  sendGroupStatus,
  sendGroupText,
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

  it("resolves group JIDs through the lightweight raw inventory path", async () => {
    mocks.query.mockClear();
    const jids = await listGroupJids("raw-groups", "session");
    expect(jids).toEqual([
      "120363000000000001@g.us",
      "120363000000000002@g.us",
    ]);
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
