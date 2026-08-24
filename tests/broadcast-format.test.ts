import { describe, expect, it } from "vitest";
import { formatBroadcastReadyMessage } from "../src/jobs/broadcast-format.js";
import { createGroupStatusDesign } from "../src/whatsapp/status-design.js";
import { workloadPanelKeyboard } from "../src/telegram/ui.js";
import {
  createCommandRegistry,
  executeCommand,
  type CommandContext,
} from "../src/whatsapp/command-registry.js";

describe("broadcast READY formatter", () => {
  it.each(["allstatus", "allchat"] as const)(
    "renders real line breaks for %s",
    (kind) => {
      const rendered = formatBroadcastReadyMessage({
        kind,
        totalGroups: 25,
        expectedPosts: 25,
        delaySeconds: 20,
        expectedMinutes: 8,
        expectedSeconds: 0,
        jobCode: "9ADD871D",
      });
      expect(rendered).toContain("Total groups  · 25\nExpected posts · 25");
      expect(rendered).not.toContain("\\n");
      expect(rendered).toContain(
        kind === "allstatus"
          ? "Status delivery is now posting"
          : "Hidden-member mention delivery is now posting",
      );
    },
  );
});


describe("workload dashboard copy controls", () => {
  it("renders the workload code itself as a native copyable button", () => {
    const code = "pappy-v3-e75015";
    const markup = workloadPanelKeyboard(code) as unknown as {
      inline_keyboard: Array<Array<Record<string, unknown>>>;
    };
    expect(markup.inline_keyboard[0]?.[0]).toMatchObject({
      text: code,
      copy_text: { text: code },
    });
  });

  it("hides owner controls from a shared-panel child workspace", () => {
    const markup = workloadPanelKeyboard("pappy-v3-e75015", true) as unknown as {
      inline_keyboard: Array<Array<Record<string, unknown>>>;
    };
    const labels = markup.inline_keyboard.flat().map((button) => String(button.text));
    expect(labels).toContain("↩ Unlink Shared Panel");
    expect(labels).not.toContain("🔗 Share This Panel");
    expect(labels).not.toContain("▣ Logger");
    expect(labels).not.toContain("🗑 Remove Workload");
  });
});

describe("styled group-status design", () => {
  it("keeps the URL while producing different group-aware designs", () => {
    const url = "https://example.com/post";
    const first = createGroupStatusDesign({ groupName: "Alpha", text: url, seed: "one" });
    const second = createGroupStatusDesign({ groupName: "Beta", text: url, seed: "two" });
    expect(first.text).toContain(url);
    expect(second.text).toContain(url);
    expect(first.text).toContain("Alpha");
    expect(second.text).toContain("Beta");
    expect(first.mode).toBe("url");
    expect(second.mode).toBe("url");
    expect(first.title).toBe("Alpha");
    expect(second.title).toBe("Beta");
    expect(first.text).toMatch(/𓍢ִ໋✧|˚\.✦|ᰔ|⟡|⋆˚࿔|✧/);
    expect(first.text).not.toContain("𝗟𝗜𝗡𝗞 𝗗𝗥𝗢𝗣");
    expect(first.text).not.toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    expect(first.text !== second.text || first.backgroundColor !== second.backgroundColor).toBe(true);
    expect(first.backgroundColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(first.backgroundColor).not.toBe("#000000");

    const plain = createGroupStatusDesign({ groupName: "Alpha", text: "Hello everyone", seed: "plain" });
    expect(plain.mode).toBe("text");
    expect(plain.text).toContain("Alpha");
    expect(plain.text).toContain("Hello everyone");
    expect(plain.text).not.toContain("OPEN LINK");
    expect(plain.text).not.toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  });

  it("executes allstatusd as a styled all-group status job", async () => {
    let captured: { kind: string; payload: Record<string, unknown> } | undefined;
    const context: CommandContext = {
      workspaceId: "broadcast-alias-test",
      sessionId: "session-1",
      isOwner: true,
      args: [],
      enqueueJob: async (input) => {
        captured = input;
        return {
          jobCode: "DALL1234",
          totalGroups: 2,
          totalPosts: 2,
          delayMs: 1000,
          expectedTimeMs: 1000,
        };
      },
    };
    await executeCommand(
      createCommandRegistry(),
      "allstatusd https://example.com/post",
      context,
    );
    expect(captured).toMatchObject({
      kind: "allstatus",
      payload: { text: "https://example.com/post", count: 1, styled: true },
    });
  });

  it("acknowledges panel worker-local allstatusd without false inventory failure", async () => {
    const result = await executeCommand(
      createCommandRegistry(),
      "allstatusd https://example.com/post",
      {
        workspaceId: "panel-ack-test",
        sessionId: "session-1",
        isOwner: true,
        args: [],
        enqueueJob: async () => ({
          jobCode: "PANEL1234",
          delayMs: 20_000,
          workerLocal: true,
        }),
      },
    );
    expect(result).toContain("ALL-STATUS STARTED");
    expect(result).toContain("dispatched to the owning panel worker");
    expect(result).not.toContain("resolving");
    expect(result).not.toContain("was not started");
    expect(result).not.toContain("No broadcast was dispatched");
    expect(result).not.toContain("\\n");
  });

  it("acknowledges non-panel inventory-deferred broadcasts without false failure", async () => {
    const result = await executeCommand(
      createCommandRegistry(),
      "allstatusd https://example.com/post",
      {
        workspaceId: "vps-ack-test",
        sessionId: "session-1",
        isOwner: true,
        args: [],
        enqueueJob: async () => ({
          jobCode: "VPS12345",
          delayMs: 20_000,
          inventoryDeferred: true,
        }),
      },
    );
    expect(result).toContain("ALL-STATUS STARTED");
    expect(result).toContain("dispatched to the broadcast worker");
    expect(result).not.toContain("resolving");
    expect(result).not.toContain("No broadcast was dispatched");
  });

  it("covers the supplied kawaii layout catalog and varies by execution seed", () => {
    const url = "https://chat.whatsapp.com/LINK";
    const outputs = Array.from({ length: 200 }, (_, index) =>
      createGroupStatusDesign({
        groupName: "Angel Garden",
        title: "Angel Garden",
        text: url,
        seed: `execution-${index}`,
      }),
    );
    const combined = outputs.map((design) => design.text).join("\\n");
    expect(combined).toContain("𓍢ִ໋✧");
    expect(combined).toContain("˚.✦");
    expect(combined).toContain("ᰔ Ɛゝ");
    expect(combined).toContain("╭─ Ɛゝ");
    expect(combined).toContain("┈─𓏲");
    expect(combined).toContain("⟡─── Ɛゝ");
    expect(combined).toContain("⋆˚࿔");
    expect(combined).toContain(".・゜-: ✧");
    expect(combined).toContain("~〜~ ✧");
    expect(outputs.every((design) => design.mode === "url" && design.text.includes(url))).toBe(true);
    expect(new Set(outputs.map((design) => design.text)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(outputs.map((design) => design.backgroundColor)).size).toBeGreaterThanOrEqual(2);
  });

  it("registers styled status commands separately from ordinary status commands", () => {
    const names = createCommandRegistry().map((command) => command.name);
    expect(names).toContain("gstatus");
    expect(names).toContain("dgstatus");
    expect(names).toContain("allstatus");
    expect(names).toContain("dallstatus");
  });
});
