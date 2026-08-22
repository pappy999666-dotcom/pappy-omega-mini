import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, sign } from "node:crypto";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import {
  authenticateWorkloadWorker,
  getAuthorizedWorkloadAssignment,
  completeWorkloadCommand,
  disconnectWorkloadWorker,
  markUnreachableWorkloadWorkers,
  pollWorkloadCommands,
  recordWorkloadHeartbeat,
  recordWorkloadSessionStatus,
  registerWorkloadWorker,
  workloadControlSummary,
} from "./service.js";
import { handleWorkloadInboundEvent } from "./events.js";
import { WORKLOAD_CONTROL_VERSION } from "./security.js";
import type { WorkloadInboundEvent, WorkloadRegistrationRequest } from "./types.js";
import { getBroadcastProgress, isBroadcastCancellationRequested, saveBroadcastProgress } from "./broadcast-progress.js";
import { readJobMedia } from "../whatsapp/job-media-store.js";
import { getWhatsAppSocket } from "../whatsapp/session-manager.js";
import { prepareCanonicalPreviewContent } from "../whatsapp/baileys-native-preview.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_INBOUND_MEDIA_BYTES = 5 * 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function encode(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __pappyBuffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function enumField<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = stringField(input, key) as T;
  if (!allowed.includes(value)) throw new Error(`${key} has an unsupported value.`);
  return value;
}

