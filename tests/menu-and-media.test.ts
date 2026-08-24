import { beforeEach, describe, expect, it } from "vitest";
import { extractUrls } from "../src/links/link-collector.js";
import {
  createSession,
  getSession,
  resolveUser,
  updateSession,
} from "../src/core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../src/menus/menu-model.js";
import { buildWhatsappMenuPayload } from "../src/menus/whatsapp-menu.js";
import {
  mergeQuotedPayload,
  routeWhatsAppText,
} from "../src/whatsapp/message-router.js";
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
import { isCompletePreview } from "../src/whatsapp/baileys-native-preview.js";
import {
  extractMessageText,
  extractQuotedMessage,
  extractQuotedText,
} from "../src/whatsapp/quoted-payload-resolver.js";

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
      expect.arrayContaining(["autojoin", "pfp", "setgpp", "groups", "health", "pstatus", "gstatus"]),
    );
    expect(renderAsciiMenu(model)).toContain("ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎");
    expect(renderAsciiMenu(model)).toContain("autojoin");
  });

  it("renders the exact Crysnova WhatsApp-native main menu", async () => {
    const user = resolveUser(`wa-menu-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "Jesus",
    });
    const payload = await buildWhatsappMenuPayload(session, true);
    expect(payload.text).toContain("ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎");
    expect(payload.text).toContain("˗ˏˋ ☏ ˎˊ˗  *Hello, 𝗝𝗲𝘀𝘂𝘀*  ✦");
    expect(payload.text).toContain("⎔ Owner   · ⇆ 𝗝𝗲𝘀𝘂𝘀");
    expect(payload.text).toContain("⎔ Status  · ⇆ PAIRING");
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .menu`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .pstatus`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .allstatus`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .stopstag`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .join`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .targetgs`);
    expect(payload.text).toContain(`${"︎ ".repeat(15)}⊹ .iggc`);
    expect(payload.text).not.toContain("┌");
    expect(payload.text).not.toContain("╔");
    expect(payload.text).not.toContain("One command surface, two polished interfaces.");
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

  it("dispatches bare bridge commands independently of the session prefix", async () => {
    const user = resolveUser(`wa-bridge-prefix-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "bridge-prefix",
      phoneNumber: "2348012345678",
    });
    updateSession(user.workspaceId, session.sessionId, {
      status: "ACTIVE",
      prefix: "!",
      lastHealthyAt: Date.now(),
    });
    await expect(routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "telegram-bridge",
      text: "ping",
      bridgeAuthorized: true,
    })).resolves.toContain("ACTIVE");
    await expect(routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      text: "ping",
    })).resolves.toBeNull();
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
        text: "ordinary text without a command",
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

describe("WhatsApp native previews", () => {
  it("recognizes complete supplied preview metadata without rebuilding it", () => {
    expect(
      isCompletePreview({
        title: "Example",
        description: "A complete card",
        thumbnailUrl: "https://example.com/card.jpg",
      }),
    ).toBe(true);
    expect(isCompletePreview({ title: "Example" })).toBe(false);
  });
});

describe("quoted payload resolver", () => {
  it("extracts quoted media captions and nested quoted messages", () => {
    const quoted = {
      imageMessage: {
        caption: "quoted image https://example.com/image",
        mimetype: "image/jpeg",
      },
    };
    const message = {
      extendedTextMessage: {
        text: ".allchat",
        contextInfo: { quotedMessage: quoted },
      },
    };
    expect(extractMessageText(message)).toBe(".allchat");
    expect(extractQuotedMessage(message)).toEqual(quoted);
    expect(extractQuotedText(quoted)).toBe(
      "quoted image https://example.com/image",
    );
  });
});

