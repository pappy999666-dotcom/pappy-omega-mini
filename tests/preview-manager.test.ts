import { describe, expect, it } from "vitest";
import {
  PreviewManager,
  assertSafePreviewUrl,
  canonicalize,
} from "../src/preview/preview-manager.js";

function redisMock() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
  } as never;
}

describe("preview acceptance safeguards", () => {
  it("canonicalizes URLs and removes fragments", () => {
    expect(canonicalize("HTTPS://Example.com/a#fragment")).toBe(
      "https://example.com/a",
    );
  });

  it("blocks private and metadata hosts", () => {
    expect(() => assertSafePreviewUrl("http://127.0.0.1/internal")).toThrow();
    expect(() =>
      assertSafePreviewUrl("http://169.254.169.254/latest/meta-data"),
    ).toThrow();
    expect(() => assertSafePreviewUrl("https://example.com")).not.toThrow();
  });

  it("returns a safe fallback when the adapter fails", async () => {
    const manager = new PreviewManager(redisMock(), {
      fetch: async () => {
        throw new Error("upstream failure");
      },
    });
    const result = await manager.resolve("https://example.com/article");
    expect(result.fallback).toBe(true);
    expect(result.canonicalUrl).toBe("https://example.com/article");
  });
});
