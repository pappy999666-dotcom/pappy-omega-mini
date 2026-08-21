import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "telegraf";
import {
  mergeTelegramQuotedText,
  resolveTelegramQuotedMedia,
} from "../src/telegram/bot.js";

function telegramContext(quoted: Record<string, unknown>): Context {
  return {
    message: { reply_to_message: quoted },
    telegram: {
      getFileLink: vi.fn(async (fileId: string) => ({
        href: `https://telegram.test/${fileId}`,
      })),
    },
  } as unknown as Context;
}

describe("Telegram quoted-message integration payloads", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("composes quoted broadcast text before the new command text", () => {
    expect(mergeTelegramQuotedText("append this", "original announcement")).toBe(
      "original announcement\nappend this",
    );
    expect(mergeTelegramQuotedText("only text")).toBe("only text");
    expect(mergeTelegramQuotedText("  new  ", "  old  ")).toBe("old\nnew");
  });

  it.each([
    {
      name: "photo",
      quoted: { photo: [{ file_id: "photo-file" }], caption: "photo caption" },
      kind: "image",
      mimeType: "image/jpeg",
    },
    {
      name: "video",
      quoted: { video: { file_id: "video-file", mime_type: "video/mp4" } },
      kind: "video",
      mimeType: "video/mp4",
    },
    {
      name: "document",
      quoted: {
        document: {
          file_id: "document-file",
          file_name: "payload.txt",
          mime_type: "text/plain",
        },
      },
      kind: "document",
      mimeType: "text/plain",
    },
    {
      name: "audio",
      quoted: {
        audio: {
          file_id: "audio-file",
          file_name: "voice.ogg",
          mime_type: "audio/ogg",
          voice: true,
        },
      },
      kind: "audio",
      mimeType: "audio/ogg",
    },
    {
      name: "sticker",
      quoted: { sticker: { file_id: "sticker-file", is_animated: false } },
      kind: "sticker",
      mimeType: "image/webp",
    },
  ])("downloads and normalizes quoted $name media", async ({ quoted, kind, mimeType }) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": mimeType },
      }),
    ) as typeof fetch;

    const result = await resolveTelegramQuotedMedia(telegramContext(quoted));

    expect(result).toMatchObject({ kind, mimeType, bytes: Buffer.from([1, 2, 3, 4]) });
    expect(result?.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("returns no payload when the incoming Telegram message has no reply", async () => {
    const ctx = {
      message: { text: "not a reply" },
      telegram: { getFileLink: vi.fn() },
    } as unknown as Context;
    await expect(resolveTelegramQuotedMedia(ctx)).resolves.toBeUndefined();
  });

  it("fails loudly when quoted media cannot be downloaded", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unavailable", { status: 503 }),
    ) as typeof fetch;
    await expect(
      resolveTelegramQuotedMedia(
        telegramContext({ photo: [{ file_id: "offline-file" }] }),
      ),
    ).rejects.toThrow(/download failed with 503/);
  });
});
