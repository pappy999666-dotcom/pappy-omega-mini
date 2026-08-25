import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => ({
  profilePictureUrl: vi.fn(async () => "https://profile.example/current.jpg"),
  sendMessage: vi.fn(async () => ({ key: { id: "test" } })),
}));

vi.mock("../src/whatsapp/session-manager.js", () => ({
  getWhatsAppSocket: () => ({
    user: { id: "2348012345678:1@s.whatsapp.net" },
    profilePictureUrl: mocks.profilePictureUrl,
    sendMessage: mocks.sendMessage,
  }),
}));

import { createSession, resolveUser } from "../src/core/session-registry.js";
import { pairingHelpCardText } from "../src/telegram/ui.js";
import { createCommandRegistry, executeCommand } from "../src/whatsapp/command-registry.js";
import { routeWhatsAppText } from "../src/whatsapp/message-router.js";
import {
  buildStickerCommandInput,
  clearAllStickerCommandBindingsForTests,
  setStickerCommandBinding,
} from "../src/whatsapp/sticker-command-bindings.js";
import { clearStickerPackNameForTests } from "../src/whatsapp/sticker-settings.js";
import { applyStickerPackMetadata, validateWhatsAppSticker } from "../src/whatsapp/sticker-exif.js";
import { inspectSticker } from "../src/whatsapp/sticker-info.js";
import { extractStickerFingerprint } from "../src/whatsapp/quoted-payload-resolver.js";
import { sendSticker } from "../src/whatsapp/transport-adapter.js";

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
    clearStickerPackNameForTests();
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

