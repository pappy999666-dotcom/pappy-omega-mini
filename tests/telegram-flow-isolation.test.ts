import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const botSourcePath = new URL("../src/telegram/bot.ts", import.meta.url);

describe("Telegram guided-flow isolation", () => {
  it("does not let persisted pairing consume an active admin input flow", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain(
      'if (pairing && !pendingAdminInput.has(userId) && !ctx.message.text.startsWith("/"))',
    );
    expect(source.indexOf("const pairing =")).toBeLessThan(
      source.indexOf("const adminInput = pendingAdminInput.get(userId)"),
    );
  });

  it("makes callback edit failures visible instead of silently returning", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain("This view could not be updated. Tap Refresh to try again.");
    expect(source).toContain("async function showGroupSelectionExpired");
    expect(source).toContain("↻ Reload My Groups");
  });

  it("clears persisted pairing state when a new guided flow claims input", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain("clearPendingPairing(userId);");
    expect(source).toContain(
      'beginExclusiveInput(userId);\n    pendingAdminInput.set(userId, "workload:name");',
    );
    expect(source).toContain(
      'beginExclusiveInput(String(ctx.from?.id ?? ""));\n  if (!requestedName.trim()) return beginPairingWizard(ctx);',
    );
  });
});
