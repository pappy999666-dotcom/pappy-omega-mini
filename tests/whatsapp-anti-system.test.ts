import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/core/session-registry.js";
import { createCommandRegistry, executeCommand } from "../src/whatsapp/command-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../src/menus/menu-model.js";
import { loadGroupAntiConfig, updateModule } from "../src/whatsapp/anti-system/config.js";
import { runAntiChecks, runAntiParticipantEvent } from "../src/whatsapp/anti-system/engine.js";
import { getGroupModerationSnapshot, deleteWhatsAppMessage, sendGroupText, updateGroupParticipantBatch } from "../src/whatsapp/transport-adapter.js";

const antiMocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  deleteMessage: vi.fn(),
  sendText: vi.fn(),
  batch: vi.fn(),
}));

vi.mock("../src/whatsapp/transport-adapter.js", () => ({
  getGroupModerationSnapshot: antiMocks.snapshot,
  deleteWhatsAppMessage: antiMocks.deleteMessage,
  sendGroupText: antiMocks.sendText,
  updateGroupParticipantBatch: antiMocks.batch,
  listGroups: vi.fn(),
  sendGroupMentions: vi.fn(),
  sendGroupStatus: vi.fn(),
  sendGroupColorStatus: vi.fn(),
  sendPersonalStatus: vi.fn(),
  createWhatsAppGroup: vi.fn(),
  getProfilePictureUrl: vi.fn(),
  removeProfilePicture: vi.fn(),
  updateProfileBio: vi.fn(),
  updateProfileName: vi.fn(),
  updateProfilePicture: vi.fn(),
  updateGroupProfilePicture: vi.fn(),
  updateGroupDescription: vi.fn(),
  getGroupInviteCode: vi.fn(),
  listGroupJoinRequests: vi.fn(),
}));

const mockedSnapshot = vi.mocked(getGroupModerationSnapshot);
const mockedDelete = vi.mocked(deleteWhatsAppMessage);
const mockedSend = vi.mocked(sendGroupText);
const mockedBatch = vi.mocked(updateGroupParticipantBatch);

function context(overrides: Record<string, unknown> = {}) {
  const session = createSession({ workspaceId: "anti-test-workspace", sessionName: "anti-test", phoneNumber: "2348012345678" });
  return {
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    isOwner: true,
    senderJid: "2348012345678@s.whatsapp.net",
    chatJid: "120363000000000000@g.us",
    args: [],
    ...overrides,
  };
}