describe("WhatsApp sticker media", () => {
  it("creates a text/emoji bubble sticker with the quoted sender avatar and current pack name", async () => {
    const user = resolveUser(`sticker-create-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-create" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    })));
    await executeCommand(registry, "spn My Pack", commandContext(user.workspaceId, session.sessionId, { rawPayload: " My Pack" }));
    const result = await executeCommand(registry, "sticker ✨ hello", commandContext(user.workspaceId, session.sessionId, {
      rawPayload: " ✨ hello",
      quotedSenderJid: "2348099999999@s.whatsapp.net",
    }));
    const reply = result as { media?: { kind: string; bytes: Buffer; stickerPackName?: string }; caption?: string };
    expect(reply.media?.kind).toBe("sticker");
    expect(reply.media?.bytes.length).toBeGreaterThan(0);
    expect(reply.media?.stickerPackName).toBe("My Pack");
    expect(reply.caption).toContain("TEXT STICKER CREATED");
    expect(reply.caption).toContain("Quoted sender profile picture");
  });

  it("uses quoted text when no inline payload is provided and falls back cleanly when the avatar is unavailable", async () => {
    const user = resolveUser(`sticker-quoted-text-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-quoted-text" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    })));
    const result = await executeCommand(registry, "sticker", commandContext(user.workspaceId, session.sessionId, {
      rawPayload: "",
      quotedText: "✨🫶 quoted message",
      quotedSenderJid: "2348099999999@s.whatsapp.net",
    }));
    const reply = result as { media?: { kind: string; bytes: Buffer }; caption?: string };
    expect(reply.media?.kind).toBe("sticker");
    expect(reply.media?.bytes.length).toBeGreaterThan(0);
    expect(reply.caption).toContain("Fallback avatar");

    const emojiOnly = await executeCommand(registry, "s 🫶✨", commandContext(user.workspaceId, session.sessionId));
    const emojiReply = emojiOnly as { media?: { kind: string; bytes: Buffer } };
    expect(emojiReply.media?.kind).toBe("sticker");
    expect(emojiReply.media?.bytes.length).toBeGreaterThan(0);
  });

  it("reads sticker dimensions, animation state, and embedded pack information", async () => {
    const user = resolveUser(`sticker-info-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-info" });
    const base = await sharp({ create: { width: 24, height: 18, channels: 4, background: "#ff77aa" } }).webp().toBuffer();
    const bytes = applyStickerPackMetadata(base, { packName: "Info Pack", publisher: "Info Publisher", emojis: ["✨"] });
    validateWhatsAppSticker(bytes, { requireMetadata: true });
    const exifOffset = bytes.indexOf(Buffer.from("EXIF", "ascii"));
    const vp8xOffset = bytes.indexOf(Buffer.from("VP8X", "ascii"));
    expect(exifOffset).toBeGreaterThan(0);
    expect(bytes.subarray(exifOffset + 8, exifOffset + 10).toString("ascii")).toBe("II");
    expect(bytes.readUInt16LE(exifOffset + 18)).toBe(0x5741);
    expect(bytes.readUInt16LE(exifOffset + 20)).toBe(7);
    expect(vp8xOffset).toBeGreaterThan(0);
    expect(bytes[vp8xOffset + 8]! & 0x08).toBe(0x08);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    const decoded = await sharp(bytes).metadata();
    expect(decoded.format).toBe("webp");
    expect(decoded.width).toBe(24);
    expect(decoded.height).toBe(18);
    const info = await inspectSticker({ kind: "sticker", bytes, mimeType: "image/webp" });
    expect(info.width).toBe(24);
    expect(info.height).toBe(18);
    expect(info.animated).toBe(false);
    expect(info.packName).toBe("Info Pack");
    expect(info.publisher).toBe("Info Publisher");
    expect(info.emojis).toEqual(["✨"]);
    const result = await executeCommand(registry, "sticker info", commandContext(user.workspaceId, session.sessionId, {
      args: ["info"],
      media: { kind: "sticker", bytes, mimeType: "image/webp" },
    }));
    expect(String(result)).toContain("STICKER INFORMATION");
    expect(String(result)).toContain("Info Pack");
  });

  it("uses a native sticker-only outbound payload", async () => {
    mocks.sendMessage.mockClear();
    await sendSticker("workspace", "session", "123@g.us", {
      kind: "sticker",
      bytes: Buffer.from("webp-bytes"),
      mimeType: "image/webp",
      caption: "must not be attached",
      stickerPackName: "must stay inside EXIF",
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith("123@g.us", {
      sticker: Buffer.from("webp-bytes"),
      mimetype: "image/webp",
    });
  });

  it("converts an animated WebP sticker payload back to MP4 video", async () => {
    const user = resolveUser(`sticker-video-convert-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-video-convert" });
    const directory = await mkdtemp(join(tmpdir(), "pappy-sticker-test-"));
    try {
      const first = await sharp({ create: { width: 24, height: 18, channels: 4, background: "#ff77aa" } }).png().toBuffer();
      const second = await sharp({ create: { width: 24, height: 18, channels: 4, background: "#77aaff" } }).png().toBuffer();
      await writeFile(join(directory, "frame-1.png"), first);
      await writeFile(join(directory, "frame-2.png"), second);
      await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "10", "-i", "frame-%d.png", "-loop", "0", "-c:v", "libwebp", "-f", "webp", "animated.webp"], { cwd: directory });
      const stickerBytes = await readFile(join(directory, "animated.webp"));
      const sourceMetadata = await sharp(stickerBytes, { animated: true }).metadata();
      expect(sourceMetadata.pages).toBeGreaterThan(1);
      const converted = await executeCommand(registry, "cs", commandContext(user.workspaceId, session.sessionId, {
        media: { kind: "sticker", bytes: stickerBytes, mimeType: "image/webp" },
      }));
      const reply = converted as { media?: { kind: string; bytes: Buffer; mimeType?: string } };
      expect(reply.media?.kind).toBe("video");
      expect(reply.media?.mimeType).toBe("video/mp4");
      expect(reply.media?.bytes.subarray(4, 8).toString()).toBe("ftyp");
      expect(reply.media?.bytes.length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converts a static sticker payload back to PNG media and preserves pack metadata on take", async () => {
    const user = resolveUser(`sticker-convert-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "sticker-convert" });
    const stickerBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff77aa" } }).webp().toBuffer();
    const converted = await executeCommand(registry, "cs", commandContext(user.workspaceId, session.sessionId, {
      rawPayload: "",
      media: { kind: "sticker", bytes: stickerBytes, mimeType: "image/webp" },
    }));
    const convertedReply = converted as { media?: { kind: string; bytes: Buffer; mimeType?: string } };
    expect(convertedReply.media?.kind).toBe("image");
    expect(convertedReply.media?.mimeType).toBe("image/png");
    expect(convertedReply.media?.bytes.length).toBeGreaterThan(0);
    await executeCommand(registry, "stickerpname Brand Pack", commandContext(user.workspaceId, session.sessionId, { rawPayload: " Brand Pack" }));
    const taken = await executeCommand(registry, "take", commandContext(user.workspaceId, session.sessionId, {
      media: { kind: "sticker", bytes: stickerBytes, mimeType: "image/webp" },
    }));
    const reply = taken as { media?: { kind: string; stickerPackName?: string } };
    expect(reply.media?.kind).toBe("sticker");
    expect(reply.media?.stickerPackName).toBe("Brand Pack");
  });
});

describe("formatting and surface isolation", () => {
  it("uses real newlines in WhatsApp media captions and Telegram pairing syntax", () => {
    expect(pairingHelpCardText()).toContain("/pair &lt;label&gt;");
    expect(pairingHelpCardText()).not.toContain(".pair <label>");
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
    expect(reply.caption).toContain("\n⎔ Media");
    expect(reply.caption).not.toContain("\\n");
    expect(reply.caption).not.toContain("profile.example/current.jpg");
    expect(mocks.profilePictureUrl).toHaveBeenCalled();
  });
});
