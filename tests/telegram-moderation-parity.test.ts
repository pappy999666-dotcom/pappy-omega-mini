import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const botSourcePath = new URL("../src/telegram/bot.ts", import.meta.url);
const transportSourcePath = new URL("../src/whatsapp/transport-adapter.ts", import.meta.url);

describe("Telegram moderation parity", () => {
  it("uses one state-changing button for chat and info mode", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain("snapshot.chatAdminsOnly === true ? \"all\" : \"admins\"");
    expect(source).toContain("snapshot.infoAdminsOnly === true ? \"all\" : \"admins\"");
    expect(source).not.toContain('"Chat: Admins Only",');
    expect(source).not.toContain('"Chat: Everyone",');
    expect(source).not.toContain('"Info: Admins Only",');
    expect(source).not.toContain('"Info: Everyone",');
  });

  it("keeps disappearing-message callbacks and navigation on registered routes", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain("group:moderation:ephemeral:90d:");
    expect(source).not.toContain("group:moderation:90d:");
    expect(source).not.toContain("session:${session.sessionId}:action:groups");
    expect(source).not.toContain("session:${groupLeave.sessionId}:action:groups");
  });

  it("uses the correct approval/rejection route captures", async () => {
    const source = await readFile(botSourcePath, "utf8");
    expect(source).toContain('ctx.match[2] === "reject"');
    expect(source).toContain('ctx.match[3] === "country"');
    expect(source).toContain("approvalDashboardDetails(requests)");
    expect(source).toContain("pendingGroupApprovalConfirmation.set(userId");
    expect(source).toContain("session:${session.sessionId}:group:moderation:approval:confirm:");
    expect(source).toContain("getGroupModerationSnapshot(session.workspaceId, session.sessionId, pending.groupJid, { fresh: true })");
    expect(source).toContain("listGroupJoinRequests(session.workspaceId, session.sessionId, pending.groupJid)");
  });

  it("maps live group restriction fields into the moderation snapshot", async () => {
    const source = await readFile(transportSourcePath, "utf8");
    expect(source).toContain("raw.announce");
    expect(source).toContain("raw.restrict");
    expect(source).toContain("raw.ephemeralDuration");
  });
});

