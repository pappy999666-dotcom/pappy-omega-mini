import { afterEach, describe, expect, it } from "vitest";
import {
  _expireDosSession,
  commitDosSession,
  createDosSession,
  createDosToken,
  dosSessionCount,
  getDosSession,
  isDosInteractionId,
  parseDosInteractionId,
  peekDosToken,
  resetDosSessions,
  updateDosSession,
} from "../src/whatsapp/digital-os/session.js";
import {
  auditDosLayout,
  renderDosPage,
  type DosRow,
} from "../src/whatsapp/digital-os/builder.js";
import {
  handleDosInteraction,
  openDosDrawer,
} from "../src/whatsapp/digital-os/app.js";
import type { CommandContext } from "../src/whatsapp/command-registry.js";
import {
  loadGroupAntiConfig,
} from "../src/whatsapp/anti-system/config.js";

const BASE = {
  workspaceId: "ws-digital",
  sessionId: "sess-digital",
  chatJid: "120363000000000000@g.us",
};
const OWNER = "15550001111@s.whatsapp.net";

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    workspaceId: BASE.workspaceId,
    sessionId: BASE.sessionId,
    chatJid: BASE.chatJid,
    senderJid: OWNER,
    isOwner: true,
    args: [],
    ...overrides,
  };
}

afterEach(() => {
  resetDosSessions();
});

describe("draft session store", () => {
  it("creates unique tokens bound to workspace+session+chat and sweeps expiry", () => {
    const one = createDosSession({ ...BASE, initiatorJid: OWNER, appId: "os", screen: "drawer" });
    const two = createDosSession({ ...BASE, initiatorJid: OWNER, appId: "os", screen: "drawer" });
    expect(one.token).not.toBe(two.token);
    expect(dosSessionCount()).toBe(2);

    const otherChat = getDosSession(BASE.workspaceId, BASE.sessionId, "15550009999@s.whatsapp.net", one.token);
    expect(otherChat).toBeUndefined();

    _expireDosSession(BASE.workspaceId, BASE.sessionId, BASE.chatJid, one.token);
    expect(getDosSession(BASE.workspaceId, BASE.sessionId, BASE.chatJid, one.token)).toBeUndefined();
    expect(peekDosToken(BASE.workspaceId, BASE.sessionId, BASE.chatJid, two.token).live).toBe(true);
  });

  it("updates values and marks a session committed one-shot", () => {
    const created = createDosSession({ ...BASE, initiatorJid: OWNER, appId: "os", screen: "drawer" });
    const updated = updateDosSession(created, { values: { "mod:antilink.enabled": true } });
    expect(updated.values["mod:antilink.enabled"]).toBe(true);

    commitDosSession(updated);
    expect(peekDosToken(BASE.workspaceId, BASE.sessionId, BASE.chatJid, created.token).live).toBe(false);
    expect(getDosSession(BASE.workspaceId, BASE.sessionId, BASE.chatJid, created.token)).toBeUndefined();
  });

  it("parses only the dos interaction grammar", () => {
    const token = createDosToken(OWNER);
    const id = `dos:${token}:x0`;
    expect(isDosInteractionId(id)).toBe(true);
    expect(isDosInteractionId(`dos:${token}:done`)).toBe(true);
    expect(isDosInteractionId("dc:confirm:abc")).toBe(false);
    const parsed = parseDosInteractionId(id);
    expect(parsed?.token).toBe(token);
    expect(parsed?.action).toBe("x0");
  });
});

describe("DigitalUIBuilder", () => {
  const rows: DosRow[] = [
    { kind: "heading", text: "ANTILINK" },
    { kind: "toggle", id: "enabled", label: "Enable", value: false, ctlText: "On" },
    { kind: "cycle", id: "action", label: "Action", options: ["kick", "warn", "delete"], index: 1 },
    { kind: "stepper", id: "warn", label: "Warn-limit", value: 3, min: 1, max: 10, default: 3 },
    { kind: "info", text: "Capability: supported" },
  ];

  it("keeps every bubble within the button budget and never emits blank/wide lines", () => {
    const first = renderDosPage({
      token: "tok123",
      appId: "anti",
      screen: "module:antilink",
      title: "📱 ANTI · LINK",
      rows,
      page: 0,
      maxButtons: 4,
      showDone: true,
      showBack: true,
    });
    for (let page = 0; page < first.pageCount; page += 1) {
      const rendered = renderDosPage({
        token: "tok123",
        appId: "anti",
        screen: "module:antilink",
        title: "TITLE",
        rows,
        page,
        maxButtons: 4,
        showDone: true,
        showBack: true,
      });
      expect(rendered.buttons.length).toBeLessThanOrEqual(4);
      expect(auditDosLayout(rendered.lines)).toEqual([]);
      // Compact single-line controls: no double newlines anywhere.
      expect(rendered.lines.join("\n")).not.toMatch(/\n\n/u);
    }
    // Done sits on the last page; the stepper shows its default indicator.
    const last = renderDosPage({
      token: "tok123",
      appId: "anti",
      screen: "module:antilink",
      title: "TITLE",
      rows,
      page: first.pageCount - 1,
      maxButtons: 4,
      showDone: true,
      showBack: true,
    });
    expect(last.buttons.some((button) => button.id.endsWith(":done"))).toBe(true);
    expect(last.lines.some((line) => line.includes("(d3)"))).toBe(true);
  });

  it("pages long control lists and keeps every page under the budget", () => {
    const many: DosRow[] = Array.from({ length: 9 }, (_, index) => ({
      kind: "toggle",
      id: `t${index}`,
      label: `T${index}`,
      value: false,
    }));
    const first = renderDosPage({ token: "tok", appId: "os", screen: "drawer", title: "DRAWER", rows: many, page: 0, maxButtons: 4, showDone: false });
    expect(first.pageCount).toBeGreaterThan(1);
    for (let page = 0; page < first.pageCount; page += 1) {
      const rendered = renderDosPage({ token: "tok", appId: "os", screen: "drawer", title: "DRAWER", rows: many, page, maxButtons: 4, showDone: false });
      expect(rendered.buttons.length).toBeLessThanOrEqual(4);
      expect(rendered.lines[0]).toContain(`(p${page + 1}/${first.pageCount})`);
    }
  });
});

