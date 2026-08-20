import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { env } from "../config/env.js";
import {
  authenticateWorkloadWorker,
  completeWorkloadCommand,
  disconnectWorkloadWorker,
  markUnreachableWorkloadWorkers,
  pollWorkloadCommands,
  recordWorkloadHeartbeat,
  registerWorkloadWorker,
  workloadControlSummary,
} from "./service.js";
import { WORKLOAD_CONTROL_VERSION } from "./security.js";
import type { WorkloadRegistrationRequest } from "./types.js";

const MAX_BODY_BYTES = 512 * 1024;

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

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function stringListField(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${key} must be an array of strings.`);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 50);
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
      const registration = await registerWorkloadWorker({
        enrollmentToken: stringField(input, "enrollmentToken"),
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
    if (path === "/workload/heartbeat") {
      const input = await body(request);
      const worker = await recordWorkloadHeartbeat(credential, {
        workerVersion: stringField(input, "workerVersion"),
        capabilities: stringListField(input, "capabilities"),
        status: stringField(input, "status") as never,
        assignedSessionIds: stringListField(input, "assignedSessionIds"),
        ...(typeof input.lastError === "string" && input.lastError.trim() ? { lastError: input.lastError.trim() } : {}),
      });
      json(response, 200, { ok: true, workerId: worker.workerId, status: worker.status, assignedSessionIds: worker.assignedSessionIds });
      return;
    }
    if (path === "/workload/poll") {
      const input: Record<string, unknown> = await body(request).catch(() => ({} as Record<string, unknown>));
      const commands = await pollWorkloadCommands(credential, typeof input.limit === "number" ? input.limit : 10);
      json(response, 200, { ok: true, controlVersion: WORKLOAD_CONTROL_VERSION, commands });
      return;
    }
    if (path === "/workload/result") {
      const input = await body(request);
      const command = await completeWorkloadCommand(credential, {
        commandId: stringField(input, "commandId"),
        requestId: stringField(input, "requestId"),
        ok: input.ok === true,
        ...(input.result && typeof input.result === "object" && !Array.isArray(input.result) ? { result: input.result as Record<string, unknown> } : {}),
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
