import { beforeEach, describe, expect, it } from "vitest";
import { extractUrls } from "../src/links/link-collector.js";
import {
  createSession,
  resolveUser,
  updateSession,
} from "../src/core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../src/menus/menu-model.js";
import { buildWhatsappMenuPayload } from "../src/menus/whatsapp-menu.js";
import {
  addMenuMedia,
  getWhatsappMenuSettings,
  setWhatsappMenuMedia,
} from "../src/media/menu-media-store.js";

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
    expect(payload.text).toContain(".allstatusx <text>");
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