function stringListField(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${key} must be an array of strings.`);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function inboundMediaField(input: Record<string, unknown>): WorkloadInboundEvent["media"] {
  const value = input.media;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("media must be an object.");
  const media = value as Record<string, unknown>;
  const kind = media.kind;
  const bytes = media.bytes;
  if (!(["image", "video", "audio", "document", "sticker"] as const).includes(kind as never))
    throw new Error("media.kind is unsupported.");
  if (typeof bytes !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes))
    throw new Error("media.bytes must be base64.");
  const byteLength = Buffer.byteLength(bytes, "base64");
  if (!byteLength || byteLength > MAX_INBOUND_MEDIA_BYTES)
    throw new Error("media.bytes exceeds the inbound media limit.");
  return {
    kind: kind as NonNullable<WorkloadInboundEvent["media"]>["kind"],
    bytes,
    ...(typeof media.mimeType === "string" && media.mimeType.trim() ? { mimeType: media.mimeType.trim().slice(0, 160) } : {}),
    ...(typeof media.fileName === "string" && media.fileName.trim() ? { fileName: media.fileName.trim().slice(0, 240) } : {}),
    ...(typeof media.caption === "string" ? { caption: media.caption.slice(0, 4096) } : {}),
    ...(typeof media.ptt === "boolean" ? { ptt: media.ptt } : {}),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (method === "GET" && path === "/workload/health") {
      json(response, 200, { ok: true, ...workloadControlSummary() });
      return;
    }
    if (method !== "POST") {
      json(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    if (path === "/workload/register") {
      const input = await body(request);
      const pairingCode = typeof input.pairingCode === "string" && input.pairingCode.trim() ? input.pairingCode.trim() : undefined;
      const enrollmentToken = typeof input.enrollmentToken === "string" && input.enrollmentToken.trim() ? input.enrollmentToken.trim() : undefined;
      const registration = await registerWorkloadWorker({
        ...(pairingCode ? { pairingCode } : {}),
        ...(enrollmentToken ? { enrollmentToken } : {}),
        ...(typeof input.workerName === "string" && input.workerName.trim() ? { workerName: input.workerName.trim() } : {}),
        workerVersion: stringField(input, "workerVersion"),
        capabilities: stringListField(input, "capabilities"),
      } satisfies WorkloadRegistrationRequest);
      json(response, 201, { ok: true, ...registration });
      return;
    }
    const credential = bearer(request);
    if (!credential) {
      json(response, 401, { ok: false, error: "Bearer workload credential required." });
      return;
    }
    if (path === "/workload/release") {
      await authenticateWorkloadWorker(credential, { allowDisabled: true });
      const input = await body(request).catch(() => ({} as Record<string, unknown>));
      const currentVersion = typeof input.workerVersion === "string" ? input.workerVersion.trim() : "";
      const updateAvailable = currentVersion !== env.WORKLOAD_RELEASE_VERSION;
      if (!updateAvailable) {
        json(response, 200, { ok: true, version: env.WORKLOAD_RELEASE_VERSION, updateAvailable: false });
        return;
      }
      const bundle = await readFile(resolve(env.WORKLOAD_RELEASE_PATH));
      const privateKey = await readFile(resolve(env.WORKLOAD_RELEASE_PRIVATE_KEY_PATH), "utf8");
      const sha256 = createHash("sha256").update(bundle).digest("hex");
      const signature = sign(null, bundle, privateKey).toString("base64");
      json(response, 200, {
        ok: true,
        version: env.WORKLOAD_RELEASE_VERSION,
        updateAvailable: true,
        sha256,
        signature,
        bundle: bundle.toString("base64"),
      });
      return;
    }
    if (path === "/workload/heartbeat") {
      const input = await body(request);
      const worker = await recordWorkloadHeartbeat(credential, {
        workerVersion: stringField(input, "workerVersion"),
        capabilities: stringListField(input, "capabilities"),
        status: enumField(input, "status", ["PENDING", "CONNECTING", "ACTIVE", "UNREACHABLE", "OFFLINE", "ERROR", "DISABLED", "INCOMPATIBLE", "REVOKED"] as const),
        assignedSessionIds: stringListField(input, "assignedSessionIds"),
        ...(typeof input.lastError === "string" && input.lastError.trim() ? { lastError: input.lastError.trim() } : {}),
      });
      json(response, 200, { ok: true, workerId: worker.workerId, workspaceId: worker.workspaceId, status: worker.status, assignedSessionIds: worker.assignedSessionIds });
      return;
    }
    if (path === "/workload/progress") {
      const input = await body(request);
      const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
      const workspaceId = stringField(input, "workspaceId");
      const sessionId = stringField(input, "sessionId");
      const assignment = await getAuthorizedWorkloadAssignment(worker.workerId, sessionId);
      if (assignment.workspaceId !== workspaceId) throw new Error("Progress workspace mismatch.");
      const state = enumField(input, "state", ["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"] as const);
      const numeric = (name: string): number => {
        const value = input[name];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
        return Math.floor(value);
      };
      await saveBroadcastProgress({
        workspaceId,
        sessionId,
        jobId: stringField(input, "jobId"),
        state,
        totalGroups: numeric("totalGroups"),
        completed: numeric("completed"),
        failed: numeric("failed"),
        skipped: numeric("skipped"),
        ...(typeof input.currentGroup === "string" ? { currentGroup: input.currentGroup.slice(0, 120) } : {}),
        ...(typeof input.nextActionAt === "number" ? { nextActionAt: input.nextActionAt } : {}),
        ...(typeof input.error === "string" ? { error: input.error.slice(0, 500) } : {}),
        updatedAt: Date.now(),
      });
      json(response, 200, { ok: true });
      return;
    }
    if (path === "/workload/progress/get") {
      const input = await body(request);
      const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
      const workspaceId = stringField(input, "workspaceId");
      if (workspaceId !== worker.workspaceId) throw new Error("Progress workspace mismatch.");
      const jobId = stringField(input, "jobId");
      const progress = await getBroadcastProgress(workspaceId, jobId);
      const cancelRequested = await isBroadcastCancellationRequested(workspaceId, jobId);
      json(response, 200, { ok: true, cancelRequested, ...(progress ? { progress } : {}) });
      return;
    }
    if (path === "/workload/media") {
      const input = await body(request);
      const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
      const reference = input.mediaRef;
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("mediaRef is required.");
      const referenceValue = reference as Record<string, unknown>;
      if (referenceValue.workspaceId !== worker.workspaceId) throw new Error("Media workspace mismatch.");
      const media = await readJobMedia(reference as Parameters<typeof readJobMedia>[0]);
      json(response, 200, { ok: true, media: encode({
        kind: referenceValue.kind,
        bytes: media,
        mimeType: referenceValue.mimeType,
        fileName: referenceValue.originalFileName ?? referenceValue.fileName,
        ptt: referenceValue.ptt,
      }) });
      return;
    }
    if (path === "/workload/preview") {
      const input = await body(request);
      const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
      const workspaceId = stringField(input, "workspaceId");
      if (workspaceId !== worker.workspaceId) throw new Error("Preview workspace mismatch.");
      const sessionId = stringField(input, "sessionId");
      await getAuthorizedWorkloadAssignment(worker.workerId, sessionId);
      const text = stringField(input, "text").slice(0, 12_000);
      const prepared = await prepareCanonicalPreviewContent({
        text,
        content: { text },
        target: "group-status",
        socket: getWhatsAppSocket(workspaceId, sessionId),
        cacheScope: `${workspaceId}:${sessionId}`,
      });
      const preview = prepared.linkPreview && typeof prepared.linkPreview === "object"
        ? prepared.linkPreview
        : undefined;
      json(response, 200, { ok: true, ...(preview ? { preview: encode(preview) } : {}) });
      return;
    }
    if (path === "/workload/session-status") {
      const input = await body(request);
      const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
      await recordWorkloadSessionStatus(worker.workerId, {
        workspaceId: stringField(input, "workspaceId"),
        sessionId: stringField(input, "sessionId"),
        status: enumField(input, "status", ["PAIRING", "ACTIVE", "RECONNECTING", "DEGRADED", "ERROR", "LOGGED_OUT"] as const),
        ...(input.authHealth !== undefined ? { authHealth: enumField(input, "authHealth", ["UNKNOWN", "VALID", "INVALID", "DEGRADED"] as const) } : {}),
        ...(typeof input.phoneNumber === "string" ? { phoneNumber: input.phoneNumber } : {}),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      });
      json(response, 200, { ok: true, sessionId: stringField(input, "sessionId") });
      return;
    }
    if (path === "/workload/event") {
      const input = await body(request);
      const inboundMedia = input.media !== undefined ? inboundMediaField(input) : undefined;
      const event = {
        workspaceId: stringField(input, "workspaceId"),
        sessionId: stringField(input, "sessionId"),
        remoteJid: stringField(input, "remoteJid"),
        senderJid: stringField(input, "senderJid"),
        text: typeof input.text === "string" ? input.text : "",
        ...(typeof input.messageId === "string" ? { messageId: input.messageId } : {}),
        ...(typeof input.quotedText === "string" ? { quotedText: input.quotedText } : {}),
        ...(typeof input.quotedSenderJid === "string" ? { quotedSenderJid: input.quotedSenderJid } : {}),
        ...(Array.isArray(input.mentionedJids) ? { mentionedJids: input.mentionedJids.filter((item): item is string => typeof item === "string").slice(0, 100) } : {}),
        ...(inboundMedia ? { media: inboundMedia } : {}),
        ...(input.fromMe === true ? { fromMe: true } : {}),
      } satisfies WorkloadInboundEvent;
      const { worker } = await authenticateWorkloadWorker(credential);
      if (worker.status === "DISABLED") throw new Error("Panel traffic is paused by the administrator.");
      const assignment = await getAuthorizedWorkloadAssignment(worker.workerId, event.sessionId);
      if (assignment.workspaceId !== event.workspaceId) throw new Error("Inbound event workspace mismatch.");
      const result = await handleWorkloadInboundEvent(event);
      json(response, 200, { ok: true, result: encode(result) });
      return;
    }
    if (path === "/workload/poll") {
      const input: Record<string, unknown> = await body(request).catch(() => ({} as Record<string, unknown>));
      const commands = await pollWorkloadCommands(
        credential,
        typeof input.limit === "number" ? Math.max(1, Math.min(20, input.limit)) : 10,
        typeof input.waitMs === "number" ? Math.max(0, Math.min(25_000, input.waitMs)) : 20_000,
      );
      json(response, 200, { ok: true, controlVersion: WORKLOAD_CONTROL_VERSION, commands });
      return;
    }
    if (path === "/workload/result") {
      const input = await body(request);
      const command = await completeWorkloadCommand(credential, {
        commandId: stringField(input, "commandId"),
        requestId: stringField(input, "requestId"),
        ok: input.ok === true,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(typeof input.error === "string" ? { error: input.error.slice(0, 500) } : {}),
      });
      json(response, 200, { ok: true, commandId: command.commandId, status: command.status });
      return;
    }
    if (path === "/workload/disconnect") {
      const { worker } = await authenticateWorkloadWorker(credential);
      const disconnected = await disconnectWorkloadWorker(worker.workerId);
      json(response, 200, { ok: true, workerId: disconnected.workerId, status: disconnected.status });
      return;
    }
    if (path === "/workload/health") {
      const { worker } = await authenticateWorkloadWorker(credential);
      json(response, 200, { ok: true, workerId: worker.workerId, status: worker.status, ...workloadControlSummary() });
      return;
    }
    json(response, 404, { ok: false, error: "Workload route not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|invalid|expired|authentication|authorized|incompatible|disabled|revoked|not found/i.test(message) ? 400 : 500;
    json(response, status, { ok: false, error: message });
  }
}

let server: Server | undefined;
let healthTimer: NodeJS.Timeout | undefined;

export async function startWorkloadControlServer(): Promise<void> {
  if (!env.WORKLOAD_CONTROL_ENABLED || server) return;
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(env.WORKLOAD_CONTROL_PORT, env.WORKLOAD_CONTROL_BIND, () => resolve());
  });
  healthTimer = setInterval(() => {
    void markUnreachableWorkloadWorkers(env.WORKLOAD_HEARTBEAT_TIMEOUT_MS).catch((error) =>
      console.error("[pappy-omega-mini] workload health sweep failed", error instanceof Error ? error.message : String(error)),
    );
  }, Math.max(15_000, Math.floor(env.WORKLOAD_HEARTBEAT_TIMEOUT_MS / 2)));
  healthTimer.unref?.();
  console.log(`[pappy-omega-mini] workload control listening on ${env.WORKLOAD_CONTROL_BIND}:${env.WORKLOAD_CONTROL_PORT}`);
}

export async function stopWorkloadControlServer(): Promise<void> {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = undefined;
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
