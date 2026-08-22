import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WorkloadBroadcastIntent } from "../src/workload/types.js";

const workerSourcePath = new URL("../tools/worker-runtime-source.mjs", import.meta.url);
const messageRouterPath = new URL("../src/whatsapp/message-router.ts", import.meta.url);
const remoteBridgePath = new URL("../src/whatsapp/remote-bridge.ts", import.meta.url);
const workloadTransportPath = new URL("../src/whatsapp/workload-transport.ts", import.meta.url);


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

  it("defines durable worker-local checkpointing and aggregated progress", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    expect(source).toContain('join(DATA_DIR, "broadcasts")');
    expect(source).toContain("writeBroadcastCheckpoint");
    expect(source).toContain("nextDelivery");
    expect(source).toContain('control("/workload/progress"');
    expect(source).toContain("groupFetchAllParticipating");
    expect(source).toContain("broadcast.start");
    expect(source).toContain("broadcast.cancel");
    expect(source).toContain('method === "groupGetInviteInfo"');
    expect(source).toContain("const backgroundCommandChains = new Map();");
    expect(source).toContain("const broadcastCommandChains = new Map();");
    expect(source).toContain("if (command?.kind === \"broadcast.start\" || command?.kind === \"broadcast.cancel\") return broadcastCommandChains;");
    expect(source).toContain("const chains = commandChainFor(command);");
    expect(source).toContain("for (const command of commands) void processCommand(command);");
    expect(source).toContain("intent.styled === true");
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
  });
});
