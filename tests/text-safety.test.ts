import { describe, expect, it } from "vitest";
import { telegramSafeText } from "../src/telegram/text-safety.js";

describe("Telegram text safety", () => {
  it("replaces malformed surrogate sequences before rendering button labels", () => {
    const safe = telegramSafeText(`valid\ud800name\udc00`);
    expect(safe).toBe("valid�name�");
    expect([...safe].every((character) => {
      const code = character.charCodeAt(0);
      return code < 0xd800 || code > 0xdfff;
    })).toBe(true);
  });
});
