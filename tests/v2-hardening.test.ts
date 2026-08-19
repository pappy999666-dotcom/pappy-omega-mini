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
import { createSafeError, renderSafeError } from "../src/core/errors.js";
import { classifyDisconnect } from "../src/whatsapp/session-manager.js";
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

  it("classifies all critical WhatsApp disconnect families with recovery guidance", () => {
    expect(classifyDisconnect({ output: { statusCode: 401 } })).toMatchObject({
      code: 401,
      label: "logged-out",
      terminal: true,
      status: "LOGGED_OUT",
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
    expect(response).toContain("PAPPY OMEGA MINI");
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
});

describe("Session-scoped Join Manager settings", () => {
  it("isolates settings between sessions and persists the updated shape", () => {
    const workspaceId = `join-settings-${Date.now()}-${Math.random()}`;
    const first = createSession({ workspaceId, sessionName: "first" });
    const second = createSession({ workspaceId, sessionName: "second" });
    const beforeSecond = getSessionJoinSettings(workspaceId, second.sessionId);
    updateSessionJoinSettings(workspaceId, first.sessionId, {
      targetCount: 1000,
      mode: "request",
      maxConcurrency: 5,
    });
    expect(getSessionJoinSettings(workspaceId, first.sessionId)).toMatchObject({
      targetCount: 1000,
      mode: "request",
      maxConcurrency: 5,
    });
    expect(getSessionJoinSettings(workspaceId, second.sessionId)).toEqual(
      beforeSecond,
    );
  });

  it("normalizes unsafe delay values instead of persisting zero-delay joins", () => {
    const workspaceId = `join-delay-${Date.now()}-${Math.random()}`;
    const session = createSession({ workspaceId, sessionName: "delay-test" });
    updateSessionJoinSettings(workspaceId, session.sessionId, {
      delayMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    });
    expect(getSessionJoinSettings(workspaceId, session.sessionId)).toMatchObject({
      delayMs: 1000,
      minDelayMs: 1000,
      maxDelayMs: 1000,
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
