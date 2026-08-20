import { describe, expect, it } from "vitest";
import { createDisplayKey, hashCredential, isFreshRequest, verifyCredential } from "../src/workload/security.js";
import { workloadGuideText } from "../src/telegram/ui.js";

describe("hybrid workload security primitives", () => {
  it("hashes and verifies worker credentials without accepting mutations", () => {
    const credential = "test-worker-credential-1234567890";
    const digest = hashCredential(credential);
    expect(digest).toHaveLength(64);
    expect(verifyCredential(credential, digest)).toBe(true);
    expect(verifyCredential(`${credential}-wrong`, digest)).toBe(false);
  });

  it("generates exactly five numeric display-key characters", () => {
    expect(createDisplayKey()).toMatch(/^\d{5}$/);
  });

  it("rejects stale control requests", () => {
    const now = 1_000_000;
    expect(isFreshRequest(now, now)).toBe(true);
    expect(isFreshRequest(now - 89_000, now)).toBe(true);
    expect(isFreshRequest(now - 91_000, now)).toBe(false);
  });

  it("keeps central secrets out of the noob-friendly worker guide", () => {
    const guide = workloadGuideText("https://control.example/workload");
    expect(guide).toContain("one saved workload code");
    expect(guide).toContain("pappy-ab12cd");
    expect(guide).toContain("Telegram");
    expect(guide).not.toContain("PAPPY_WORKLOAD_SESSION_SECRET");
    expect(guide).not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(guide).not.toContain("MONGODB_URI=");
    expect(guide).not.toContain("REDIS_URL=");
  });
});
