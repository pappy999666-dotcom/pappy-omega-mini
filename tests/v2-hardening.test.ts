import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "../src/core/encrypted-store.js";
import {
  assertOperationAllowed,
  getEmergencyState,
  recordAudit,
  setEmergencyState,
} from "../src/core/control-plane.js";
import { createSafeError, renderSafeError } from "../src/core/errors.js";

describe("V2 hardening", () => {
  it("encrypts and decrypts auth-state values", () => {
    const input = { creds: { id: "session-1" }, keys: ["a", "b"] };
    const encrypted = encryptJson(input);
    expect(encrypted).not.toContain("session-1");
    expect(decryptJson(encrypted)).toEqual(input);
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