describe("Digital OS app flow (drawer → anti module → Done)", () => {
  it("opens the drawer, navigates into a module, toggles, and commits to GroupAntiConfig", async () => {
    const drawer = openDosDrawer(context());
    expect(typeof drawer).toBe("object");
    const drawerReply = drawer as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(drawerReply.text).toContain("PAPPY OS");
    expect(drawerReply.nativeFlow?.some((button) => button.id.startsWith("dos:"))).toBe(true);
    expect((drawer as { htmlBubble?: string }).htmlBubble).toBeUndefined();

    const tileButton = drawerReply.nativeFlow?.find((button) => /:o\d+$/u.test(button.id));
    expect(tileButton).toBeDefined();
    const antiHome = await handleDosInteraction(tileButton!.id, context());
    const antiHomeReply = antiHome as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(antiHomeReply.text).toContain("ANTI SYSTEM");

    const groupButton = antiHomeReply.nativeFlow?.find((button) => /:o\d+$/u.test(button.id));
    expect(groupButton).toBeDefined();
    const groupScreen = await handleDosInteraction(groupButton!.id, context());
    const groupReply = groupScreen as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(groupReply.text).toContain("ANTI ·");

    const moduleButton = groupReply.nativeFlow?.find((button) => /:o\d+$/u.test(button.id));
    expect(moduleButton).toBeDefined();
    const moduleScreen = await handleDosInteraction(moduleButton!.id, context());
    const moduleReply = moduleScreen as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(moduleReply.text).toContain("ANTI ·");
    expect(moduleReply.text).toContain("Enable[ ]");

    // Toggle Enable on.
    const enableButton = moduleReply.nativeFlow?.find((button) => /:x\d+$/u.test(button.id));
    expect(enableButton).toBeDefined();
    const toggled = await handleDosInteraction(enableButton!.id, context());
    const toggledReply = toggled as { text: string };
    expect(toggledReply.text).toContain("Enable[✓]");

    // Cycle the action once: delete → kick.
    const toggledButtons = (toggled as { nativeFlow?: Array<{ id: string }> }).nativeFlow ?? [];
    const cycleButton = toggledButtons.find((button) => /:c\d+$/u.test(button.id));
    expect(cycleButton).toBeDefined();
    const cycled = await handleDosInteraction(cycleButton!.id, context());
    expect((cycled as { text: string }).text).toContain("Action: kick");

    // Done commits.
    const cycledButtons = (cycled as { nativeFlow?: Array<{ id: string }> }).nativeFlow ?? [];
    const doneButton = cycledButtons.find((button) => button.id.endsWith(":done"));
    expect(doneButton).toBeDefined();
    const summary = await handleDosInteraction(doneButton!.id, context());
    expect(summary).toMatchObject({
      text: expect.stringContaining("SAVED"),
      nativeFlow: expect.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/:home$/u) }),
      ]),
    });

    // Persisted through the same store the text commands use.
    const config = loadGroupAntiConfig(BASE.workspaceId, BASE.sessionId, BASE.chatJid);
    const module = config.antilink;
    expect(module?.enabled).toBe(true);
    expect(module?.action).toBe("kick");
    expect(module?.warnThreshold).toBe(3);

    const resultReply = summary as { nativeFlow?: Array<{ id: string }> };
    const homeButton = resultReply.nativeFlow?.find((button) => button.id.endsWith(":home"));
    expect(homeButton).toBeDefined();
    const home = await handleDosInteraction(homeButton!.id, context());
    expect((home as { text: string }).text).toContain("PAPPY OS");
  });

  it("opens the OS Demo app through the native deck tile (every app tile is reachable)", async () => {
    const drawer = openDosDrawer(context()) as { nativeFlow?: Array<{ id: string; text: string }> };
    const demoTile = drawer.nativeFlow?.find((button) => button.text === "OS Demo");
    expect(demoTile).toBeDefined();
    const demoHome = await handleDosInteraction(demoTile!.id, context());
    const demoReply = demoHome as { text: string; nativeFlow?: Array<{ id: string }> };
    expect(demoReply.text).toContain("OS LIVE DEMO");
    // Live matrix controls are on the deck, not just the decorative card.
    expect(demoReply.nativeFlow?.some((button) => /:x\d+$/u.test(button.id))).toBe(true);
  });

  it("rejects a stranger's tap on a live screen", async () => {
    const drawer = openDosDrawer(context()) as { nativeFlow?: Array<{ id: string }> };
    const button = drawer.nativeFlow?.[0];
    expect(button).toBeDefined();
    const stranger = await handleDosInteraction(button!.id, context({ senderJid: "15550002222@s.whatsapp.net" }));
    expect(stranger).toMatch(/Unauthorized/u);
  });

  it("answers stale tokens with an expiry message", async () => {
    const drawer = openDosDrawer(context()) as { nativeFlow?: Array<{ id: string }> };
    const button = drawer.nativeFlow?.[0];
    const parsed = button?.id ? parseDosInteractionId(button.id) : undefined;
    expect(parsed).toBeDefined();
    _expireDosSession(BASE.workspaceId, BASE.sessionId, BASE.chatJid, parsed!.token);
    const result = await handleDosInteraction(button!.id, context());
    expect(result).toMatch(/expired/u);
  });
});
