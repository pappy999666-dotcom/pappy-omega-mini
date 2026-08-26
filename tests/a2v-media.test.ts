import { describe, afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  a2vCacheSizeForTests,
  a2vCacheStatusText,
  clearA2vCacheForTests,
  mergeAudioWithVisual,
  stageA2v,
} from "../src/whatsapp/a2v-media.js";
import type { WhatsAppMediaPayload } from "../src/whatsapp/media-payload.js";

const execFileAsync = promisify(execFile);

async function audioFixture(): Promise<Buffer> {
  const result = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  return result.stdout as Buffer;
}

async function imageFixture(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 31, g: 92, b: 72 } } }).jpeg().toBuffer();
}

function audio(bytes: Buffer): WhatsAppMediaPayload {
  return { kind: "audio", bytes, mimeType: "audio/ogg; codecs=opus", fileName: "voice.ogg", ptt: true };
}

function image(bytes: Buffer): WhatsAppMediaPayload {
  return { kind: "image", bytes, mimeType: "image/jpeg", fileName: "photo.jpg" };
}

describe("a2v media workflow", () => {
  afterEach(() => clearA2vCacheForTests());

  it("caches one media, rejects same-type second media, then merges the opposite type", async () => {
    const audioMedia = audio(await audioFixture());
    const imageMedia = image(await imageFixture());
    const first = await stageA2v("workspace-a", "session-a", "chat-a", audioMedia);
    expect(first).toEqual({ state: "cached", expected: "image/video" });
    expect(a2vCacheSizeForTests()).toBe(1);

    const duplicate = await stageA2v("workspace-a", "session-a", "chat-a", audioMedia);
    expect(duplicate).toEqual({ state: "wrong-order", expected: "image/video" });
    expect(a2vCacheSizeForTests()).toBe(1);

    const merged = await stageA2v("workspace-a", "session-a", "chat-a", imageMedia);
    expect(merged.state).toBe("merged");
    expect(merged.media?.kind).toBe("video");
    expect(merged.media?.mimeType).toBe("video/mp4");
    expect(merged.media?.bytes.subarray(4, 8).toString()).toBe("ftyp");
    expect(a2vCacheSizeForTests()).toBe(0);
  }, 30_000);

  it("isolates caches per chat and renders the five-minute status", async () => {
    const imageMedia = image(await imageFixture());
    const first = await stageA2v("workspace-a", "session-a", "chat-a", imageMedia);
    const second = await stageA2v("workspace-a", "session-a", "chat-b", imageMedia);
    expect(first.expected).toBe("music");
    expect(second.expected).toBe("music");
    expect(a2vCacheSizeForTests()).toBe(2);
    expect(a2vCacheStatusText("music", ".")).toContain("5 minutes");
  });
});
