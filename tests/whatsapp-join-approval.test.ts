import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createSession } from "../src/core/session-registry.js";
import { createCommandRegistry, executeCommand, type WhatsAppCommandReply } from "../src/whatsapp/command-registry.js";
import { extractWhatsAppInteraction } from "../src/whatsapp/quoted-payload-resolver.js";
import { routeWhatsAppText } from "../src/whatsapp/message-router.js";
import { getGroupModerationSnapshot, listGroupJoinRequests } from "../src/whatsapp/transport-adapter.js";

vi.mock("../src/jobs/runtime.js", () => ({
  getWorkerRuntime: vi.fn(() => ({
    enqueue: vi.fn(async () => ({ jobCode: "ROUTE1234" })),
    listAllJobs: vi.fn(async () => []),
    listRecent: vi.fn(async () => []),
    cancel: vi.fn(async () => undefined),
  })),
}));

vi.mock("../src/whatsapp/transport-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/whatsapp/transport-adapter.js")>();
  return { ...actual, getGroupModerationSnapshot: vi.fn(), listGroupJoinRequests: vi.fn() };
});

const mockedSnapshot = vi.mocked(getGroupModerationSnapshot);
const mockedList = vi.mocked(listGroupJoinRequests);

function context(overrides: Record<string, unknown> = {}) {
  const session = createSession({ workspaceId: "approval-workspace", sessionName: "approval-session", phoneNumber: "2348012345678" });
  return {
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    isOwner: true,
    senderJid: "2348012345678@s.whatsapp.net",
    chatJid: "120363000000000000@g.us",
    args: [],
    enqueueGroupControlJob: vi.fn(async () => ({ jobCode: "JOIN1234" })),
    ...overrides,
  };
}

async function confirmPreview(preview: unknown, ctx: ReturnType<typeof context>): Promise<unknown> {
  expect(preview).toBeTypeOf("object");
  const reply = preview as WhatsAppCommandReply;
  const confirm = reply.nativeFlow?.find((button) => button.id?.includes(":confirm:"));
  expect(confirm?.id).toBeTruthy();
  return executeCommand(createCommandRegistry(), confirm!.id!, ctx);
}

