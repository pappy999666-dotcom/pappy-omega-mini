import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { createSession } from "../src/core/session-registry.js";
import { createCommandRegistry, executeCommand, type WhatsAppCommandReply } from "../src/whatsapp/command-registry.js";
import { getGroupModerationSnapshot, setGroupChatMode, updateParticipantBlockStatus, deleteWhatsAppMessage } from "../src/whatsapp/transport-adapter.js";

vi.mock("../src/whatsapp/transport-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/whatsapp/transport-adapter.js")>();
  return {
    ...actual,
    getGroupModerationSnapshot: vi.fn(),
    setGroupChatMode: vi.fn(),
    updateParticipantBlockStatus: vi.fn(),
    deleteWhatsAppMessage: vi.fn(),
  };
});

const mockedSnapshot = vi.mocked(getGroupModerationSnapshot);
const mockedChatMode = vi.mocked(setGroupChatMode);
const mockedBlock = vi.mocked(updateParticipantBlockStatus);
const mockedDelete = vi.mocked(deleteWhatsAppMessage);

const groupJid = "120363000000000000@g.us";

function context(overrides: Record<string, unknown> = {}) {
  const session = createSession({ workspaceId: "moderation-test-workspace", sessionName: "moderation-test-session", phoneNumber: "2348012345678" });
  return {
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    isOwner: true,
    senderJid: "2348012345678@s.whatsapp.net",
    chatJid: groupJid,
    args: [],
    enqueueGroupControlJob: vi.fn(async () => ({ jobCode: "MOD1234" })),
    sendCurrentGroupPoll: vi.fn(async () => undefined),
    ...overrides,
  };
}

const snapshot = {
  isAdmin: true,
  subject: "Test Group",
  participants: [
    { id: "2348012345678@s.whatsapp.net", phoneNumber: "2348012345678", admin: "admin" },
    { id: "2348022222222@s.whatsapp.net", phoneNumber: "2348022222222" },
    { id: "447700000003@s.whatsapp.net", phoneNumber: "447700000003" },
    { id: "2348099999999@s.whatsapp.net", phoneNumber: "2348099999999", admin: "admin" },
    { id: "unknown@lid" },
  ],
};

async function confirmPreview(preview: unknown, ctx: ReturnType<typeof context>): Promise<unknown> {
  const reply = preview as WhatsAppCommandReply;
  const confirm = reply.nativeFlow?.find((button) => button.id?.includes(":confirm:"));
  expect(confirm?.id).toBeTruthy();
  return executeCommand(createCommandRegistry(), confirm!.id!, ctx);
}

