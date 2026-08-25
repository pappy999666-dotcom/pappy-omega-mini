import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decryptJson,
  encryptJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "../src/core/encrypted-store.js";
import {
  assertOperationAllowed,
  getEmergencyState,
  recordAudit,
  setEmergencyState,
} from "../src/core/control-plane.js";
import {
  BAILEYS_SESSION_SOCKET_OPTIONS,
  BaileysRetryCounterCache,
  authenticatedOpenSessionPatch,
  classifyDisconnect,
  isLiveWhatsAppUpsert,
  wrapSignalKeyStoreWithCache,
} from "../src/whatsapp/session-manager.js";
import { createSafeError, renderSafeError } from "../src/core/errors.js";
import {
  createSession,
  getSessionJoinSettings,
  updateSession,
  updateSessionJoinSettings,
} from "../src/core/session-registry.js";
import { selectHealthyWhatsAppSession } from "../src/whatsapp/session-allocator.js";
import { routeWhatsAppText } from "../src/whatsapp/message-router.js";
import {
  createCommandRegistry,
  executeCommand,
} from "../src/whatsapp/command-registry.js";

describe("V2 hardening", () => {
  it("encrypts and decrypts auth-state values", () => {
    const input = { creds: { id: "session-1" }, keys: ["a", "b"] };
    const encrypted = encryptJson(input);
    expect(encrypted).not.toContain("session-1");
    expect(decryptJson(encrypted)).toEqual(input);
  });

  it("writes encrypted auth records atomically without temporary leftovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pappy-auth-"));
    const path = join(directory, "creds.json");
    try {
      await writeEncryptedJson(path, { registered: true, marker: "latest" });
      expect(await readEncryptedJson(path)).toEqual({
        registered: true,
        marker: "latest",
      });
      expect(await readdir(directory)).toEqual(["creds.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates safe correlated errors without leaking diagnostics", () => {
    const error = createSafeError(
      "NETWORK_TRANSIENT",
      new Error("private socket detail"),
    );
    expect(error.correlationId).toMatch(/[0-9a-f-]{20,}/);
    expect(renderSafeError(error)).toContain("Reference:");
    expect(renderSafeError(error)).not.toContain("private socket detail");
  });

  it("publishes a confirmed socket open as ACTIVE without resetting reconnect backoff", () => {
    expect(authenticatedOpenSessionPatch({ now: 1700000000000, socketGeneration: 7, reconnectCount: 4 })).toEqual({
      status: "ACTIVE",
      connectedAt: 1700000000000,
      lastHealthyAt: 1700000000000,
      socketGeneration: 7,
      reconnectCount: 4,
      authHealth: "VALID",
      lastError: undefined,
      disconnectReason: undefined,
    });
  });

  it("preserves auth for ambiguous transport codes and purges only explicit logout", () => {
    expect(classifyDisconnect({ output: { statusCode: 401 } })).toMatchObject({
      code: 401,
      label: "unauthorized-paused",
      terminal: false,
      status: "LOGGED_OUT",
    });
    expect(classifyDisconnect({ output: { statusCode: 401 }, message: "logged out by WhatsApp" })).toMatchObject({
      code: 401,
      label: "logged-out",
      terminal: true,
      status: "LOGGED_OUT",
    });
    for (const statusCode of [403, 405, 440, 500])
      expect(classifyDisconnect({ output: { statusCode } })).toMatchObject({
        code: statusCode,
        terminal: false,
        status: "DEGRADED",
      });
    expect(classifyDisconnect({ output: { statusCode: 503 } })).toMatchObject({
      code: 503,
      label: "service-unavailable",
      terminal: false,
      status: "DEGRADED",
    });
    expect(classifyDisconnect(new Error("unknown"))).toMatchObject({
      label: "unknown-transport",
      terminal: false,
    });
  });

  it("pins quiet, bounded Crysnova socket defaults", () => {
    expect(BAILEYS_SESSION_SOCKET_OPTIONS).toEqual({
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 20_000,
      keepAliveIntervalMs: 15_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 3,
    });
  });

  it("treats only notify or omitted upserts as live user actions", () => {
    expect(isLiveWhatsAppUpsert("notify")).toBe(true);
    expect(isLiveWhatsAppUpsert()).toBe(true);
    expect(isLiveWhatsAppUpsert("append")).toBe(false);
    expect(isLiveWhatsAppUpsert("history")).toBe(false);
  });

  it("keeps retry counters bounded and clears them deterministically", async () => {
    const cache = new BaileysRetryCounterCache();
    await cache.set("session-a", 2);
    expect(await cache.get("session-a")).toBe(2);
    expect(await cache.del("session-a")).toBe(1);
    expect(await cache.get("session-a")).toBeUndefined();
    expect(await cache.del("missing")).toBe(0);
  });

  it("caches Signal-key reads while preserving durable writes", async () => {
    let reads = 0;
    const durable = {
      get: async (_type: string, ids: string[]) => {
        reads += 1;
        return Object.fromEntries(ids.map((id) => [id, { id, value: "durable" }]));
      },
      set: async (data: Record<string, Record<string, unknown>>) => data,
    };
    const cached = await wrapSignalKeyStoreWithCache(durable);
    await expect(cached.get("session", ["key-1"])).resolves.toMatchObject({
      "key-1": { value: "durable" },
    });
    await expect(cached.get("session", ["key-1"])).resolves.toMatchObject({
      "key-1": { value: "durable" },
    });
    expect(reads).toBe(1);
    await cached.set({ session: { "key-1": { value: "new" } } });
  });

  it("selects only healthy owned sessions and honors a safe preference", () => {
    const workspaceId = `allocator-${Date.now()}-${Math.random()}`;
    const preferred = createSession({ workspaceId, sessionName: "preferred" });
    const healthy = createSession({ workspaceId, sessionName: "healthy" });
    updateSession(workspaceId, preferred.sessionId, {
      status: "ACTIVE",
      authHealth: "INVALID",
      lastHealthyAt: Date.now(),
    });
    updateSession(workspaceId, healthy.sessionId, {
      status: "ACTIVE",
      authHealth: "VALID",
      lastHealthyAt: Date.now(),
    });
    expect(
      selectHealthyWhatsAppSession(workspaceId, preferred.sessionId)?.sessionId,
    ).toBe(healthy.sessionId);
    expect(
      selectHealthyWhatsAppSession(
        workspaceId,
        undefined,
        "https://chat.whatsapp.com/A",
      ),
    ).toBeTruthy();
  });

  it("records workspace-scoped audit events and emergency blocking", () => {
    const event = recordAudit({
      actorTelegramUserId: "owner",
      workspaceId: "workspace",
      action: "pairing",
      success: true,
      metadata: {},
    });
    expect(event.correlationId).toBeTruthy();
    setEmergencyState("owner", { enabled: true, pauseJoins: true });
    expect(getEmergencyState().enabled).toBe(true);
    expect(() => assertOperationAllowed("join")).toThrow(/safe mode/);
    setEmergencyState("owner", { enabled: false, pauseJoins: false });
    expect(() => assertOperationAllowed("join")).not.toThrow();
  });
});

describe("WhatsApp command smoke paths", () => {
  it("accepts a Baileys device-suffixed owner JID for native commands", async () => {
    const session = createSession({
      workspaceId: `smoke-${Date.now()}`,
      sessionName: "native",
      phoneNumber: "15551234567",
    });
    const response = await routeWhatsAppText({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      senderJid: "15551234567:44@s.whatsapp.net",
      text: ".ping",
    });
    expect(response).toContain("PING & LATENCY");
  });

  it("suppresses the WhatsApp menu while safe mode is enabled", async () => {
    const session = createSession({
      workspaceId: `safe-menu-${Date.now()}`,
      sessionName: "safe-menu",
      phoneNumber: "15551234567",
    });
    setEmergencyState("owner", { enabled: true });
    try {
      await expect(routeWhatsAppText({
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        senderJid: "15551234567@s.whatsapp.net",
        text: ".menu",
      })).resolves.toBeNull();
    } finally {
      setEmergencyState("owner", { enabled: false });
    }
    await expect(routeWhatsAppText({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      senderJid: "15551234567@s.whatsapp.net",
      text: ".menu",
    })).resolves.toBeTruthy();
  });

  it("keeps allstatusx repeat count distinct in its worker payload", async () => {
    const session = createSession({
      workspaceId: `smoke-${Date.now()}`,
      sessionName: "status",
      phoneNumber: "15551234568",
    });
    let captured: Record<string, unknown> | undefined;
    const response = await executeCommand(
      createCommandRegistry(),
      "allstatusx 3 hello",
      {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        isOwner: true,
        args: [],
        enqueueJob: async ({ payload }) => {
          captured = payload;
          return "job-smoke";
        },
      },
    );
    expect(response).toContain("job-smoke");
    expect(captured).toMatchObject({ text: "hello", count: 3 });
  });

  it("keeps plain allstatus at one post while allstatusx repeats", async () => {
    const session = createSession({
      workspaceId: `smoke-${Date.now()}`,
      sessionName: "status-separation",
      phoneNumber: "15551234569",
    });
    const captured: Array<Record<string, unknown>> = [];
    const enqueueJob = async ({ payload }: { payload: Record<string, unknown> }) => {
      captured.push(payload);
      return "job-smoke";
    };
    await executeCommand(createCommandRegistry(), "allstatus hello", {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJob,
    });
    await executeCommand(createCommandRegistry(), "allstatusx 3 hello", {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJob,
    });
    expect(captured).toEqual([
      { text: "hello", count: 1 },
      { text: "hello", count: 3 },
    ]);
  });
});

describe("Session-scoped Join Manager settings", () => {
  it("isolates settings between sessions and persists the updated shape", () => {
    const workspaceId = `join-settings-${Date.now()}-${Math.random()}`;
    const first = createSession({ workspaceId, sessionName: "first" });
    const second = createSession({ workspaceId, sessionName: "second" });
    expect(first.createdAt).toEqual(expect.any(Number));
    expect(second.createdAt).toEqual(expect.any(Number));
    const beforeSecond = getSessionJoinSettings(workspaceId, second.sessionId);
    expect(beforeSecond).toMatchObject({
      delayMs: 5000,
      minDelayMs: 5000,
      maxDelayMs: 5000,
      mode: "auto",
    });
    updateSessionJoinSettings(workspaceId, first.sessionId, {
      targetCount: 1000,
      delayMs: 12000,
      minDelayMs: 5000,
      maxDelayMs: 30000,
      batchCycles: 4,
      mode: "request",
      maxConcurrency: 5,
      retryLimit: 4,
      retryBaseMs: 7000,
      sessionCooldownMs: 45000,
      restrictionThreshold: 5,
    });
    expect(getSessionJoinSettings(workspaceId, first.sessionId)).toMatchObject({
      targetCount: 1000,
      delayMs: 12000,
      minDelayMs: 5000,
      maxDelayMs: 30000,
      batchCycles: 4,
      mode: "request",
      maxConcurrency: 5,
      retryLimit: 4,
      retryBaseMs: 7000,
      sessionCooldownMs: 45000,
      restrictionThreshold: 5,
    });
    expect(getSessionJoinSettings(workspaceId, second.sessionId)).toEqual(
      beforeSecond,
    );
  });

  it("supports explicit zero-delay Immediate mode without corrupting min/max bounds", () => {
    const workspaceId = `join-delay-${Date.now()}-${Math.random()}`;
    const session = createSession({ workspaceId, sessionName: "delay-test" });
    updateSessionJoinSettings(workspaceId, session.sessionId, {
      mode: "immediate",
      delayMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    });
    expect(getSessionJoinSettings(workspaceId, session.sessionId)).toMatchObject({
      delayMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    });
  });
});

describe("Global Sudo policy", () => {
  it("persists workspace identities and removes them cleanly", async () => {
    const { resolveUser, getWorkspaceSudo, updateWorkspaceSudo } =
      await import("../src/core/session-registry.js");
    const user = resolveUser(`sudo-${Date.now()}-${Math.random()}`);
    expect(getWorkspaceSudo(user.workspaceId)).toEqual([]);
    updateWorkspaceSudo(user.workspaceId, "add", "15551234567@s.whatsapp.net");
    expect(getWorkspaceSudo(user.workspaceId)).toContain(
      "15551234567@s.whatsapp.net",
    );
    updateWorkspaceSudo(
      user.workspaceId,
      "remove",
      "15551234567@s.whatsapp.net",
    );
    expect(getWorkspaceSudo(user.workspaceId)).toEqual([]);
  });
});
