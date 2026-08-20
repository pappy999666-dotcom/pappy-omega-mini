import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import makeWASocket, { makeCacheManagerAuthState } from "@crysnovax/baileys";
import pino from "pino";

const CONTROL_URL = String(process.env.PAPPY_WORKLOAD_URL ?? "").replace(/\/$/, "");
const ENROLLMENT_TOKEN = process.env.PAPPY_WORKLOAD_ENROLLMENT_TOKEN ?? "";
const DATA_DIR = process.env.PAPPY_WORKER_DATA_DIR ?? "./pappy-workload-data";
const STORAGE_SECRET = process.env.PAPPY_WORKLOAD_SESSION_SECRET ?? "";
const WORKER_VERSION = process.env.PAPPY_WORKER_VERSION ?? "1.0.0";
const CONTROL_POLL_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const workerStatePath = join(DATA_DIR, "worker.json");
const runtimes = new Map();
const assignedSessions = new Set();
let credentialState;
let stopping = false;

function key() {
  return createHash("sha256").update(STORAGE_SECRET, "utf8").digest();
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
function decrypt(value) {
  const payload = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"));
}
async function saveState(value) {
  await mkdir(dirname(workerStatePath), { recursive: true });
  const temp = `${workerStatePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, encrypt(value), { mode: 0o600 });
  await rename(temp, workerStatePath);
}
async function loadState() {
  try {
    return decrypt(await readFile(workerStatePath, "utf8"));
  } catch {
    return undefined;
  }
}

function encode(value) {
  if (Buffer.isBuffer(value)) return { __pappyBuffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const object = value;
    if (typeof object.__pappyBuffer === "string") return Buffer.from(object.__pappyBuffer, "base64");
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
function assertConfig() {
  if (!CONTROL_URL.startsWith("https://")) throw new Error("PAPPY_WORKLOAD_URL must use HTTPS.");
  if (!STORAGE_SECRET || STORAGE_SECRET.length < 32) throw new Error("PAPPY_WORKLOAD_SESSION_SECRET must be at least 32 characters.");
}
async function control(path, payload, credential) {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(35_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `Control request failed (${response.status}).`);
  return data;
}

class FileAuthStore {
  constructor(root) { this.root = root; this.pending = new Map(); }
  path(name) { return join(this.root, `${encodeURIComponent(name)}.json`); }
  async get(name) { try { return decrypt(await readFile(this.path(name), "utf8")); } catch { return undefined; } }
  async set(name, value) {
    const previous = this.pending.get(name) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true });
      const path = this.path(name);
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temp, encrypt(value), { mode: 0o600 });
      await rename(temp, path);
    });
    this.pending.set(name, write);
    try { await write; return value; } finally { if (this.pending.get(name) === write) this.pending.delete(name); }
  }
  async flush() { await Promise.allSettled(this.pending.values()); }
  async delete(name) { await unlink(this.path(name)).catch(() => undefined); return true; }
  async keys() { return []; }
}

async function startSession(workspaceId, sessionId) {
  const existing = runtimes.get(sessionId);
  if (existing) return existing;
  const authRoot = join(DATA_DIR, "sessions", workspaceId, sessionId);
  const store = new FileAuthStore(authRoot);
  const { state, saveCreds } = await makeCacheManagerAuthState(store, sessionId);
  const socket = makeWASocket({ auth: state, logger: pino({ level: "warn" }), generateHighQualityLinkPreview: true });
  socket.ev.on("creds.update", saveCreds);
  const runtime = { workspaceId, sessionId, socket, store, ready: false };
  runtimes.set(sessionId, runtime);
  socket.ev.on("connection.update", (update) => {
    if (update.connection === "open") runtime.ready = true;
    if (update.connection === "close") { runtime.ready = false; runtimes.delete(sessionId); }
  });
  const deadline = Date.now() + 90_000;
  while (!runtime.ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!runtime.ready) throw new Error(`WhatsApp session ${sessionId} did not become ready.`);
  assignedSessions.add(sessionId);
  return runtime;
}
async function stopSession(sessionId) {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  await runtime.store.flush().catch(() => undefined);
  runtime.socket.end?.(new Error("Workload command requested session stop."));
  runtimes.delete(sessionId);
  assignedSessions.delete(sessionId);
}
function ownJid(runtime) { return runtime.socket.user?.id ?? "me"; }
function normalizeArgs(runtime, method, args) {
  const next = decode(args);
  if (method === "profilePictureUrl" && next[0] === "me") next[0] = ownJid(runtime);
  if (method === "groupCreate" && Array.isArray(next[1])) next[1] = next[1].map((item) => item === "me" ? ownJid(runtime) : item);
  return next;
}
async function executeTransport(runtime, method, encodedArgs) {
  const allowed = new Set([
    "sendMessage", "sendGroupStatus", "updateProfileName", "updateProfileStatus", "updateProfilePicture", "removeProfilePicture", "profilePictureUrl",
    "groupCreate", "groupFetchAllParticipating", "groupInviteCode", "groupUpdateDescription", "groupUpdateSubject", "groupLeave", "groupMetadata",
    "groupGetInviteInfo", "groupAcceptInvite", "requestPairingCode",
  ]);
  if (!allowed.has(method)) throw new Error(`Unsupported workload transport method: ${method}`);
  const fn = runtime.socket[method];
  if (typeof fn !== "function") throw new Error(`Transport method is unavailable: ${method}`);
  return fn.apply(runtime.socket, normalizeArgs(runtime, method, encodedArgs));
}
async function execute(command) {
  if (command.kind === "session.start") {
    const runtime = await startSession(command.workspaceId, command.sessionId);
    return { status: "ACTIVE", userId: runtime.socket.user?.id ?? null };
  }
  if (command.kind === "session.stop") {
    await stopSession(command.sessionId);
    return { status: "OFFLINE" };
  }
  if (command.kind === "session.pair.request") {
    const runtime = await startSession(command.workspaceId, command.sessionId);
    const phoneNumber = String(command.payload.phoneNumber ?? "").replace(/\D/g, "");
    const customCode = String(command.payload.customCode ?? "PAPPYBOT").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (typeof runtime.socket.requestPairingCode !== "function") throw new Error("Pairing codes are not supported by this transport.");
    return { code: await runtime.socket.requestPairingCode(phoneNumber, customCode) };
  }
  if (command.kind === "bridge.command") {
    const runtime = await startSession(command.workspaceId, command.sessionId);
    return await executeTransport(runtime, String(command.payload.method ?? ""), command.payload.args ?? []);
  }
  throw new Error(`Unsupported workload command: ${command.kind}`);
}
async function register() {
  const existing = await loadState();
  if (existing?.credential && existing.workerId) { credentialState = existing; return; }
  if (!ENROLLMENT_TOKEN) throw new Error("PAPPY_WORKLOAD_ENROLLMENT_TOKEN is required on first start.");
  const registration = await control("/workload/register", {
    enrollmentToken: ENROLLMENT_TOKEN,
    workerVersion: WORKER_VERSION,
    capabilities: ["baileys", "group-transport", "media", "pairing"],
  });
  credentialState = { workerId: registration.workerId, displayKey: registration.displayKey, credential: registration.credential };
  await saveState(credentialState);
  console.log(`[pappy-workload-worker] registered worker=${registration.workerId} key=${registration.displayKey} version=${WORKER_VERSION}`);
}
async function heartbeat() {
  return control("/workload/heartbeat", {
    workerVersion: WORKER_VERSION,
    capabilities: ["baileys", "group-transport", "media", "pairing"],
    status: "ACTIVE",
    assignedSessionIds: [...assignedSessions],
  }, credentialState.credential);
}
async function poll() {
  const data = await control("/workload/poll", { limit: 5 }, credentialState.credential);
  for (const command of data.commands ?? []) {
    try {
      const result = await execute(command);
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: true, result: encode(result) }, credentialState.credential);
    } catch (error) {
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, credentialState.credential).catch(() => undefined);
    }
  }
}
async function run() {
  assertConfig();
  await mkdir(DATA_DIR, { recursive: true });
  await register();
  let nextHeartbeat = 0;
  while (!stopping) {
    try {
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + HEARTBEAT_MS; }
      await poll();
    } catch (error) {
      console.error("[pappy-workload-worker] control loop error", error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, CONTROL_POLL_MS * 3)));
    }
    await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
  }
}
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
run().catch((error) => { console.error("[pappy-workload-worker] fatal", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
