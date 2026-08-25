import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const transportSourcePath = new URL("../src/whatsapp/transport-adapter.ts", import.meta.url);
const botSourcePath = new URL("../src/telegram/bot.ts", import.meta.url);
const workerSourcePath = new URL("../tools/worker-runtime-source.mjs", import.meta.url);

describe("group inventory fast path", () => {
  it("uses the worker's internal identity so stale-while-revalidate remains available", async () => {
    const source = await readFile(transportSourcePath, "utf8");
    expect(source).toContain("fetchSummaries(),");
    expect(source).toContain("Passing a\n        // control-plane identity hint disables its stale-while-revalidate path");
    expect(source).not.toContain("fetchSummaries(ownJid(socket))");
  });

  it("does not rescan all groups when current summaries include explicit role metadata", async () => {
    const source = await readFile(transportSourcePath, "utf8");
    expect(source).toContain("const roleMetadataComplete =");
    expect(source).toContain("summaries.every((group) => typeof group.isAdmin === \"boolean\")");
    expect(source).toContain("if (fetchGroups && summaries.length > 0 && !roleMetadataComplete)");
  });

  it("does not amplify inventory pressure with serial retries", async () => {
    const source = await readFile(transportSourcePath, "utf8");
    expect(source).toContain("for (let attempt = 0; attempt < 1; attempt += 1)");
    expect(source).toContain("Inventory is a read snapshot, not a job that should amplify pressure.");
    expect(source).not.toContain("transientGroupInventoryError");
  });

  it("keeps worker admin filtering internal and preserves stale snapshot behavior", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    expect(source).toContain("const allowStale = Boolean(options.staleWhileRevalidate) && !hint;");
    expect(source).toContain("isAdmin: await workerOwnAdminRole(item, runtime, identities)");
    expect(source).toContain("if (allowStale && groupSummaryLastKnown.has(cacheKey))");
  });

  it("skips the loading edit when a fresh administrator cache exists", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain("const cachedAdminGroups = peekCachedAdminGroups(");
    expect(source).toContain("if (cachedAdminGroups === undefined) {");
    const transportSource = await readFile(transportSourcePath, "utf8");
    expect(transportSource).toContain("export function peekCachedAdminGroups(");
  });
});
