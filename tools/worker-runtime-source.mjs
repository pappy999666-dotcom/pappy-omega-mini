let makeWASocket;
let makeCacheManagerAuthState;
let pino;
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";

const cliArgs = process.argv.slice(2);
function cliValue(...names) {
  for (const name of names) {
    const index = cliArgs.indexOf(name);
    if (index >= 0 && cliArgs[index + 1]) return cliArgs[index + 1];
  }
  return "";
}
const CONTROL_URL = String(process.env.PAPPY_WORKLOAD_URL ?? "https://pappy-omega-mini-v1.duckdns.org").replace(/\/$/, "");
const ENROLLMENT_TOKEN = process.env.PAPPY_WORKLOAD_ENROLLMENT_TOKEN ?? cliValue("--enrollment", "--token");
const DATA_DIR = process.env.PAPPY_WORKER_DATA_DIR ?? "./pappy-workload-data";
let STORAGE_SECRET = process.env.PAPPY_WORKLOAD_SESSION_SECRET ?? "";
let WORKER_NAME = (process.env.PAPPY_WORKLOAD_NAME ?? cliValue("--name")) || "";
const WORKER_VERSION = process.env.PAPPY_WORKER_VERSION ?? "1.0.0";
const secretPath = join(DATA_DIR, ".secret");
const CONTROL_POLL_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const workerStatePath = join(DATA_DIR, "worker.json");
const runtimes = new Map();
const assignedSessions = new Set();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const intentionallyStopped = new Set();
let credentialState;
let stopping = false;
const matrix = { state: "BOOTING", lastHeartbeatAt: 0, lastControlAt: 0, lastAction: "starting", lastError: "none", lastRenderAt: 0 };
function safeText(value, fallback = "none", max = 42) {
  const text = String(value ?? fallback).replace(/[\r\n\t|]+/g, " ").trim();
  return (text || fallback).slice(0, max);
}
function age(timestamp) {
  return timestamp > 0 ? `${Math.max(0, Math.floor((Date.now() - timestamp) / 1000))}s` : "-";
}
function renderMatrix(force = false) {
  if (!force && Date.now() - matrix.lastRenderAt < 8_000) return;
  matrix.lastRenderAt = Date.now();
  const name = safeText(credentialState?.workerName, WORKER_NAME || "unregistered", 42);
  const code = safeText(credentialState?.workloadCode ?? credentialState?.displayKey, "pending", 42);
  const lines = [
    "",
    "+---------------- PAPPY WORKLOAD MATRIX ----------------+",
    `| NAME       | ${name.padEnd(42).slice(0, 42)}|`,
    `| CODE       | ${code.padEnd(42).slice(0, 42)}|`,
    `| STATE      | ${safeText(matrix.state).padEnd(42).slice(0, 42)}|`,
    `| SESSIONS   | ${String(assignedSessions.size).padEnd(42).slice(0, 42)}|`,
    `| HEARTBEAT  | ${age(matrix.lastHeartbeatAt).padEnd(42).slice(0, 42)}|`,
    `| CONTROL    | ${age(matrix.lastControlAt).padEnd(42).slice(0, 42)}|`,
    `| ACTION     | ${safeText(matrix.lastAction).padEnd(42).slice(0, 42)}|`,
    `| ERROR      | ${safeText(matrix.lastError).padEnd(42).slice(0, 42)}|`,
    "+--------------------------------------------------------+",
  ];
  console.log(lines.join("\n"));
}
function noteError(error, action = "control error") {
  matrix.state = "DEGRADED";
  matrix.lastAction = action;
  matrix.lastError = error instanceof Error ? error.message : String(error);
  renderMatrix(true);
}

function key() {
  return createHash("sha256").update(STORAGE_SECRET, "utf8").digest();
}
async function ensureWorkerName() {
  if (WORKER_NAME || !process.stdin.isTTY || !process.stdout.isTTY) {
    WORKER_NAME = WORKER_NAME || "panel";
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    WORKER_NAME = (await prompt.question("Choose a name for this workload (example: pappy): ")).trim() || "panel";
  } finally {
    prompt.close();
  }
}
async function ensureStorageSecret() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!STORAGE_SECRET) {
    try {
      STORAGE_SECRET = (await readFile(secretPath, "utf8")).trim();
    } catch {
      STORAGE_SECRET = randomBytes(32).toString("base64url");
      await writeFile(secretPath, STORAGE_SECRET, { mode: 0o600 });
    }
  }
  if (STORAGE_SECRET.length < 32) throw new Error("The local worker secret must be at least 32 characters.");
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
  if (!CONTROL_URL.startsWith("https://")) throw new Error("The workload control URL must use HTTPS.");
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

