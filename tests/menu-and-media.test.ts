import { beforeEach, describe, expect, it } from "vitest";
import { extractUrls } from "../src/links/link-collector.js";
import {
  createSession,
  resolveUser,
  updateSession,
} from "../src/core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../src/menus/menu-model.js";
import { buildWhatsappMenuPayload } from "../src/menus/whatsapp-menu.js";
import { routeWhatsAppText } from "../src/whatsapp/message-router.js";
import {
  createCommandRegistry,
  executeCommand,
} from "../src/whatsapp/command-registry.js";
import {
  addMenuMedia,
  getWhatsappMenuSettings,
  setWhatsappMenuMedia,
} from "../src/media/menu-media-store.js";
import { moderatorCommandScopes } from "../src/telegram/moderator.js";

beforeEach(() => {
  // Tests use unique Telegram IDs/workspaces, so state remains tenant-safe without global resets.
});

describe("link intake", () => {
  it("extracts multiple links without punctuation noise", () => {
    expect(
      extractUrls(
        "one https://example.com/a, two https://chat.whatsapp.com/ABC123.",
      ),
    ).toEqual(["https://example.com/a", "https://chat.whatsapp.com/ABC123"]);
  });
});

describe("shared session menu", () => {
  it("includes the requested simple controls and renders polished ASCII", () => {
    const user = resolveUser(`telegram-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "main",
    });
    const model = buildSessionMenu(session, true);
    const commands = model.actions.map((action) => action.command);
    expect(commands).toEqual(
      expect.arrayContaining(["autojoin", "pfp", "setgpp", "groups", "health"]),
    );
    expect(renderAsciiMenu(model)).toContain("PAPPY OMEGA MINI");
    expect(renderAsciiMenu(model)).toContain("autojoin");
  });

  it("renders a compact WhatsApp-native main menu", async () => {
    const user = resolveUser(`wa-menu-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "Jesus",
    });
    const payload = await buildWhatsappMenuPayload(session, true);
    expect(payload.text).toContain("COMMANDS");
    expect(payload.text).toContain(".profile");
    expect(payload.text).toContain(".allstatus");
    expect(payload.text).toContain(".gstatus");
    expect(payload.text).not.toContain("╔");
    expect(payload.text).not.toContain(
      "One command surface, two polished interfaces.",
    );
    expect(payload.text.length).toBeLessThan(500);
  });

  it("keeps session changes inside the owning workspace", () => {
    const first = resolveUser(`owner-${Date.now()}-${Math.random()}`);
    const second = resolveUser(`owner-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: first.workspaceId,
      sessionName: "isolated",
    });
    const changed = updateSession(first.workspaceId, session.sessionId, {
      autoJoinEnabled: true,
    });
    expect(changed.autoJoinEnabled).toBe(true);
    expect(() =>
      updateSession(second.workspaceId, session.sessionId, {
        autoJoinEnabled: false,
      }),
    ).toThrow(/workspace/);
  });
});

describe("Telegram group moderator command surface", () => {
  it("publishes protected moderation commands including mute", () => {
    const commands = moderatorCommandScopes.map((entry) => entry.command);
    expect(commands).toEqual(
      expect.arrayContaining([
        "moderation",
        "mute",
        "ban",
        "unban",
        "unmute",
        "warn",
        "warns",
        "warnlist",
        "resetwarn",
        "warnlimit",
        "rules",
        "staff",
        "whitelist",
      ]),
    );
    expect(commands).not.toEqual(
      expect.arrayContaining(["settings", "protection", "antilink", "logs"]),
    );
  });
});

describe("WhatsApp command privacy", () => {
  it("authorizes self-sent commands when Baileys supplies a LID sender", async () => {
    const user = resolveUser(`wa-from-me-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "self-sent",
      phoneNumber: "2347065217750",
    });
    updateSession(user.workspaceId, session.sessionId, {
      status: "ACTIVE",
      lastHealthyAt: Date.now(),
    });
    expect(
      await routeWhatsAppText({
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        senderJid: "222707593568329@lid",
        text: ".ping",
        fromMe: true,
      }),
    ).toContain("ACTIVE");
  });

  it("silences public and unknown WhatsApp commands", async () => {
    const user = resolveUser(`wa-auth-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "private",
      phoneNumber: "2348012345678",
    });
    updateSession(user.workspaceId, session.sessionId, {
      status: "ACTIVE",
      lastHealthyAt: Date.now(),
    });
    expect(
      await routeWhatsAppText({
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        senderJid: "2348099999999@s.whatsapp.net",
        text: ".unknown",
      }),
    ).toBeNull();
    expect(
      await routeWhatsAppText({
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        senderJid: "2348012345678@s.whatsapp.net",
        text: ".unknown",
      }),
    ).toBeNull();
    expect(
      await routeWhatsAppText({
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        senderJid: "2348012345678@s.whatsapp.net",
        text: ".ping",
      }),
    ).toContain("ACTIVE");
  });
});

describe("WhatsApp command registry", () => {
  it("sends gstatus directly to the current group and bounds repeat count", async () => {
    const user = resolveUser(`gstatus-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "group-status",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string; repeat: number } | undefined;
    const result = await executeCommand(
      createCommandRegistry(),
      "gstatus 999 hello",
      {
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        isOwner: true,
        chatJid: "120363000000000000@g.us",
        args: [],
        sendCurrentGroupStatus: async (input) => {
          captured = input;
        },
      },
    );
    expect(result).toContain("sent directly");
    expect(captured).toMatchObject({
      text: "hello",
      repeat: 20,
    });
  });

  it("sends literal tag payload directly without listing members", async () => {
    const user = resolveUser(`tag-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "local-tag",
      phoneNumber: "2348012345678",
    });
    let captured = "";
    const result = await executeCommand(
      createCommandRegistry(),
      "tag .tag .tag 🥀",
      {
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        isOwner: true,
        chatJid: "120363000000000000@g.us",
        args: [],
        sendCurrentGroupHidetag: async (text) => {
          captured = text;
        },
      },
    );
    expect(result).toContain("Hidetag sent");
    expect(captured).toBe(".tag .tag 🥀");
  });

  it("queues stag for all groups while keeping tag local", async () => {
    const user = resolveUser(`stag-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "all-tag",
      phoneNumber: "2348012345678",
    });
    let captured:
      { kind: string; payload: Record<string, unknown> } | undefined;
    const result = await executeCommand(createCommandRegistry(), "stag 3 🥀", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJob: async (input) => {
        captured = input;
        return "job-stag";
      },
    });
    expect(result).toContain("job-stag");
    expect(captured).toMatchObject({
      kind: "tag",
      payload: { text: "🥀", count: 3 },
    });
  });

  it("does not pretend WhatsApp-side pairing creates a workspace session", async () => {
    const user = resolveUser(`pair-command-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "pair-boundary",
      phoneNumber: "2348012345678",
    });
    const result = await executeCommand(createCommandRegistry(), "pair", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
    });
    expect(result).toContain("Telegram");
  });
});

describe("admin menu media", () => {
  it("accepts an image and attaches it to the WhatsApp menu", async () => {
    const user = resolveUser(`media-${Date.now()}-${Math.random()}`);
    const media = await addMenuMedia({
      workspaceId: user.workspaceId,
      fileName: "menu.png",
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    setWhatsappMenuMedia(
      user.workspaceId,
      media.mediaId,
      "Welcome to pappy-omega-mini",
    );
    expect(getWhatsappMenuSettings(user.workspaceId).whatsappMenuMediaId).toBe(
      media.mediaId,
    );
  });
});
