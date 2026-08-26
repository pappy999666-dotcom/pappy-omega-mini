import { describe, expect, it } from "vitest";
import { parseTelegramStickerRef, TELEGRAM_STICKER_PACK_LIMIT } from "../src/whatsapp/telegram-sticker.js";

describe("Telegram sticker import", () => {
  it("parses full addstickers links and optional selection", () => {
    expect(parseTelegramStickerRef("https://t.me/addstickers/ExamplePack 3")).toEqual({ packName: "ExamplePack", selection: 3 });
    expect(parseTelegramStickerRef("tg://addstickers?set=ExamplePack")).toEqual({ packName: "ExamplePack" });
  });

  it("parses bare pack names and clamps selection to one", () => {
    expect(parseTelegramStickerRef("ExamplePack 0")).toEqual({ packName: "ExamplePack", selection: 1 });
  });

  it("rejects unrelated links and empty input", () => {
    expect(parseTelegramStickerRef("https://t.me/example/123")).toBeNull();
    expect(parseTelegramStickerRef("")).toBeNull();
  });

  it("uses the native WhatsApp pack safety limit", () => {
    expect(TELEGRAM_STICKER_PACK_LIMIT).toBe(60);
  });
});
