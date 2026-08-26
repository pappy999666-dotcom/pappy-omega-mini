import { describe, expect, it } from "vitest";
import { createSession, getSession, getSessionJoinSettings, resolveUser, updateSessionJoinSettings } from "../src/core/session-registry.js";
import { createCommandRegistry, executeCommand } from "../src/whatsapp/command-registry.js";
import { joinWhatsAppInvite } from "../src/jobs/join-operation.js";

describe("WhatsApp join command semantics", () => {
  it("uses direct .join for one supplied invite instead of enqueueing Join Manager", async () => {
    const user = resolveUser(`direct-join-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "direct-join" });
    let captured: { target: string; mode: string | undefined } | undefined;
    const result = await executeCommand(createCommandRegistry(), "join https://chat.whatsapp.com/ABC_123", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      joinInvite: async (target, mode) => {
        captured = { target, mode };
        return { success: true, title: "Alpha", jid: "120@g.us", stage: "accept" };
      },
    });
    expect(captured).toEqual({ target: "https://chat.whatsapp.com/ABC_123", mode: "auto" });
    expect(result).toContain("DIRECT JOIN RESULT");
    expect(result).toContain("JOINED · ACCEPTED BY WHATSAPP");
    expect(result).not.toContain("Join Manager started");
  });

  it("extracts one invite from a quoted message for direct .join", async () => {
    const user = resolveUser(`quoted-join-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "quoted-join" });
    let target = "";
    await executeCommand(createCommandRegistry(), "join", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      quotedText: "Join this group: https://chat.whatsapp.com/QUOTED_123 now",
      joinInvite: async (value) => {
        target = value;
        return { success: false, alreadyMember: true, title: "Quoted Group", jid: "120@g.us", stage: "membership", error: "Already a member." };
      },
    });
    expect(target).toBe("https://chat.whatsapp.com/QUOTED_123");
  });

  it("makes .jm off cancel Join Manager and .jm on pass an exact configured delay", async () => {
    const user = resolveUser(`jm-toggle-${Date.now()}-${Math.random()}`);
    const session = createSession({ workspaceId: user.workspaceId, sessionName: "jm-toggle" });
    updateSessionJoinSettings(user.workspaceId, session.sessionId, { delayMs: 30_000 });
    expect(getSessionJoinSettings(user.workspaceId, session.sessionId)).toMatchObject({ delayMs: 30_000, minDelayMs: 30_000, maxDelayMs: 30_000 });
    updateSessionJoinSettings(user.workspaceId, session.sessionId, {
      delayMs: 30_000,
      minDelayMs: 1_000,
      maxDelayMs: 1_000,
    });
    let cancelled = false;
    const off = await executeCommand(createCommandRegistry(), "jm off", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      cancelJobs: async () => { cancelled = true; return 1; },
    });
    expect(cancelled).toBe(true);
    expect(off).toContain("Join Manager is OFF");

    let payload: Record<string, unknown> | undefined;
    const on = await executeCommand(createCommandRegistry(), "jm on", {
      workspaceId: user.workspaceId,
      sessionId: session.sessionId,
      isOwner: true,
      args: [],
      enqueueJoinJob: async (input) => {
        payload = input.payload;
        return { jobCode: "JM123456", targetCount: 2, delayMs: 30_000, expectedTimeMs: 30_000 };
      },
    });
    expect(payload).toMatchObject({ delayMs: 30_000, minDelayMs: 1_000, maxDelayMs: 1_000, fixedDelay: true });
    expect(on).toContain("Delay");
    expect(getSession(user.workspaceId, session.sessionId).autoJoinEnabled).toBe(true);
  });
});

describe("Join request classification", () => {
  it("submits a request in auto mode when accept reports approval required", async () => {
    const calls: string[] = [];
    const result = await joinWhatsAppInvite({
      groupFetchAllParticipating: async () => ({}),
      groupGetInviteInfo: async () => ({ id: "120@g.us", subject: "Approval Group" }),
      groupAcceptInvite: async () => { throw new Error("membership approval required"); },
      groupRequestJoin: async (code) => { calls.push(code); return "120@g.us"; },
    }, "https://chat.whatsapp.com/APPROVAL_123");
    expect(result).toMatchObject({ success: false, requestRequired: true, title: "Approval Group", stage: "request", error: "Join request submitted." });
    expect(calls).toEqual(["APPROVAL_123"]);
  });
});
