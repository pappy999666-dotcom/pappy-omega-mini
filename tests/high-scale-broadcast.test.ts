import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WorkloadBroadcastIntent } from "../src/workload/types.js";

const workerSourcePath = new URL("../tools/worker-runtime-source.mjs", import.meta.url);
const runtimePath = new URL("../src/jobs/runtime.ts", import.meta.url);
const messageRouterPath = new URL("../src/whatsapp/message-router.ts", import.meta.url);
const remoteBridgePath = new URL("../src/whatsapp/remote-bridge.ts", import.meta.url);
const workloadTransportPath = new URL("../src/whatsapp/workload-transport.ts", import.meta.url);
const telegramBotPath = new URL("../src/telegram/bot.ts", import.meta.url);
const workloadServicePath = new URL("../src/workload/service.ts", import.meta.url);
const workloadControlServerPath = new URL("../src/workload/control-server.ts", import.meta.url);
const orchestratorPath = new URL("../src/jobs/job-orchestrator.ts", import.meta.url);
const indexPath = new URL("../src/index.ts", import.meta.url);


function makeIntent(): WorkloadBroadcastIntent {
  return {
    jobId: "job-compact-001",
    kind: "allstatus",
    text: "high-scale smoke test",
    delayMs: 1000,
    repeat: 1,
  };
}