describe("WhatsApp command registry", () => {
  it("sends one gstatus payload directly to the current group without an acknowledgment", async () => {
    const user = resolveUser(`gstatus-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "group-status",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string; repeat: number } | undefined;
    const result = await executeCommand(
      createCommandRegistry(),
      "gstatus hello",
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
    expect(result).toBe("");
    expect(captured).toMatchObject({
      text: "hello",
      repeat: 1,
    });
  });

  it("routes pstatus to the personal-status callback without requiring a group", async () => {
    const user = resolveUser(`pstatus-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "personal-status",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string } | undefined;
    let groupCalled = false;
    const result = await executeCommand(createCommandRegistry(), "pstatus hello world", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      sendCurrentPersonalStatus: async (input) => {
        captured = input;
      },
      sendCurrentGroupStatus: async () => {
        groupCalled = true;
      },
    });
    expect(result).toBe("Personal status posted successfully.");
    expect(captured).toEqual({ text: "hello world" });
    expect(groupCalled).toBe(false);
  });

  it("strips the gstatus command token from a media caption", async () => {
    const user = resolveUser(`gstatus-caption-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "group-status-caption",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string; repeat: number } | undefined;
    const result = await executeCommand(createCommandRegistry(), "gstatus", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      chatJid: "120363000000000000@g.us",
      args: [],
      media: {
        kind: "image",
        bytes: Buffer.from([1, 2, 3]),
        caption: ".gstatus https://chat.whatsapp.com/ABC123",
      },
      sendCurrentGroupStatus: async (input) => {
        captured = input;
      },
    });
    expect(result).toBe("");
    expect(captured).toEqual({
      text: "https://chat.whatsapp.com/ABC123",
      repeat: 1,
    });
  });

  it("supports null no-prefix mode per session", async () => {
    const user = resolveUser(`prefix-null-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "prefix-null",
      phoneNumber: "2348012345678",
    });
    const result = await executeCommand(
      createCommandRegistry(),
      "setprefix null",
      {
        workspaceId: user.workspaceId,
        sessionId: session.sessionId,
        isOwner: true,
        args: [],
      },
    );
    expect(result).toContain("none");
    expect(getSession(user.workspaceId, session.sessionId).prefix).toBe("");
  });

  it("supports numeric tag member counts without rewriting literal payloads", async () => {
    const user = resolveUser(`tag-count-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "tag-count",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string; participantCount?: number } | undefined;
    const result = await executeCommand(createCommandRegistry(), "tag 1000", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      chatJid: "120363000000000000@g.us",
      args: [],
      sendCurrentGroupHidetag: async (input) => {
        captured = input;
      },
    });
    expect(result).toBe("");
    expect(captured).toEqual({ text: "", participantCount: 1000 });
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
        sendCurrentGroupHidetag: async ({ text }) => {
          captured = text;
        },
      },
    );
    expect(result).toBe("");
    expect(captured).toBe(".tag .tag 🥀");
  });

  it("preserves multiline allchat payloads and does not treat numeric lines as repeats", async () => {
    const user = resolveUser(`allchat-multiline-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "all-chat-multiline",
      phoneNumber: "2348012345678",
    });
    let captured: { kind: string; payload: Record<string, unknown> } | undefined;
    const text = "1\n2\n3\n3\n3";
    const result = await executeCommand(createCommandRegistry(), `allchat ${text}`, {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJob: async (input) => {
        captured = input;
        return "job-multiline";
      },
    });
    expect(result).toContain("job-multiline");
    expect(captured).toMatchObject({ kind: "allchat", payload: { text, count: 1 } });
  });

  it("uses repeat counts only for explicit x broadcast variants", async () => {
    const user = resolveUser(`allchat-repeat-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "all-chat-repeat",
      phoneNumber: "2348012345678",
    });
    let captured: { kind: string; payload: Record<string, unknown> } | undefined;
    await executeCommand(createCommandRegistry(), "allchatx 3 hello", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJob: async (input) => {
        captured = input;
        return "job-repeat";
      },
    });
    expect(captured).toMatchObject({ kind: "allchat", payload: { text: "hello", count: 3 } });
  });

  it("uses a media caption as the payload when all-chat has no inline text", async () => {
    const user = resolveUser(`allchat-media-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "all-chat-media",
      phoneNumber: "2348012345678",
    });
    let captured:
      { kind: string; payload: Record<string, unknown> } | undefined;
    const result = await executeCommand(createCommandRegistry(), "allchat", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      media: {
        kind: "image",
        bytes: Buffer.from([1, 2, 3]),
        caption: "quoted caption",
      },
      enqueueJob: async (input) => {
        captured = input;
        return "job-media";
      },
    });
    expect(result).toContain("job-media");
    expect(captured).toMatchObject({
      kind: "allchat",
      payload: { text: "quoted caption", count: 1 },
    });
  });

  it("sends stag as immediate same-group hidetag like tag", async () => {
    const user = resolveUser(`stag-${Date.now()}-${Math.random()}`);
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "same-group-tag",
      phoneNumber: "2348012345678",
    });
    let captured: { text: string; participantCount?: number } | undefined;
    let enqueued = false;
    const result = await executeCommand(createCommandRegistry(), "stag 🥀", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      chatJid: "120363000000000001@g.us",
      args: [],
      sendCurrentGroupHidetag: async (input) => {
        captured = input;
      },
      enqueueJob: async () => {
        enqueued = true;
        return "unexpected-job";
      },
    });
    expect(result).toBe("");
    expect(captured).toEqual({ text: "🥀" });
    expect(enqueued).toBe(false);
  });

  it("appends a quoted message as the command payload", () => {
    expect(
      mergeQuotedPayload(".gstatus", "quoted payload https://example.com/item"),
    ).toBe(".gstatus\nquoted payload https://example.com/item");
    expect(mergeQuotedPayload("", "quoted-only payload")).toBe(
      "quoted-only payload",
    );
    expect(mergeQuotedPayload(".allchat 1\n2", "3\n4")).toBe(
      ".allchat 1\n2\n3\n4",
    );
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
    expect(result).toContain("WhatsApp pairing is unavailable");
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
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName: "media-menu-session",
    });
    const payload = await buildWhatsappMenuPayload(session, false);
    expect(payload.media?.kind).toBe("image");
    expect(payload.caption).toContain("Welcome to pappy-omega-mini");
    expect(payload.caption).toContain("COMMANDS");
  });
});
