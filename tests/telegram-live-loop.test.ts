import { describe, expect, it } from "vitest";
import { classifyLiveEditError } from "../src/telegram/bot.js";

describe("Telegram Live Show refresh error handling", () => {
  it("keeps the loop alive when Telegram reports an unchanged message", () => {
    expect(classifyLiveEditError(new Error("Bad Request: message is not modified"))).toBe("benign");
  });

  it("keeps the loop alive for transient Telegram or network failures", () => {
    expect(classifyLiveEditError(new Error("TelegramError: 429 Too Many Requests"))).toBe("transient");
    expect(classifyLiveEditError(new Error("request timed out while editing message"))).toBe("transient");
    expect(classifyLiveEditError(new Error("ECONNRESET"))).toBe("transient");
  });

  it("stops only the display loop when the Telegram message is gone", () => {
    expect(classifyLiveEditError(new Error("Bad Request: message to edit not found"))).toBe("display-gone");
    expect(classifyLiveEditError(new Error("query is too old and response timeout expired"))).toBe("display-gone");
  });

  it("does not hide unexpected errors", () => {
    expect(classifyLiveEditError(new Error("Bad Request: chat is unavailable"))).toBe("fatal");
  });
});