describe("high-scale worker-local broadcast contract", () => {
  it.each([10, 100, 1000, 2000, 5000, 10000])(
    "keeps the control intent compact for %i groups",
    (groupCount) => {
      const groups = Array.from({ length: groupCount }, (_, index) => `group-${index}@g.us`);
      const intent = makeIntent();
      const encoded = JSON.stringify(intent);
      expect(groups).toHaveLength(groupCount);
      expect(encoded).not.toContain("@g.us");
      expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
    },
  );

  it("keeps designed all-status intent explicit and preserves both aliases", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    const registry = await readFile(new URL("../src/whatsapp/command-registry.ts", import.meta.url), "utf8");
    const styled: WorkloadBroadcastIntent = { ...makeIntent(), styled: true };
    expect(styled.styled).toBe(true);
    expect(registry).toContain('name: "dallstatus"');
    expect(registry).toContain('aliases: ["allstatusd"]');
    expect(registry).toContain('styled: true');
    expect(source).toContain("intent.styled === true");
  });

  it("defines durable worker-local checkpointing and aggregated progress", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    expect(source).toContain('join(DATA_DIR, "broadcasts")');
    expect(source).toContain("writeBroadcastCheckpoint");
    expect(source).toContain("nextDelivery");
    expect(source).toContain('control("/workload/progress"');
    expect(source).toContain("groupFetchAllParticipating");
    expect(source).toContain("fetchParticipatingGroups(runtime, 15_000)");
    expect(source).toContain("fetchParticipatingGroups(runtime, 20_000)");
    expect(source).toContain("participantCountFromMetadata");
    expect(source).toContain("participants instanceof Map");
    expect(source).toContain("participantsCount");
    expect(source).toContain("groupSummaryLastKnown");
    expect(source).toContain("broadcastGroupInflight");
    expect(source).toContain("broadcast.start");
    expect(source).toContain("broadcast.cancel");
    expect(source).toContain('method === "groupGetInviteInfo"');
    expect(source).toContain('method === "groupMetadata" || method === "listGroupSummaries"');
    expect(source).toContain("const backgroundCommandChains = new Map();");
    expect(source).toContain("const broadcastCommandChains = new Map();");
    expect(source).toContain("if (command?.kind === \"broadcast.start\" || command?.kind === \"broadcast.cancel\") return broadcastCommandChains;");
    expect(source).toContain("function broadcastSocketClosed(message)");
    expect(source).toContain("async function waitForBroadcastRuntime(runtime)");
    expect(source).toContain("let activeRuntime = runtime;");
    expect(source).toContain("activeRuntime = await waitForBroadcastRuntime(activeRuntime);");
    expect(source).toContain('checkpoint.state = "WAITING_FOR_SESSION"');
    expect(source).toContain("currentAction: String(checkpoint.currentAction)");
    expect(source).toContain("lastResult: String(checkpoint.lastResult)");
    expect(source).toContain('checkpoint.currentAction = "posting to group"');
    expect(source).toContain("waiting ${Math.ceil(waitMs / 1000)}s before next post");
    expect(source).toContain("const chains = commandChainFor(command);");
    expect(source).toContain("for (const command of commands) void processCommand(command);");
    expect(source).toContain("intent.styled === true");
    const runtime = await readFile(runtimePath, "utf8");
    const orchestrator = await readFile(orchestratorPath, "utf8");
    const control = await readFile(workloadControlServerPath, "utf8");
    expect(orchestrator).toContain("reconcileWorkerLocalBroadcast(record)");
    expect(orchestrator).toContain("progress.currentAction ??");
    expect(control).toContain("WAITING_FOR_SESSION");
    expect(control).toContain("currentAction");
    expect(control).toContain("lastResult");
    expect(runtime).toContain("sendGroupColorStatus(context.job.workspaceId, sessionId, jid");
    expect(runtime).toContain('kind === "allstatus" && payload.styled === true');
    expect(source).toContain("/https?:\\/\\/\\S+/i.test(detectorText)");
    expect(source).toContain("createWorkerStatusDesign");
    expect(source).toContain("statusDesignUrlTemplates");
    expect(source).toContain("previewTitle");
    expect(source).toContain("styleOptions = { backgroundColor: design.backgroundColor, font: design.font }");
    expect(source).toContain("const withPreview = linkPreview && typeof linkPreview === \"object\"");
    expect(source).toContain("return {};");
    expect(source).toContain("isScopedInviteValidationFailure");
    expect(source).toContain("invite validation deferred");
    expect(source).toContain("growth[- ]locked");
    expect(source).toContain('method === "previewUpload"');
    expect(source).toContain('control("/workload/preview"');
    expect(source).toContain("const withPreview = linkPreview");
    expect(source).toContain("await runtime.socket.sendMessage(jid, { ...withPreview, mentions: participants });");
    expect(source).toContain("Preview thumbnail upload exceeds the 8 MiB safety limit.");
    expect(source).toContain("value.groupStatusMessage");
    expect(source).toContain("value.groupStatus === true");
    expect(source).toContain("sendInteractiveTable(jid, table, sendOptions)");
    expect(source).toContain("associatedChildMessage");
    expect(source).toContain("mentionedJids: context.mentionedJid.slice(0, 100)");
    expect(source).toContain("const quotedMessageKey = typeof context?.stanzaId === \"string\"");
    expect(source).toContain("await workerParticipantJid({ id: context.participant }, runtime)");
    expect(source).toContain("quotedMessageKey ? { quotedMessageKey }");
    expect(source).toContain("runtime.socket.richMenu(jid, value.richMenu)");
    expect(source).toContain("process.argv[1] ? resolve(process.argv[1]) : \"\"");
    expect(source).toContain("const AUTO_UPDATE_ENABLED");
    const service = await readFile(workloadServicePath, "utf8");
    expect(service).toContain("if (previousStatus !== \"ACTIVE\") {");
    expect(service).toContain("notifyWorkloadOwner(next, state);");
    expect(source).toContain("const { richMenu: _richMenu, ...safeContent } = value");
  });

  it("forwards real mention metadata with panel-native button responses", async () => {
    const source = await readFile(indexPath, "utf8");
    expect(source).toContain("result.mentions?.length");
    expect(source).toContain("mentions: result.mentions");
    expect(source).toContain("result.nativeTable");
    const router = await readFile(messageRouterPath, "utf8");
    expect(router).toContain("sendCurrentText");
    const inboundIndex = await readFile(indexPath, "utf8");
    expect(inboundIndex).toContain("quotedMessageKey: event.quotedMessageKey");
  });

  it("persists and reloads encrypted inventory snapshots for instant panel totals", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    expect(source).toContain('const broadcastInventoryPath = join(DATA_DIR, "broadcast-inventory.json")');
    expect(source).toContain("loadBroadcastInventorySnapshots");
    expect(source).toContain("saveBroadcastInventorySnapshot");
    expect(source).toContain("usableBroadcastInventorySnapshot");
    expect(source).toContain("let broadcastInventoryWrite =");
    expect(source).toContain("const cachedGroups = previous");
    expect(source).toContain("totalGroups: cachedGroups?.length ?? 0");
    expect(source).toContain("await loadBroadcastInventorySnapshots();");
  });

  it("keeps cold-start acceptance independent from inventory fetch", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    const startBlock = source.slice(source.indexOf("async function startLocalBroadcast"), source.indexOf("async function resumeBroadcastsForSession"));
    expect(startBlock).toContain("const ready = Promise.resolve");
    expect(startBlock).toContain("const done = (async () => {");
    expect(startBlock.indexOf("const ready = Promise.resolve")).toBeLessThan(startBlock.indexOf("const done = (async () => {"));
    expect(startBlock).toContain("resolvedGroups = cachedGroups ?? await localBroadcastGroups(runtime)");
    expect(startBlock).not.toContain("await fetchParticipatingGroups(runtime");
  });

  it("renders the generated Add Workload pairing code visibly and as the code button", async () => {
    const bot = await readFile(telegramBotPath, "utf8");
    expect(bot).toContain('<b>Pairing code:</b> <code>${escapeHtml(pairingCode)}</code>');
    expect(bot).toContain('[copyBtn(`📋 ${pairingCode}`, pairingCode, "success")]');
    expect(bot).not.toContain('Copy Pairing Code", pairingCode');
  });

  it("keeps Share Panel access scoped to child workspaces and assignments", async () => {
    const service = await readFile(workloadServicePath, "utf8");
    const control = await readFile(workloadControlServerPath, "utf8");
    const bot = await readFile(telegramBotPath, "utf8");
    expect(service).toContain("createWorkloadShareCode");
    expect(service).toContain("redeemWorkloadShareCode");
    expect(service).toContain("isWorkloadWorkerAuthorizedForWorkspace");
    expect(service).toContain("revokeSharedWorkloadAccess");
    expect(control).toContain("isWorkloadWorkerAuthorizedForWorkspace");
    expect(control).toContain("assignment.workspaceId !== workspaceId");
    expect(control).toContain("quotedMessageKey: input.quotedMessageKey");
    expect(bot).toContain('bot.action("workload:share:add"');
    expect(bot).toContain('bot.action(/^workload:share:([^:]+)$/');
    expect(bot).toContain('bot.action(/^workload:share:remove:(.+)$/');
    expect(bot).toContain('bot.action(/^workload:share:users:(.+)$/');
    expect(bot).toContain('bot.action(/^workload:share:(block|unblock):([^:]+)$/');
    expect(service).toContain("listOwnerWorkloadShareRecipients");
    expect(service).toContain("setOwnerSharedUserAccessByShare");
    expect(service).toContain('share.status === "ACTIVE"');
    expect(service).toContain('"BLOCKED"');
    expect(service).toContain('status: "OFFLINE"');
    expect(bot).toContain("listAccessibleWorkspaceWorkloadWorkers(user.workspaceId)");
  });

  it("exposes allstatusd as a designed Auto Promote command", async () => {
    const autopromoteTypes = await readFile(new URL("../src/autopromote/types.ts", import.meta.url), "utf8");
    const autopromoteService = await readFile(new URL("../src/autopromote/service.ts", import.meta.url), "utf8");
    const ui = await readFile(new URL("../src/telegram/ui.ts", import.meta.url), "utf8");
    const bot = await readFile(telegramBotPath, "utf8");
    expect(autopromoteTypes).toContain('"allstatusd"');
    expect(autopromoteService).toContain('config.command === "allstatusd" ? { styled: true }');
    expect(ui).toContain('autopromote:command:allstatusd');
    expect(bot).toContain('allstatus|allstatusd|allchat|allstatusx');
  });

  it("recreates the private runtime module before every bootstrap retry", async () => {
    const builder = await readFile(new URL("../tools/build-single-file-worker.mjs", import.meta.url), "utf8");
    expect(builder).toContain("fs.writeFileSync(runtimePath, runtimeSource, { mode: 0o600 });");
    expect(builder).toContain("for (;;) {\n    // The child exits on a recoverable crash or update hand-off.");
    expect(builder).toContain("const child = spawnSync(process.execPath, [runtimePath");
  });

  it("defers broadcast inventory until after durable enqueue", async () => {
    const router = await readFile(messageRouterPath, "utf8");
    expect(router).toContain("Never block the command acknowledgement on a full group scan.");
    expect(router).toContain("inventoryDeferred");
    expect(router).not.toContain("if (!panelBroadcast && (kind === \"allstatus\" || kind === \"allchat\") && !payload.groups)");
  });

  it("starts Telegram polling without blocking workload-control startup", async () => {
    const index = await readFile(indexPath, "utf8");
    expect(index).toContain("void bot.launch()");
    expect(index).not.toContain("await bot.launch()");
    expect(index.indexOf("await startWorkloadControlServer()")).toBeGreaterThan(index.indexOf("void bot.launch()"));
  });

  it("keeps external panel sessions out of the internal bridge bypass", async () => {
    const router = await readFile(messageRouterPath, "utf8");
    const bridge = await readFile(remoteBridgePath, "utf8");
    const workloadTransport = await readFile(workloadTransportPath, "utf8");
    expect(router).toContain("shouldProxyWhatsAppSession(message.workspaceId, message.sessionId)");
    expect(bridge).toContain("getSession(workspaceId, sessionId).workloadWorkerId");
    expect(bridge).toContain("return !Boolean(getSession(workspaceId, sessionId).workloadWorkerId)");
    expect(workloadTransport).toContain("remotePreviewUpload");
    expect(workloadTransport).toContain('"previewUpload"');
  });

  it("keeps Validator Hub cooldown and permanent-failure rules in the control plane", async () => {
    const runtime = await readFile(new URL("../src/jobs/runtime.ts", import.meta.url), "utf8");
    const mongo = await readFile(new URL("../src/persistence/mongo.ts", import.meta.url), "utf8");
    expect(runtime).toContain("isInviteValidationRateLimited");
    expect(runtime).toContain("validatorRetiredUntil: Date.now() + VALIDATOR_RETIRE_MS");
    expect(runtime).toContain("if (isInviteValidationPermanentFailure(validationMessage)) break;");
    expect(runtime).toContain("healthySessionKeys");
    expect(runtime).toContain("isInviteValidationPermanentFailure(lower)");
    expect(mongo).toContain("validatorRetiredUntil: Number");
    expect(mongo).toContain("validatorRateLimitCount: Number");
  });

  it("does not place group inventory on the broadcast workload intent", () => {
    const intent = makeIntent() as WorkloadBroadcastIntent & { groups?: string[] };
    expect(intent.groups).toBeUndefined();
    expect(Object.keys(intent).sort()).toEqual(["delayMs", "jobId", "kind", "repeat", "text"]);
    expect(JSON.stringify({ ...intent, styled: true })).toContain('"styled":true');
  });
});
