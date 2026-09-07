import { afterEach, describe, expect, it } from "vitest";
import {
  buildDosHtmlScreen,
  dosBeaconUrl,
} from "../src/whatsapp/digital-os/html-app.js";
import type { DosRow } from "../src/whatsapp/digital-os/builder.js";
import {
  createDosSession,
  resetDosSessions,
} from "../src/whatsapp/digital-os/session.js";
import {
  handleDosHtmlBeacon,
} from "../src/whatsapp/digital-os/app.js";
import type { CommandContext } from "../src/whatsapp/command-registry.js";
import { loadGroupAntiConfig } from "../src/whatsapp/anti-system/config.js";

const WS = "ws-html";
const SESS = "sess-html";
const GROUP = "120363000000000000@g.us";
const OWNER = "15550001111@s.whatsapp.net";
const BOT = "15550990000";

afterEach(() => {
  resetDosSessions();
});

describe("beacon links", () => {
  it("builds wa.me deep links carrying the .ic backend command", () => {
    const url = dosBeaconUrl(BOT, "tok123", "toggle", "mod:antilink.enabled", "1");
    expect(url).toContain(`https://wa.me/${BOT}?text=`);
    expect(decodeURIComponent(url)).toContain(".ic tok123 toggle mod:antilink.enabled 1");
  });
});

describe("HTML app container", () => {
  const rows: DosRow[] = [
    { kind: "heading", text: "ANTILINK" },
    { kind: "toggle", id: "mod:antilink.enabled", label: "Enable", value: true },
    {
      kind: "cycle",
      id: "mod:antilink.action",
      label: "Action",
      options: ["kick", "warn", "delete"],
      index: 0,
    },
  ];

  it("renders the slot-machine-style HTML/JS container with morphing controls", () => {
    const html = buildDosHtmlScreen({
      token: "tok123",
      botNumber: BOT,
      title: "ANTI · LINK",
      rows,
      showDone: true,
      showBack: true,
    });
    expect(html).toContain("PAPPY OS");
    expect(html).toContain("ANTI · LINK");
    expect(html).toContain("data-op=\"toggle\"");
    expect(html).toContain("class=\"chk on\"");
    expect(html).toContain("data-op=\"cycle\"");
    expect(html).toContain("href=\"https://wa.me/" + BOT + "?text=");
    expect(html).toContain("<script>");
    expect(html).toContain("data-v=\"1\"");
    // Local morph happens in-page, no native-flow payload anywhere.
    expect(html).not.toContain("nativeFlowMessage");
    expect(html).not.toContain("interactiveMessage");
  });

  it("keeps the mobile layout single-line and compact", () => {
    const html = buildDosHtmlScreen({
      token: "tok123",
      botNumber: BOT,
      title: "DRAWER",
      rows: [
        { kind: "tile", id: "anti:home", label: "Anti System", badge: "config" },
      ],
    });
    expect(html).toMatch(/\.rows\{display:flex;flex-direction:column;gap:6px\}/u);
    expect(html).not.toMatch(/\n\n/u);
  });
});