function scheduleReconnect(workspaceId, sessionId) {
  if (intentionallyStopped.has(sessionId) || reconnectTimers.has(sessionId)) return;
  const attempt = (reconnectAttempts.get(sessionId) ?? 0) + 1;
  reconnectAttempts.set(sessionId, attempt);
  const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
  matrix.state = "DEGRADED";
  matrix.lastAction = `reconnect scheduled in ${Math.ceil(delay / 1000)}s`;
  matrix.lastError = "WhatsApp requested socket restart; preserving session auth.";
  renderMatrix(true);
  const timer = setTimeout(async () => {
    reconnectTimers.delete(sessionId);
    if (intentionallyStopped.has(sessionId)) return;
    try {
      await startSession(workspaceId, sessionId, true);
      reconnectAttempts.delete(sessionId);
    } catch (error) {
      noteError(error, "reconnect attempt failed");
      scheduleReconnect(workspaceId, sessionId);
    }
  }, delay);
  reconnectTimers.set(sessionId, timer);
}

async function reportSessionStatus(runtime, status, authHealth, reason) {
  await control("/workload/session-status", {
    workspaceId: runtime.workspaceId,
    sessionId: runtime.sessionId,
    status,
    ...(authHealth ? { authHealth } : {}),
    ...(runtime.socket.user?.id ? { phoneNumber: String(runtime.socket.user.id).split(":")[0].replace(/\D/g, "") } : {}),
    ...(reason ? { reason: String(reason).slice(0, 240) } : {}),
  }, credentialState.credential).catch((error) => noteError(error, "session status failed"));
}
async function startSession(workspaceId, sessionId, waitForReady = true) {
  intentionallyStopped.delete(sessionId);
  const existing = runtimes.get(sessionId);
  if (existing) return existing;
  const authRoot = join(DATA_DIR, "sessions", workspaceId, sessionId);
  const store = new FileAuthStore(authRoot);
  const { state, saveCreds } = await makeCacheManagerAuthState(store, sessionId);
  const socket = makeWASocket({ auth: state, logger: pino({ level: "warn" }), generateHighQualityLinkPreview: true });
  socket.ev.on("creds.update", saveCreds);
  let pairingReadyResolve;
  let pairingReadyReject;
  const pairingReady = new Promise((resolve, reject) => {
    pairingReadyResolve = resolve;
    pairingReadyReject = reject;
    setTimeout(() => reject(new Error("WhatsApp did not reach the pairing state.")), 15_000);
  });
  pairingReady.catch(() => undefined);
  const runtime = { workspaceId, sessionId, socket, store, ready: false, pairingReady };
  socket.ev.on("messages.upsert", (event) => {
    for (const message of event.messages ?? []) void emitInbound(runtime, message).catch((error) => noteError(error, "inbound event failed"));
  });
  runtimes.set(sessionId, runtime);
  socket.ev.on("connection.update", (update) => {
    if (update.connection === "connecting" && !state.creds.registered) {
      setTimeout(() => pairingReadyResolve?.(), 1_500);
    }
    if (update.connection === "open") {
      reconnectAttempts.delete(sessionId);
      const timer = reconnectTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      reconnectTimers.delete(sessionId);
      pairingReadyResolve?.();
      runtime.ready = true;
      matrix.state = "ACTIVE";
      matrix.lastAction = `session ${sessionId} connected`;
      matrix.lastError = "none";
      renderMatrix(true);
      void reportSessionStatus(runtime, "ACTIVE", "VALID");
    }
    if (update.connection === "close") {
      pairingReadyReject?.(new Error("WhatsApp connection closed before pairing."));
      runtime.ready = false;
      matrix.state = "DEGRADED";
      matrix.lastAction = `session ${sessionId} closed`;
      const closeReason = update.lastDisconnect?.error?.output?.statusCode
        ? `WhatsApp connection closed (code ${update.lastDisconnect.error.output.statusCode}).`
        : "WhatsApp connection closed.";
      void reportSessionStatus(runtime, "DEGRADED", "DEGRADED", closeReason);
      runtimes.delete(sessionId);
      renderMatrix(true);
      const restartable = Boolean(state.creds.registered || state.creds.me || state.creds.pairingCode);
      if (restartable && !intentionallyStopped.has(sessionId)) scheduleReconnect(workspaceId, sessionId);
    }
  });
  if (!waitForReady) {
    assignedSessions.add(sessionId);
    matrix.lastAction = `session ${sessionId} initialized for pairing`;
    renderMatrix(true);
    return runtime;
  }
  const deadline = Date.now() + 90_000;
  while (!runtime.ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!runtime.ready) throw new Error(`WhatsApp session ${sessionId} did not become ready.`);
  assignedSessions.add(sessionId);
  return runtime;
}
function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const value = message;
  if (typeof value.conversation === "string") return value.conversation;
  if (typeof value.extendedTextMessage?.text === "string") return value.extendedTextMessage.text;
  if (typeof value.imageMessage?.caption === "string") return value.imageMessage.caption;
  if (typeof value.videoMessage?.caption === "string") return value.videoMessage.caption;
  if (typeof value.documentMessage?.caption === "string") return value.documentMessage.caption;
  return "";
}
async function emitInbound(runtime, message) {
  const key = message?.key ?? {};
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== "string" || !message.message) return;
  const text = messageText(message.message);
  const context = message.message.extendedTextMessage?.contextInfo ?? message.message.imageMessage?.contextInfo ?? message.message.videoMessage?.contextInfo;
  const quotedText = messageText(context?.quotedMessage);
  if (!text && !quotedText) return;
  const senderJid = key.fromMe ? (runtime.socket.user?.id ?? remoteJid) : (key.participantAlt ?? key.remoteJidAlt ?? key.participant ?? remoteJid);
  await control("/workload/event", {
    workspaceId: runtime.workspaceId,
    sessionId: runtime.sessionId,
    ...(typeof key.id === "string" ? { messageId: key.id } : {}),
    remoteJid,
    senderJid,
    text,
    ...(quotedText ? { quotedText } : {}),
    ...(typeof context?.participant === "string" ? { quotedSenderJid: context.participant } : {}),
    ...(Array.isArray(context?.mentionedJid) ? { mentionedJids: context.mentionedJid } : {}),
    ...(key.fromMe ? { fromMe: true } : {}),
  }, credentialState.credential);
}

