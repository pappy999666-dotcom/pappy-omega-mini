import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDownloadArgs,
  buildLyricsText,
  buildMusicPreviewMedia,
  buildPlayHeadsUpText,
  buildPlayPreviewText,
  convertMediaToMp3,
  downloadPlay,
  fetchLyrics,
  resolvePlayMetadata,
  withMediaDownloadSlot,
} from "../src/whatsapp/play-media.js";
import { createCommandRegistry, runPlayCommand, type CommandContext } from "../src/whatsapp/command-registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhatsApp play/media flow", () => {
  it("returns structured usage without invoking a downloader when no query is supplied", async () => {
    const response = await runPlayCommand({
      workspaceId: "workspace-test",
      sessionId: "session-test",
      isOwner: false,
      args: [],
      rawPayload: "",
      sendCurrentText: vi.fn(),
    } as CommandContext);
    expect(typeof response).toBe("string");
    expect(response).toContain("*PLAY COMMAND USAGE*");
    expect(response).toContain(".play <song or video>");
    expect(response).toContain(".lyrics <song title>");
  });

  it("registers the media commands and the audio aliases", () => {
    const registry = createCommandRegistry();
    const names = registry.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["play", "video", "lyrics", "mp3", "a2v"]));
    expect(registry.find((command) => command.name === "play")?.aliases).toEqual(expect.arrayContaining(["music", "audio"]));
  });

  it("formats a metadata-first preview with a canonical source anchor", () => {
    const text = buildPlayPreviewText({
      title: "Demo Track",
      uploader: "Demo Artist",
      durationSeconds: 187,
      webpageUrl: "https://example.test/watch/demo",
      sourceUrl: "https://example.test/watch/demo",
    }, "audio");
    expect(text).toContain("*MUSIC EXTRACTION*");
    expect(text).toContain("Demo Track");
    expect(text).toContain("3m 7s");
    expect(text).toContain("https://example.test/watch/demo");
    expect(text).toContain("MUSIC EXTRACTION");
    expect(text).toContain("A clean media attachment will be delivered next.");
    expect(buildPlayHeadsUpText("Demo Track")).toContain("*MUSIC REQUEST*");
  });

  it("uses a declared client identity and safely formats catalogue lyrics", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("User-Agent")).toContain("Pappy-Omega-Mini");
      return new Response(JSON.stringify([{
        trackName: "Demo Track",
        artistName: "Demo Artist",
        albumName: "Demo Album",
        plainLyrics: "First line\nSecond line",
        syncedLyrics: "[00:01.00] First line",
      }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchLyrics("Demo Track Demo Artist");
    expect(result.artist).toBe("Demo Artist");
    expect(result.plainLyrics).toContain("Second line");
    expect(buildLyricsText(result)).toContain("*LYRICS RESULT*");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the configured Noelia provider and returns a real voice note", async () => {
    vi.stubEnv("NOELIA_MUSIC_API_KEY", "test-noelia-key");
    vi.stubEnv("NOELIA_MUSIC_API_BASE", "https://noelia.test/api/music");
    const audio = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-f", "wav", "pipe:1"]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/search?q=Demo%20Track")) {
        expect(new Headers(init?.headers).get("x-api-key")).toBe("test-noelia-key");
        return new Response(JSON.stringify({
          success: true,
          track: {
            title: "Demo Track",
            author: "Demo Artist",
            downloadUrl: "https://noelia.test/api/music/download/temporary-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const metadata = await resolvePlayMetadata("Demo Track", "audio");
    expect(metadata.provider).toBe("noelia");
    expect(metadata.title).toBe("Demo Track");
    const result = await downloadPlay("Demo Track", "audio", metadata);
    expect(result.media.kind).toBe("audio");
    expect(result.media.mimeType).toBe("audio/ogg; codecs=opus");
    expect(result.media.ptt).toBe(true);
    expect(result.media.fileName).toBe("pappy-voice-note.ogg");
    expect(result.media.bytes.length).toBeGreaterThan(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("converts quoted audio to an MP3 attachment", async () => {
    const audio = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-f", "wav", "pipe:1"]);
    const media = await convertMediaToMp3({ kind: "audio", bytes: audio, mimeType: "audio/wav", fileName: "voice.wav", ptt: true });
    expect(media.kind).toBe("audio");
    expect(media.mimeType).toBe("audio/mpeg");
    expect(media.fileName).toBe("pappy-audio.mp3");
    expect(media.ptt).toBe(false);
    expect(media.bytes.length).toBeGreaterThan(100);
  });

  it("builds a branded image preview when provider artwork is unavailable", async () => {
    const preview = await buildMusicPreviewMedia({
      title: "Demo Track",
      uploader: "Demo Artist",
      sourceUrl: "Demo Track",
      provider: "noelia",
    }, "audio");
    expect(preview.kind).toBe("image");
    expect(preview.mimeType).toBe("image/jpeg");
    expect(preview.bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("uses bounded, non-playlist yt-dlp arguments for distinct audio and video modes", () => {
    const audio = buildDownloadArgs("audio", "/tmp/media.%(ext)s", "https://example.test/audio");
    expect(audio).toEqual(expect.arrayContaining(["--no-playlist", "--max-filesize", "50M", "-x", "--audio-format", "mp3", "--embed-thumbnail"]));
    expect(audio).not.toContain("--merge-output-format");
    const video = buildDownloadArgs("video", "/tmp/media.%(ext)s", "https://example.test/video");
    expect(video).toEqual(expect.arrayContaining(["--no-playlist", "--max-filesize", "50M", "-f", "bv*+ba/b", "--merge-output-format", "mp4"]));
    expect(video).not.toContain("--audio-format");
  });

  it("keeps heavy media work globally bounded while allowing preview work outside the gate", async () => {
    let active = 0;
    let peak = 0;
    const task = async () => withMediaDownloadSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    });
    await Promise.all(Array.from({ length: 6 }, () => task()));
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });
});