describe("WhatsApp Join Approval commands", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedSnapshot.mockResolvedValue({ isAdmin: true } as never);
    mockedList.mockResolvedValue([
      { jid: "111@s.whatsapp.net", phoneNumber: "2348011111111" },
      { jid: "222@s.whatsapp.net", phoneNumber: "447700000002" },
      { jid: "lid-333@lid" },
    ]);
  });

  it("lists the actual pending requests through a native table", async () => {
    const result = await executeCommand(createCommandRegistry(), "pendingjoin", context());
    expect(result).toBeTypeOf("object");
    expect((result as WhatsAppCommandReply).text).toContain("Pending · 3");
    expect((result as WhatsAppCommandReply).nativeTable?.headers).toEqual(["#", "Identity", "Country"]);
    expect((result as WhatsAppCommandReply).nativeTable?.rows[0]).toEqual(["1", "+234•••1111", "+2348"]);
    expect(mockedSnapshot).toHaveBeenCalledWith("approval-workspace", expect.any(String), "120363000000000000@g.us", { fresh: true });
  });

  it("never renders or accepts unresolved LID identities", async () => {
    const pending = await executeCommand(createCommandRegistry(), "pendingjoin", context());
    expect(JSON.stringify(pending)).not.toContain("lid-333@lid");
    expect(JSON.stringify(pending)).not.toContain("LID-only");
    expect(JSON.stringify(pending)).toContain("Verified phone unavailable");
    const sudo = await executeCommand(createCommandRegistry(), "setsudo add", context({ mentionedJids: ["lid-333@lid"], args: ["add"] }));
    expect(sudo).toContain("LID-only identities are not accepted");
    expect(sudo).not.toContain("lid-333@lid");
  });

  it("does not queue approveall until the native Confirm action is tapped", async () => {
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "approveall", ctx);
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    expect((preview as WhatsAppCommandReply).nativeTable?.buttons).toHaveLength(2);
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "approve", participants: ["2348011111111@s.whatsapp.net", "447700000002@s.whatsapp.net"] });
  });

  it("makes reject and approve aliases non-destructive usage guidance", async () => {
    const ctx = context();
    const reject = await executeCommand(createCommandRegistry(), "reject all", ctx);
    expect(reject).toContain("REJECTION COMMANDS");
    expect(reject).toContain(".rejectall");
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    const approve = await executeCommand(createCommandRegistry(), "approve", ctx);
    expect(approve).toContain("APPROVAL COMMANDS");
    expect(approve).toContain("Every bulk approval requires a native Confirm step");
  });

  it("preserves the full 820-request batch while requiring one confirmation", async () => {
    const requests = Array.from({ length: 820 }, (_, index) => ({ jid: `request-${index}@s.whatsapp.net`, phoneNumber: `234800${String(index).padStart(6, "0")}` }));
    mockedList.mockResolvedValue(requests);
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "approveall", ctx);
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "approve", participants: requests.map((request) => request.phoneNumber ? `${request.phoneNumber}@s.whatsapp.net` : request.jid).filter((jid) => !jid.includes("@lid")) });
  });

  it("requires confirmation for amount and country selectors and handles direct PN JIDs", async () => {
    const amount = context();
    const amountPreview = await executeCommand(createCommandRegistry(), "approveamt 2", amount);
    await confirmPreview(amountPreview, amount);
    expect(amount.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "approve", participants: ["2348011111111@s.whatsapp.net", "447700000002@s.whatsapp.net"] });

    mockedList.mockResolvedValue([{ jid: "2348098765432@s.whatsapp.net" }, { jid: "lid-333@lid" }]);
    const country = context();
    const countryPreview = await executeCommand(createCommandRegistry(), "approvecountry 234 all", country);
    expect((countryPreview as WhatsAppCommandReply).text).toContain("country +234");
    await confirmPreview(countryPreview, country);
    expect(country.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "approve", participants: ["2348098765432@s.whatsapp.net"] });
  });

  it("keeps unresolved LID-only requests out of country counts", async () => {
    const result = await executeCommand(createCommandRegistry(), "reqamt 234", context());
    expect(result).toContain("REQUEST COUNT");
    expect(result).toContain("Matched total · ⇆ 1");
    expect(result).toContain("Other excluded · ⇆ 1");
  });

  it("requires native confirmation for protected Kick All and queues one batch", async () => {
    mockedSnapshot.mockResolvedValue({ isAdmin: true, participants: [
      { id: "2348012345678@s.whatsapp.net", phoneNumber: "2348012345678" },
      { id: "2348099999999@s.whatsapp.net", phoneNumber: "2348099999999", admin: "admin" },
      { id: "2348022222222@s.whatsapp.net", phoneNumber: "2348022222222" },
      { id: "447700000003@s.whatsapp.net", phoneNumber: "447700000003" },
    ] } as never);
    const ctx = context();
    const preview = await executeCommand(createCommandRegistry(), "kickall", ctx);
    expect((preview as WhatsAppCommandReply).text).toContain("No action is queued until Confirm is tapped");
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    await confirmPreview(preview, ctx);
    expect(ctx.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net", "447700000003@s.whatsapp.net"] });
  });

  it("uses one confirmation and one job for amount and country member selectors", async () => {
    mockedSnapshot.mockResolvedValue({ isAdmin: true, participants: [
      { id: "2348022222222@s.whatsapp.net", phoneNumber: "2348022222222" },
      { id: "2348033333333@s.whatsapp.net", phoneNumber: "2348033333333" },
      { id: "447700000003@s.whatsapp.net", phoneNumber: "447700000003" },
    ] } as never);
    const amount = context();
    await confirmPreview(await executeCommand(createCommandRegistry(), "kickamt 2 confirm", amount), amount);
    expect(amount.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net", "2348033333333@s.whatsapp.net"] });
    const country = context();
    await confirmPreview(await executeCommand(createCommandRegistry(), "kickcountry 234 10 confirm", country), country);
    expect(country.enqueueGroupControlJob).toHaveBeenCalledWith({ groupJid: "120363000000000000@g.us", operation: "participant", participantAction: "remove", participants: ["2348022222222@s.whatsapp.net", "2348033333333@s.whatsapp.net"] });
  });

  it("rejects approval commands when the WhatsApp identity is not a group admin", async () => {
    mockedSnapshot.mockResolvedValue({ isAdmin: false } as never);
    await expect(executeCommand(createCommandRegistry(), "approveall", context())).rejects.toThrow(/not an administrator/);
  });

  it("uses one batch transport call for approval and rejection jobs", async () => {
    const source = await readFile(new URL("../src/jobs/runtime.ts", import.meta.url), "utf8");
    const approvalBlock = source.slice(source.indexOf('orchestrator.register("group-control"'), source.indexOf('orchestrator.register("join-manager"'));
    expect(approvalBlock).toMatch(/groupJid,\s*remaining,\s*operation,\s*false,/);
    expect(approvalBlock).toContain("let remaining = [...participants]");
    expect(approvalBlock).toContain("finishing the remaining batch tail");
    expect(approvalBlock).toContain("const single = await updateGroupJoinRequests");
    const transport = await readFile(new URL("../src/whatsapp/transport-adapter.ts", import.meta.url), "utf8");
    expect(transport).toContain('status: "not-returned"');
    expect(transport).toContain("updateGroupParticipantBatch");
    expect(transport).toContain('method(socket, "resolveParticipantJid")');
    expect(transport).toContain('method(socket, "resolveParticipantJids")');
    expect(transport).toContain('value.phone_number');
    const registry = await readFile(new URL("../src/whatsapp/command-registry.ts", import.meta.url), "utf8");
    expect(registry).toContain("const [snapshot, requests] = await Promise.all([");
    expect(approvalBlock).toContain("const action = participantAction as");
    expect(approvalBlock).toContain("batch chunk");
  });

  it("parses native-flow, list, legacy-button, and template responses", () => {
    expect(extractWhatsAppInteraction({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: "group-control:confirm:abc123", display_text: "✅ Confirm" }) } } })).toEqual({ kind: "native-flow", id: "group-control:confirm:abc123", displayText: "✅ Confirm" });
    expect(extractWhatsAppInteraction({ listResponseMessage: { singleSelectReply: { selectedRowId: "row-1", selectedDisplayText: "Group" } } })).toEqual({ kind: "list", id: "row-1", displayText: "Group" });
    expect(extractWhatsAppInteraction({ buttonsResponseMessage: { selectedButtonId: "group-control:cancel:abc123", selectedDisplayText: "❌ Cancel" } })).toEqual({ kind: "buttons", id: "group-control:cancel:abc123", displayText: "❌ Cancel" });
    expect(extractWhatsAppInteraction({ templateButtonReplyMessage: { selectedId: "group-control:cancel:abc123", selectedDisplayText: "❌ Cancel" } })).toEqual({ kind: "template", id: "group-control:cancel:abc123", displayText: "❌ Cancel" });
  });

  it("routes a native Confirm tap without a prefix and preserves direct prefix gating", async () => {
    const ctx = context();
    const preview = await routeWhatsAppText({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, senderJid: ctx.senderJid as string, chatJid: ctx.chatJid as string, text: ".approveall", fromMe: true });
    expect(preview).toBeTypeOf("object");
    const confirm = (preview as WhatsAppCommandReply).nativeFlow?.find((button) => button.id?.includes(":confirm:"));
    expect(confirm?.id).toBeTruthy();
    expect(ctx.enqueueGroupControlJob).not.toHaveBeenCalled();
    const result = await routeWhatsAppText({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, senderJid: ctx.senderJid as string, chatJid: ctx.chatJid as string, text: "", interactionId: confirm!.id!, fromMe: true });
    expect(result).toContain("Action        · APPROVE");
    expect(result).toContain("JOIN APPROVAL");
    expect(await routeWhatsAppText({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, senderJid: ctx.senderJid as string, chatJid: ctx.chatJid as string, text: "approveall", fromMe: true })).toBeNull();
  });

  it("requires a WhatsApp group chat for approval commands", async () => {
    await expect(executeCommand(createCommandRegistry(), "pendingjoin", context({ chatJid: "120363000000000000@s.whatsapp.net" }))).rejects.toThrow(/inside a WhatsApp group/);
  });
});