async function stopSession(sessionId) {
  intentionallyStopped.add(sessionId);
  const timer = reconnectTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(sessionId);
  reconnectAttempts.delete(sessionId);
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
    const runtime = await startSession(command.workspaceId, command.sessionId, false);
    await runtime.pairingReady;
    await reportSessionStatus(runtime, "PAIRING", "UNKNOWN");
    const phoneNumber = String(command.payload.phoneNumber ?? "").replace(/\D/g, "");
    const customCode = String(command.payload.customCode ?? "PAPPYBOT").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (typeof runtime.socket.requestPairingCode !== "function") throw new Error("Pairing codes are not supported by this transport.");
    return { code: await runtime.socket.requestPairingCode(phoneNumber, customCode) };
  }
  if (command.kind === "bridge.command") {
    const method = String(command.payload.method ?? "");
    const runtime = await startSession(command.workspaceId, command.sessionId, method !== "requestPairingCode");
    if (method === "requestPairingCode") await runtime.pairingReady;
    return await executeTransport(runtime, method, command.payload.args ?? []);
  }
  throw new Error(`Unsupported workload command: ${command.kind}`);
}
async function register() {
  const existing = await loadState();
  if (existing?.credential && existing.workerId) { credentialState = existing; return; }
  if (!ENROLLMENT_TOKEN) throw new Error("Paste the one-time enrollment command from Telegram for the first start.");
  const registration = await control("/workload/register", {
    enrollmentToken: ENROLLMENT_TOKEN,
    workerName: WORKER_NAME,
    workerVersion: WORKER_VERSION,
    capabilities: ["baileys", "group-transport", "media", "pairing"],
  });
  credentialState = { workerId: registration.workerId, workerName: registration.workerName, workloadCode: registration.workloadCode, displayKey: registration.displayKey, credential: registration.credential };
  await saveState(credentialState);
  matrix.state = "ACTIVE";
  matrix.lastAction = "registered; awaiting assignment";
  matrix.lastError = "none";
  renderMatrix(true);
}
async function heartbeat() {
  const result = await control("/workload/heartbeat", {
    workerVersion: WORKER_VERSION,
    capabilities: ["baileys", "group-transport", "media", "pairing"],
    status: "ACTIVE",
    assignedSessionIds: [...assignedSessions],
  }, credentialState.credential);
  matrix.lastHeartbeatAt = Date.now();
  matrix.lastControlAt = matrix.lastHeartbeatAt;
  matrix.state = "ACTIVE";
  matrix.lastAction = `heartbeat; ${assignedSessions.size} assigned`;
  matrix.lastError = "none";
  renderMatrix();
  return result;
}
async function poll() {
  const data = await control("/workload/poll", { limit: 5 }, credentialState.credential);
  matrix.lastControlAt = Date.now();
  for (const command of data.commands ?? []) {
    try {
      const result = await execute(command);
      matrix.lastAction = `command ${safeText(command.kind, "unknown", 28)} complete`;
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: true, result: encode(result) }, credentialState.credential);
    } catch (error) {
      noteError(error, `command ${safeText(command.kind, "unknown", 28)} failed`);
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, credentialState.credential).catch(() => undefined);
    }
  }
}
async function run() {
  const baileys = await import("@crysnovax/baileys");
  makeWASocket = baileys.default;
  makeCacheManagerAuthState = baileys.makeCacheManagerAuthState;
  const logger = await import("pino");
  pino = logger.default;
  await ensureWorkerName();
  await ensureStorageSecret();
  assertConfig();
  await mkdir(DATA_DIR, { recursive: true });
  await register();
  let nextHeartbeat = 0;
  while (!stopping) {
    try {
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + HEARTBEAT_MS; }
      await poll();
    } catch (error) {
      noteError(error, "control loop retrying");
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, CONTROL_POLL_MS * 3)));
    }
    await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
  }
}
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
run().catch((error) => { noteError(error, "fatal startup error"); process.exitCode = 1; });