describe("WhatsApp remaining group moderation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedSnapshot.mockResolvedValue(snapshot as never);
  });

  afterAll(async () => {
    await rm("/tmp/pappy-omega-mini-moderation-test", { recursive: true, force: true }).catch(() => undefined);
  });

  it("rejects LID-only targets and never renders raw LID identities", async () => {
    const result = await executeCommand(createCommandRegistry(), "ban", context({ args: [], mentionedJids: ["unknown@lid"] }));
    expect(String(result)).toContain("LID-only targets are rejected");
    expect(String(result)).not.toContain("unknown@lid");
  });

  it("requires native confirmation for kick, fresh membership, and one durable job", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "kick 2348022222222", ctx);
    expect((preview as WhatsAppCommandReply).text).toContain("No action queued");
    expect((preview as WhatsAppCommandReply).text).toContain("@2348022222222");
    expect((preview as WhatsAppCommandReply).mentions).toEqual(["2348022222222@s.whatsapp.net"]);
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid, operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net"] });
    expect(mockedSnapshot).toHaveBeenCalledWith(ctx.workspaceId, ctx.sessionId, groupJid, { fresh: true });
  });

  it("builds kick-all as a styled review with real mentions and queues verified phone removals after confirmation", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "kickall", ctx);
    const reply = preview as WhatsAppCommandReply;
    expect(reply.text).toContain("REMOVE REVIEW");
    expect(reply.text).toContain("@2348022222222");
    expect(reply.text).toContain("@447700000003");
    expect(reply.mentions).toEqual(["2348022222222@s.whatsapp.net", "447700000003@s.whatsapp.net"]);
    expect(reply.nativeTable?.buttons?.some((button) => button.id?.includes(":confirm:"))).toBe(true);
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid, operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net", "447700000003@s.whatsapp.net"] });
  });

  it("maps dnkick to a real demote-then-remove durable action", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "dnkick 2348099999999", ctx);
    expect((preview as WhatsAppCommandReply).mentions).toEqual(["2348099999999@s.whatsapp.net"]);
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid, operation: "participant", participantAction: "demote-remove", participants: ["2348099999999@s.whatsapp.net"] });
  });

  it("persists local bans by WhatsApp scope and masks banlist output", async () => {
    const ctx = context();
    const banPreview = await executeCommand(createCommandRegistry(), "ban 2348022222222", ctx);
    expect((banPreview as WhatsAppCommandReply).text).toContain("No action queued");
    expect((banPreview as WhatsAppCommandReply).mentions).toEqual(["2348022222222@s.whatsapp.net"]);
    const banResult = await confirmPreview(banPreview, ctx);
    expect((banResult as WhatsAppCommandReply).mentions).toEqual(["2348022222222@s.whatsapp.net"]);

    const list = await executeCommand(createCommandRegistry(), "banlist", ctx);
    expect(list).toContain("+234•••2222");
    expect(list).not.toContain("2348022222222@s.whatsapp.net");
  });

  it("keeps manual warning counts durable and does not auto-kick at threshold", async () => {
    const ctx = context();
    const warnOne = await executeCommand(createCommandRegistry(), "warn 447700000003", ctx);
    expect((warnOne as WhatsAppCommandReply).text).toContain("1 / 3");
    expect((warnOne as WhatsAppCommandReply).mentions).toEqual(["447700000003@s.whatsapp.net"]);
    const warnTwo = await executeCommand(createCommandRegistry(), "warn 447700000003", ctx);
    expect((warnTwo as WhatsAppCommandReply).text).toContain("2 / 3");
    expect((warnTwo as WhatsAppCommandReply).mentions).toEqual(["447700000003@s.whatsapp.net"]);
    const thresholdPreview = await executeCommand(createCommandRegistry(), "warn 447700000003", ctx);
    expect((thresholdPreview as WhatsAppCommandReply).text).toContain("No action queued");
    expect((thresholdPreview as WhatsAppCommandReply).mentions).toEqual(["447700000003@s.whatsapp.net"]);
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(thresholdPreview, ctx);
    const warningStatus = await executeCommand(createCommandRegistry(), "warns 447700000003", ctx);
    expect((warningStatus as WhatsAppCommandReply).text).toContain("⎔ Warnings · ⇆ 3 / 3");
    expect((warningStatus as WhatsAppCommandReply).mentions).toEqual(["447700000003@s.whatsapp.net"]);
    const warningReset = await executeCommand(createCommandRegistry(), "unwarn 447700000003", ctx);
    expect((warningReset as WhatsAppCommandReply).text).toContain("WARNING RESET");
    expect((warningReset as WhatsAppCommandReply).mentions).toEqual(["447700000003@s.whatsapp.net"]);
  });

  it("uses the clean card format for kick and group-wide mute previews and completions", async () => {
    const ctx = context();
    const kickPreview = await executeCommand(createCommandRegistry(), "kick 2348022222222", ctx);
    const kickText = (kickPreview as WhatsAppCommandReply).text;
    expect(kickText).toContain("𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜");
    expect(kickText).toContain("*MEMBER CONTROL REVIEW*");
    expect(kickText).toContain("⎔ Target      · ⇆ @2348022222222");
    expect(kickText).not.toContain("✦ PAPPY OMEGA MINI · MEMBER CONTROL REVIEW");
    const kickCompletion = await confirmPreview(kickPreview, ctx);
    expect((kickCompletion as WhatsAppCommandReply).text).toContain("𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜");
    expect((kickCompletion as WhatsAppCommandReply).mentions).toEqual(["2348022222222@s.whatsapp.net"]);

    const mutePreview = await executeCommand(createCommandRegistry(), "mute", ctx);
    const muteText = (mutePreview as WhatsAppCommandReply).text;
    expect(muteText).toContain("*MODERATION REVIEW*");
    expect(muteText).toContain("⎔ Action      · ⇆ MUTE · No action queued");
    expect(muteText).toContain("⎔ Scope       · ⇆ This group only");
    expect(muteText).not.toContain("✦ PAPPY OMEGA MINI · MODERATION REVIEW");
    const muteCompletion = await confirmPreview(mutePreview, ctx);
    expect((muteCompletion as WhatsAppCommandReply).text).toContain("*GROUP MUTED*");
    expect((muteCompletion as WhatsAppCommandReply).text).not.toContain("✦ PAPPY OMEGA MINI · GROUP MUTED");
  });

  it("uses group-wide announcement mode for mute and unmute", async () => {
    const ctx = context();
    const mutePreview = await executeCommand(createCommandRegistry(), "mute", ctx);
    expect((mutePreview as WhatsAppCommandReply).text).toContain("No action queued");
    await confirmPreview(mutePreview, ctx);
    const unmutePreview = await executeCommand(createCommandRegistry(), "unmute", ctx);
    await confirmPreview(unmutePreview, ctx);
    expect(mockedChatMode).toHaveBeenNthCalledWith(1, ctx.workspaceId, ctx.sessionId, groupJid, true);
    expect(mockedChatMode).toHaveBeenNthCalledWith(2, ctx.workspaceId, ctx.sessionId, groupJid, false);
  });

  it("creates one bounded blockall confirmation for verified non-admin members only", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "blockall", ctx);
    expect((preview as WhatsAppCommandReply).text).toContain("Selected");
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({
      groupJid,
      operation: "participant",
      participantAction: "block",
      participants: ["2348022222222@s.whatsapp.net", "447700000003@s.whatsapp.net"],
    });
    expect(mockedBlock).not.toHaveBeenCalled();
  });

  it("supports native poll creation without turning it into a moderation action", async () => {
    const ctx = context();
    const result = await executeCommand(createCommandRegistry(), "poll Best color? | Red | Blue", ctx);
    expect(result).toContain("POLL CREATED");
    expect(ctx.sendCurrentGroupPoll).toHaveBeenCalledWith({ question: "Best color?", options: ["Red", "Blue"] });
  });

  it("requires one bounded native confirmation for filterout", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "filterout 1 234", ctx);
    expect((preview as WhatsAppCommandReply).text).toContain("FILTEROUT REVIEW");
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid, operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net"] });
  });

  it("keeps deleteall bounded and scoped to recent tracked messages", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "deleteall 2348022222222", ctx);
    expect((preview as WhatsAppCommandReply).text).toContain("No action queued");
    await confirmPreview(preview, ctx);
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(String(await executeCommand(createCommandRegistry(), "deleteall", context({ chatJid: "120363000000000000@s.whatsapp.net" })))).toContain("inside a WhatsApp group");
  });

  it("does not register welcome or goodbye automation in the moderation surface", () => {
    const names = createCommandRegistry().map((entry) => entry.name);
    for (const excluded of ["welcome", "goodbye", "setwelcome", "welcomemsg", "setgoodbye", "goodbyemsg"]) expect(names).not.toContain(excluded);
  });
});
