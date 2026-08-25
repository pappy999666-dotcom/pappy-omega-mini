import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profilePictureUrl: vi.fn(async () => "https://profile.example/current.jpg"),
}));

vi.mock("../src/whatsapp/session-manager.js", () => ({
  getWhatsAppSocket: () => ({
    user: { id: "2348012345678:1@s.whatsapp.net" },
    profilePictureUrl: mocks.profilePictureUrl,
  }),
}));

import { createSession, resolveUser } from "../src/core/session-registry.js";
import { createCommandRegistry, executeCommand } from "../src/whatsapp/command-registry.js";
import { routeWhatsAppText } from "../src/whatsapp/message-router.js";
import {
  buildStickerCommandInput,
  clearAllStickerCommandBindingsForTests,
  setStickerCommandBinding,
} from "../src/whatsapp/sticker-command-bindings.js";
import { extractStickerFingerprint } from "../src/whatsapp/quoted-payload-resolver.js";

const registry = createCommandRegistry();

function commandContext(workspaceId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    workspaceId,
    sessionId,
    isOwner: true,
    args: [],
    ...extra,
  } as never;
}

describe("WhatsApp sticker command bindings", () => {
  beforeEach(() => {
    clearAllStickerCommandBindingsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the same redacted fingerprint through wrappers and changes it for another sticker", () => {
    const sticker = {
      stickerMessage: {
        fileSha256: Buffer.from("stable-sticker"),
        fileEncSha256: Buffer.from("encrypted-sticker"),
        mimetype: "image/webp",
      },
    };
    const wrapped = { viewOnceMessage: { message: sticker } };
    expect(extractStickerFingerprint(sticker)).toMatch(/^sticker:[a-f0-9]{64}$/u);
    expect(extractStickerFingerprint(wrapped)).toBe(extractStickerFingerprint(sticker));
    expect(extractStickerFingerprint({ stickerMessage: { fileSha256: Buffer.from("other") } })).not.toBe(extractStickerFingerprint(sticker));
  });

  it("binds one safe command, supports quoted fallback, and replaces the old binding", async () => {
    const user = resolveUser(`sticker-bind-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker" });
    const first = "sticker:first";
    const second = "sticker:second";
    const setup = await executeCommand(registry, "setcmd ping", commandContext(user.workspaceId, session.sessionId, {
      quotedStickerFingerprint: first,
      rawPayload: " ping",
    }));
    expect(String(setup)).toContain("STICKER COMMAND BOUND");

    const ping = await routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      fromMe: true,
      text: "",
      stickerFingerprint: first,
      quotedText: "ignored for ping",
    });
    expect(String(ping)).toContain("PING & LATENCY");

    await executeCommand(registry, "setcmd ping static payload", commandContext(user.workspaceId, session.sessionId, {
      quotedStickerFingerprint: second,
      rawPayload: " ping static payload",
    }));
    expect(await routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      fromMe: true,
      text: "",
      stickerFingerprint: first,
    })).toBeNull();
    expect(String(await routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      fromMe: true,
      text: "",
      stickerFingerprint: second,
      quotedText: "dynamic text",
    }))).toContain("PING & LATENCY");
    const replay = {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      fromMe: true,
      text: "",
      stickerFingerprint: second,
      messageId: "sticker-message-once",
    };
    expect(String(await routeWhatsAppText(replay))).toContain("PING & LATENCY");
    expect(await routeWhatsAppText(replay)).toBeNull();
  });

  it("uses static payload before quoted fallback and flush disables the old trigger", async () => {
    const user = resolveUser(`sticker-payload-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-payload" });
    const fingerprint = "sticker:payload";
    const setup = await executeCommand(registry, "setcmd tag static text", commandContext(user.workspaceId, session.sessionId, {
      quotedStickerFingerprint: fingerprint,
      rawPayload: " tag static text",
    }));
    expect(String(setup)).toContain("static text");
    const binding = setStickerCommandBinding({ workspaceId: user.workspaceId, sessionId: session.sessionId, fingerprint, command: "tag", payload: "static text" });
    expect(buildStickerCommandInput(binding, "quoted text")).toBe("tag static text");
    const fallbackBinding = setStickerCommandBinding({ workspaceId: user.workspaceId, sessionId: session.sessionId, fingerprint, command: "tag" });
    expect(buildStickerCommandInput(fallbackBinding, "quoted text")).toBe("tag quoted text");
    const flushed = await executeCommand(registry, "flushcmd", commandContext(user.workspaceId, session.sessionId));
    expect(String(flushed)).toContain("Binding removed");
    expect(await routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348012345678@s.whatsapp.net",
      fromMe: true,
      text: "",
      stickerFingerprint: fingerprint,
      quotedText: "should not dispatch",
    })).toBeNull();
  });

  it("rejects dangerous or recursive targets and ignores unauthorized sticker senders", async () => {
    const user = resolveUser(`sticker-safety-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-safety" });
    const rejected = await executeCommand(registry, "setcmd kickall", commandContext(user.workspaceId, session.sessionId, {
      quotedStickerFingerprint: "sticker:safe",
      rawPayload: " kickall",
    }));
    expect(String(rejected)).toContain("STICKER BINDING REJECTED");
    setStickerCommandBinding({ workspaceId: user.workspaceId, sessionId: session.sessionId, fingerprint: "sticker:safe", command: "ping" });
    expect(await routeWhatsAppText({
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      senderJid: "2348099999999@s.whatsapp.net",
      text: "",
      stickerFingerprint: "sticker:safe",
    })).toBeNull();
  });
});

describe("panel worker parity", () => {
  it("contains sticker-only admission, fingerprinting, and forwarding fields", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../tools/worker-runtime-source.mjs", import.meta.url), "utf8");
    expect(source).toContain("function stickerFingerprint");
    expect(source).toContain("directStickerFingerprint");
    expect(source).toContain("quotedStickerFingerprint");
    expect(source).toContain("!text && !quotedText && !interactionId && !directStickerFingerprint");
  });
});

describe("WhatsApp profile picture media", () => {
  it("returns actual image bytes instead of the source URL", async () => {
    const user = resolveUser(`pfp-media-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "pfp" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("jpeg-bytes"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })));
    const result = await executeCommand(registry, "pfp get", commandContext(user.workspaceId, session.sessionId));
    expect(typeof result).toBe("object");
    const reply = result as { media?: { kind: string; bytes: Buffer; mimeType?: string }; caption?: string };
    expect(reply.media?.kind).toBe("image");
    expect(reply.media?.bytes).toEqual(Buffer.from("jpeg-bytes"));
    expect(reply.media?.mimeType).toBe("image/jpeg");
    expect(reply.caption).toContain("PROFILE PICTURE");
    expect(reply.caption).not.toContain("profile.example/current.jpg");
    expect(mocks.profilePictureUrl).toHaveBeenCalled();
  });
});