describe("beacon round trip (HTML mode)", () => {
  it("morphs state via the .ic beacon and commits Done to GroupAntiConfig", () => {
    const draft = createDosSession({
      workspaceId: WS,
      sessionId: SESS,
      chatJid: GROUP,
      initiatorJid: OWNER,
      appId: "os",
      screen: "anti:module:antilink",
      stack: ["drawer", "anti:home", "anti:module:antilink"],
    });
    const ctx: CommandContext = {
      workspaceId: WS,
      sessionId: SESS,
      chatJid: "15550001111@s.whatsapp.net",
      senderJid: OWNER,
      isOwner: true,
      args: [],
    };

    const toggle = handleDosHtmlBeacon(ctx, [draft.token, "toggle", "mod:antilink.enabled", "1"]);
    expect(toggle).toContain("✓");
    const cycle = handleDosHtmlBeacon(ctx, [draft.token, "cycle", "mod:antilink.action", "warn"]);
    expect(cycle).toContain("warn");
    const step = handleDosHtmlBeacon(ctx, [draft.token, "step", "mod:antilink.warnThreshold", "1"]);
    expect(step).toContain("4");

    const done = handleDosHtmlBeacon(ctx, [draft.token, "done"]);
    expect(done).toContain("SAVED");

    const config = loadGroupAntiConfig(WS, SESS, GROUP);
    expect(config.antilink?.enabled).toBe(true);
    expect(config.antilink?.action).toBe("warn");
    expect(config.antilink?.warnThreshold).toBe(4);
  });

  it("rejects a stranger's beacon and resets stale tokens to a fresh drawer", () => {
    const draft = createDosSession({
      workspaceId: WS,
      sessionId: SESS,
      chatJid: GROUP,
      initiatorJid: OWNER,
      appId: "os",
      screen: "drawer",
    });
    const stranger: CommandContext = {
      workspaceId: WS,
      sessionId: SESS,
      chatJid: "15550002222@s.whatsapp.net",
      senderJid: "15550002222@s.whatsapp.net",
      isOwner: false,
      args: [],
    };
    expect(handleDosHtmlBeacon(stranger, [draft.token, "open", "anti:home"])).toMatch(
      /Unauthorized/u,
    );
    const owner: CommandContext = {
      ...stranger,
      senderJid: OWNER,
      isOwner: true,
      chatJid: "15550001111@s.whatsapp.net",
    };
    const reset = handleDosHtmlBeacon(owner, ["deadbeef00badc0ffee000", "open", "anti:home"]);
    // A stale/unknown beacon re-opens the living drawer inside the container
    // (or, in a session-less test env, degrades to a polite note — never the
    // raw usage text).
    if (typeof reset === "string") {
      expect(reset).not.toMatch(/Usage: \.ic/u);
    } else {
      const reply = reset as {
        text?: string;
        nativeFlow?: Array<{ id: string }>;
        htmlBubble?: string;
      };
      const bubble = reply.htmlBubble ?? reply.text ?? "";
      expect(bubble).toContain("PAPPY OS");
      // The functional control deck travels with every screen (card or not).
      expect(reply.nativeFlow?.some((button) => button.id.startsWith("dos:"))).toBe(true);
      expect(reply.htmlBubble ?? "").not.toContain("nativeFlowMessage");
    }
  });

  it("re-renders beacon navigation as a card+deck reply (deck always present)", () => {
    const ctx: CommandContext = {
      workspaceId: WS,
      sessionId: SESS,
      chatJid: "15550001111@s.whatsapp.net",
      senderJid: OWNER,
      isOwner: true,
      args: [],
    };
    const draft = createDosSession({
      workspaceId: WS,
      sessionId: SESS,
      chatJid: GROUP,
      initiatorJid: OWNER,
      appId: "os",
      screen: "anti:module:antilink",
      stack: ["drawer", "anti:home", "anti:module:antilink"],
    });
    const opened = handleDosHtmlBeacon(ctx, [draft.token, "open", "demo:home"]);
    expect(typeof opened).toBe("object");
    const reply = opened as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(reply.text).toContain("OS LIVE DEMO");
    expect(reply.nativeFlow?.some((button) => button.id.startsWith(`dos:${draft.token}:`))).toBe(true);
  });

  it("runs the live demo matrix: toggles, chips, stepper and Done summary", () => {
    const ctx: CommandContext = {
      workspaceId: WS,
      sessionId: SESS,
      chatJid: "15550001111@s.whatsapp.net",
      senderJid: OWNER,
      isOwner: true,
      args: [],
    };
    const draft = createDosSession({
      workspaceId: WS,
      sessionId: SESS,
      chatJid: GROUP,
      initiatorJid: OWNER,
      appId: "os",
      screen: "demo:home",
      stack: ["drawer", "demo:home"],
    });
    expect(handleDosHtmlBeacon(ctx, [draft.token, "toggle", "demo.sound", "1"])).toContain("Sound on");
    expect(handleDosHtmlBeacon(ctx, [draft.token, "cycle", "demo.action", "kick"])).toContain("kick");
    expect(handleDosHtmlBeacon(ctx, [draft.token, "step", "demo.count", "1"])).toContain("4");
    const done = handleDosHtmlBeacon(ctx, [draft.token, "done"]);
    expect(done).toContain("OS LIVE DEMO");
    expect(done).toContain("Enabled 1/6");
    expect(done).toContain("Nothing was persisted");
  });
});