describe("Omega-V1 Anti System parity surface", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedSnapshot.mockResolvedValue({
      jid: "120363000000000000@g.us",
      subject: "Test Group",
      participantCount: 3,
      isAdmin: true,
      participants: [
        { id: "2348012345678@s.whatsapp.net", phoneNumber: "2348012345678", admin: "admin" },
        { id: "2348099999999@s.whatsapp.net", phoneNumber: "2348099999999", admin: "admin" },
        { id: "2348088888888@s.whatsapp.net", phoneNumber: "2348088888888" },
      ],
    });
  });

  it("registers the complete Anti command and menu surface", () => {
    const names = new Set(createCommandRegistry().map((command) => command.name));
    for (const name of [
      "antistatus", "antilink", "antibot", "antispam", "spamlimit", "antipic", "antivid", "antiaud", "antivn", "antitxt", "antiemoji", "antisticker", "antigroupcall", "antinsfw", "antigroupmention", "antigm", "antiwords", "antiaddword", "antirmword", "antiwordlist", "setantiwords", "rmantiwords", "clearantiwords", "antipoll", "antiforward", "antichannel", "antipromote", "antidemote", "silentactions", "linkpermit", "rmlinkpermit", "antiwordsmsg",
    ]) expect(names.has(name)).toBe(true);

    const session = createSession({ workspaceId: "anti-menu-workspace", sessionName: "anti-menu" });
    const rendered = renderAsciiMenu(buildSessionMenu(session, true));
    expect(rendered).toContain("ANTI SYSTEM");
    expect(rendered).toContain(".antistatus");
    expect(rendered).toContain(".antichannel");
    expect(rendered).toContain(".antidemote");
  });

  it("keeps all Anti modules disabled by default and isolates workspace/session/group config", () => {
    const first = context({ workspaceId: "anti-test-workspace-a" });
    const second = context({ workspaceId: "anti-test-workspace-b" });
    const firstConfig = loadGroupAntiConfig(first.workspaceId, first.sessionId, first.chatJid);
    const secondConfig = loadGroupAntiConfig(second.workspaceId, second.sessionId, second.chatJid);
    expect(firstConfig.antilink).toBeUndefined();
    updateModule(first.workspaceId, first.sessionId, first.chatJid, "antilink", { enabled: true, action: "delete" });
    expect(loadGroupAntiConfig(first.workspaceId, first.sessionId, first.chatJid).antilink?.enabled).toBe(true);
    expect(loadGroupAntiConfig(second.workspaceId, second.sessionId, second.chatJid).antilink).toBeUndefined();
    expect(firstConfig.workspaceId).not.toBe(secondConfig.workspaceId);
  });

  it("requires a group and fresh group-admin permission for Anti configuration", async () => {
    const direct = context({ chatJid: "2348012345678@s.whatsapp.net" });
    expect(await executeCommand(createCommandRegistry(), "antilink delete", direct)).toContain("inside a WhatsApp group");
    mockedSnapshot.mockResolvedValueOnce({ isAdmin: false } as never);
    expect(await executeCommand(createCommandRegistry(), "antilink delete", context())).toContain("not an administrator");
  });

  it("supports custom messages, permits, AntiWords, and silent actions", async () => {
    const ctx = context({ senderJid: "2348012345678@s.whatsapp.net", quotedSenderJid: "2348088888888@s.whatsapp.net" });
    await executeCommand(createCommandRegistry(), "antilink delete", ctx);
    await executeCommand(createCommandRegistry(), "linkpermit", ctx);
    await executeCommand(createCommandRegistry(), "antilinkmsg stop @mention", ctx);
    await executeCommand(createCommandRegistry(), "setantiwords scam,free money", ctx);
    await executeCommand(createCommandRegistry(), "silentactions on", ctx);
    const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, ctx.chatJid);
    expect(config.antilink?.permitList).toContain("2348088888888@s.whatsapp.net");
    expect(config.messages.antilink).toContain("stop");
    expect(config.antiwords?.words).toEqual(expect.arrayContaining(["scam", "free money"]));
    expect(config.silentActionMessages).toBe(true);
  });

  it("does nothing when AntiLink is disabled, then deletes one URL message when enabled", async () => {
    const ctx = context();
    const input = {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      groupJid: ctx.chatJid,
      messageId: "anti-url-1",
      senderJid: "2348088888888@s.whatsapp.net",
      text: "https://example.test/invite",
      message: { conversation: "https://example.test/invite" },
      rawKey: { remoteJid: ctx.chatJid, id: "anti-url-1", participant: "2348088888888@s.whatsapp.net" },
    } as const;
    expect(await runAntiChecks(input)).toEqual([]);
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antilink", { enabled: true, action: "delete" });
    expect(await runAntiChecks({ ...input, messageId: "anti-url-2", rawKey: { ...input.rawKey, id: "anti-url-2" } })).toHaveLength(1);
    expect(mockedDelete).toHaveBeenCalledTimes(1);
  });

  it("detects media, voice notes, plain text, emoji-only, and words independently", async () => {
    const ctx = context();
    for (const key of ["antipic", "antivn", "antitxt", "antiemoji", "antiwords"] as const) updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, key, { enabled: true, action: "delete" });
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antiwords", { enabled: true, action: "delete" });
    const base = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, senderJid: "2348088888888@s.whatsapp.net", rawKey: { remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" } };
    const words = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, ctx.chatJid);
    words.antiwords = { ...(words.antiwords ?? { enabled: true, action: "delete", warnThreshold: 3, permitList: [], words: [] }), enabled: true, action: "delete", words: ["scam"] };
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antiwords", words.antiwords);
    await runAntiChecks({ ...base, messageId: "media-1", text: "", mediaKind: "image", message: { imageMessage: {} } });
    await runAntiChecks({ ...base, messageId: "voice-1", text: "", mediaKind: "audio", mediaPtt: true, message: { audioMessage: { ptt: true } } });
    await runAntiChecks({ ...base, messageId: "text-1", text: "ordinary text", message: { conversation: "ordinary text" } });
    await runAntiChecks({ ...base, messageId: "emoji-1", text: "😀😀", message: { conversation: "😀😀" } });
    await runAntiChecks({ ...base, messageId: "word-1", text: "this is scam", message: { conversation: "this is scam" } });
    expect(mockedDelete.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("detects sender-owned links inside view-once media and poll payloads but not quoted content", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antilink", { enabled: true, action: "delete" });
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antipoll", { enabled: true, action: "delete" });
    const base = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, senderJid: "2348088888888@s.whatsapp.net", rawKey: { remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" } };
    const quotedOnly = await runAntiChecks({ ...base, messageId: "quoted-only-link", text: "hello", quotedText: "https://quoted.example", message: { extendedTextMessage: { text: "hello", contextInfo: { quotedMessage: { conversation: "https://quoted.example" } } } } });
    expect(quotedOnly).toEqual([]);
    const wrapped = await runAntiChecks({ ...base, messageId: "view-once-link", text: "", message: { viewOnceMessageV2: { message: { imageMessage: { caption: "visit https://wrapped.example" } } } } });
    expect(wrapped.some((decision) => decision.module === "antilink")).toBe(true);
    const poll = await runAntiChecks({ ...base, messageId: "poll-link", text: "", message: { pollCreationMessageV3: { name: "Vote here https://poll.example", options: [{ optionName: "yes" }] } } });
    expect(poll.some((decision) => decision.module === "antilink")).toBe(true);
    expect(poll.some((decision) => decision.module === "antipoll")).toBe(true);
  });

  it("renders Anti violations as the clean warning card with a real WhatsApp mention", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antigstatus", { enabled: true, action: "warn", warnThreshold: 6 });
    const decisions = await runAntiChecks({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      groupJid: ctx.chatJid,
      messageId: "gstatus-card-1",
      senderJid: "2348088888888@s.whatsapp.net",
      text: "",
      message: { groupStatusMessageV2: { message: { conversation: "status payload" } } },
      rawKey: { id: "gstatus-card-1", remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" },
    });
    expect(decisions.some((decision) => decision.module === "antigstatus")).toBe(true);
    const cardCall = mockedSend.mock.calls.find((call) => call[3]?.includes("ANTIGROUPSTATUS DETECTED"));
    expect(cardCall?.[3]).toContain("⎔ Target   · ⇆ @2348088888888");
    expect(cardCall?.[3]).toContain("⎔ Group    · ⇆ Test Group");
    expect(cardCall?.[3]).toContain("⎔ Warnings · ⇆ 1 / 6");
    expect(cardCall?.[5]).toEqual(["2348088888888@s.whatsapp.net"]);
  });

  it("exempts ordinary administrators from message Anti modules but keeps dedicated security separate", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antilink", { enabled: true, action: "delete" });
    const decisions = await runAntiChecks({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, messageId: "admin-link", senderJid: "2348099999999@s.whatsapp.net", text: "https://admin.example", message: { conversation: "https://admin.example" }, rawKey: { id: "admin-link", remoteJid: ctx.chatJid, participant: "2348099999999@s.whatsapp.net" } });
    expect(decisions).toEqual([]);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("distinguishes genuine Status-at-Group mentions from ordinary group status wrappers", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antigm", { enabled: true, action: "delete" });
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antigstatus", { enabled: true, action: "delete" });
    const base = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, senderJid: "2348088888888@s.whatsapp.net", rawKey: { remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" } };
    const ordinary = await runAntiChecks({ ...base, messageId: "ordinary-status", text: "", message: { groupStatusMentionMessage: {} } });
    expect(ordinary).toEqual([]);
    const realMention = await runAntiChecks({ ...base, messageId: "real-status-mention", text: "", message: { groupStatusMentionMessage: { message: { conversation: "status payload" } } } });
    expect(realMention.some((decision) => decision.module === "antigm")).toBe(true);
    const statusPost = await runAntiChecks({ ...base, messageId: "status-post", text: "", message: { groupStatusMessageV2: { message: { conversation: "group status" } } } });
    expect(statusPost.some((decision) => decision.module === "antigstatus")).toBe(true);
  });

  it("uses conservative AntiBot signals and ignores ordinary client messages", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antibot", { enabled: true, action: "delete" });
    const ordinary = await runAntiChecks({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, messageId: "ordinary-client-123456", senderJid: "2348088888888@s.whatsapp.net", text: "hello", message: { conversation: "hello" }, rawKey: { id: "ordinary-client-123456", remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" } });
    expect(ordinary).toEqual([]);
    const botLike = await runAntiChecks({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, messageId: "3EB123456789012", senderJid: "2348088888888@s.whatsapp.net", text: "hello", message: { conversation: "hello" }, rawKey: { id: "3EB123456789012", remoteJid: ctx.chatJid, participant: "2348088888888@s.whatsapp.net" } });
    expect(botLike.some((decision) => decision.module === "antibot")).toBe(true);
  });

  it("reports unsupported modules honestly and never approximates their detection", async () => {
    const ctx = context();
    const result = await executeCommand(createCommandRegistry(), "antinsfw kick", ctx);
    expect(result).toContain("Unavailable");
    expect(result).toContain("No NSFW provider");
    const moduleConfig = await executeCommand(createCommandRegistry(), "antigstatus delete", ctx);
    expect(moduleConfig).toContain("⌬ ⤷ *ANTIGSTATUS CONFIG* ⚙︎");
    expect(moduleConfig).toContain("⎔ Mode        · ⇆ Enabled [ delete ]");
    expect(moduleConfig).toContain("⎔ Scope       · ⇆ This group only");
    expect(moduleConfig).toContain("⎔ Access      · ⇆ Local-only");
    expect(moduleConfig).toContain("» *Note:* Available only when raw group-status metadata is retained.");
    expect(moduleConfig).not.toContain("✦ PAPPY OMEGA MINI · AntiGStatus");
    const status = await executeCommand(createCommandRegistry(), "antistatus", ctx);
    expect(status).toContain("AntiGroupCall");
    expect(status).toContain("Unavailable");
  });

  it("bypasses AntiText for the configured custom prefix", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antitxt", { enabled: true, action: "delete" });
    const decisions = await runAntiChecks({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, messageId: "custom-prefix-1", senderJid: "2348088888888@s.whatsapp.net", prefix: "!", text: "!ping", message: { conversation: "!ping" }, rawKey: { id: "custom-prefix-1", remoteJid: ctx.chatJid } });
    expect(decisions).toEqual([]);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("restores protected participant changes and applies the configured security penalty", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antidemote", { enabled: true, action: "kick", mode: "restorekick", targetMode: "admins" });
    const handled = await runAntiParticipantEvent({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, action: "demote", participants: ["2348099999999@s.whatsapp.net"], author: "2348088888888@s.whatsapp.net" });
    expect(handled).toBe(true);
    expect(mockedBatch).toHaveBeenNthCalledWith(1, ctx.workspaceId, ctx.sessionId, ctx.chatJid, ["2348099999999@s.whatsapp.net"], "promote", false);
    expect(mockedBatch).toHaveBeenNthCalledWith(2, ctx.workspaceId, ctx.sessionId, ctx.chatJid, ["2348088888888@s.whatsapp.net"], "remove", false);
  });

  it("escalates warn action to kick at the configured threshold", async () => {
    const ctx = context();
    updateModule(ctx.workspaceId, ctx.sessionId, ctx.chatJid, "antilink", { enabled: true, action: "warn", warnThreshold: 2 });
    const base = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, groupJid: ctx.chatJid, senderJid: "2348088888888@s.whatsapp.net", text: "https://example.test", message: { conversation: "https://example.test" } };
    await runAntiChecks({ ...base, messageId: "warn-1", rawKey: { id: "warn-1", remoteJid: ctx.chatJid, participant: base.senderJid } });
    await runAntiChecks({ ...base, messageId: "warn-2", rawKey: { id: "warn-2", remoteJid: ctx.chatJid, participant: base.senderJid } });
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedSend.mock.calls[1]?.[3]).toContain("𝗦𝗬𝗦𝗧𝗘𝗠 𝗪𝗔𝗥𝗡𝗜𝗡𝗚");
    expect(mockedSend.mock.calls[1]?.[5]).toEqual(["2348088888888@s.whatsapp.net"]);
    expect(mockedBatch).toHaveBeenCalledWith(ctx.workspaceId, ctx.sessionId, ctx.chatJid, [base.senderJid], "remove", false);
  });
});
