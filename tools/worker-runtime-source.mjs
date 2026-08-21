let makeWASocket;
let makeCacheManagerAuthState;
let pino;
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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
let PANEL_PAIRING_CODE = process.env.PAPPY_WORKLOAD_PAIRING_CODE ?? cliValue("--pairing-code", "--code");
const DATA_DIR = process.env.PAPPY_WORKER_DATA_DIR ?? "./pappy-workload-data";
let STORAGE_SECRET = process.env.PAPPY_WORKLOAD_SESSION_SECRET ?? "";
let WORKER_NAME = (process.env.PAPPY_WORKLOAD_NAME ?? cliValue("--name")) || "panel";
const WORKER_VERSION = process.env.PAPPY_WORKER_VERSION ?? "__PAPPY_WORKER_VERSION__";
const AUTO_UPDATE_ENABLED = !["0", "false", "off"].includes(String(process.env.PAPPY_WORKLOAD_AUTO_UPDATE ?? "true").toLowerCase());
const UPDATE_CHECK_MS = 30_000;
const PENDING_RELEASE_TIMEOUT_MS = 120_000;
const ENTRYPOINT = process.env.PAPPY_WORKER_ENTRYPOINT ?? "";
const RELEASE_PUBLIC_KEY_PEM = process.env.PAPPY_WORKLOAD_RELEASE_PUBLIC_KEY ?? `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAe+FnOPhHDo9y8pJ5rqwldSHwXUHKDG9HlTBqStHtRso=
-----END PUBLIC KEY-----\n`;
const secretPath = join(DATA_DIR, ".secret");
const CONTROL_POLL_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const workerStatePath = join(DATA_DIR, "worker.json");
const pendingReleasePath = join(DATA_DIR, ".pappy-update-state.json");
const runtimes = new Map();
const assignedSessions = new Set();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const intentionallyStopped = new Set();
const commandChains = new Map();
let credentialState;
let stopping = false;
const matrix = { state: "BOOTING", lastHeartbeatAt: 0, lastControlAt: 0, lastAction: "starting", lastError: "none", lastRenderAt: 0 };
const ANSI = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  blue: "\x1b[94m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
};
const COLOR = process.env.NO_COLOR ? false : Boolean(process.stdout.isTTY || process.env.PAPPY_COLOR === "1");
function paint(value, color) { return COLOR ? `${color}${value}${ANSI.reset}` : value; }
function safeText(value, fallback = "none", max = 42) {
  const text = String(value ?? fallback).replace(/[\r\n\t|]+/g, " ").trim();
  return (text || fallback).slice(0, max);
}
function wrapText(value, width = 76) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
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
  const stateColor = matrix.state === "ACTIVE" ? ANSI.green : matrix.state === "DEGRADED" || matrix.state === "ERROR" ? ANSI.red : ANSI.yellow;
  console.log(paint(lines[0], ANSI.dim));
  console.log(paint(lines[1], ANSI.blue));
  for (const line of lines.slice(2, 9)) console.log(paint(line, ANSI.cyan));
  console.log(paint(lines[9], stateColor));
  console.log(paint(lines[10], ANSI.blue));
  if (matrix.lastError && matrix.lastError !== "none") {
    console.log(paint("DETAIL     |", ANSI.red));
    for (const line of wrapText(matrix.lastError)) console.log(paint(`             ${line}`, ANSI.red));
  }
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
function normalizeWorkerName(value) {
  const normalized = String(value ?? "panel")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return /^[a-z0-9][a-z0-9-]{1,23}$/.test(normalized) ? normalized : "panel";
}
function normalizePairingCode(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^PAPPY-[A-Z0-9]{6,24}$/.test(normalized) ? normalized : "";
}
async function ensurePanelPairingCode() {
  const existing = normalizePairingCode(PANEL_PAIRING_CODE);
  if (existing) { PANEL_PAIRING_CODE = existing; return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("No panel pairing code was supplied. In Telegram tap Add Workload, copy the PAPPY code, then paste it into this panel console.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(paint("\n[PAPPY SETUP · FINAL STEP] Paste the pairing code from Telegram.", ANSI.cyan));
    console.log(paint("In Telegram open Workload → Add Workload, tap Copy Pairing Code, then paste it here.", ANSI.dim));
    while (true) {
      const answer = await prompt.question(paint("› Telegram pairing code: ", ANSI.green));
      const normalized = normalizePairingCode(answer);
      if (normalized) { PANEL_PAIRING_CODE = normalized; break; }
      console.log(paint("That code is not valid. It should look like PAPPY-XXXXXXXX. Copy it again from Telegram and paste it here.", ANSI.yellow));
    }
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

function startPendingReleaseWatchdog() {
  if (!ENTRYPOINT) return;
  setTimeout(async () => {
    try {
      const pending = JSON.parse(await readFile(pendingReleasePath, "utf8"));
      if (pending?.version === WORKER_VERSION && (!matrix.lastHeartbeatAt || Date.now() - matrix.lastHeartbeatAt > PENDING_RELEASE_TIMEOUT_MS)) {
        noteError(new Error(`Release ${WORKER_VERSION} did not reach a healthy heartbeat within ${PENDING_RELEASE_TIMEOUT_MS / 1000}s.`), "release watchdog requested rollback");
        process.exitCode = 76;
        process.exit(76);
      }
    } catch {
      // No pending release marker means this is a normal startup.
    }
  }, PENDING_RELEASE_TIMEOUT_MS).unref?.();
}
async function finalizeVerifiedRelease() {
  try {
    const pending = JSON.parse(await readFile(pendingReleasePath, "utf8"));
    if (pending?.version !== WORKER_VERSION) return;
    await unlink(pendingReleasePath).catch(() => undefined);
    if (typeof pending.backupPath === "string") await unlink(pending.backupPath).catch(() => undefined);
    matrix.lastAction = `release ${WORKER_VERSION} healthy; previous release retired`;
    renderMatrix(true);
  } catch {
    // No pending update is normal; an unreadable marker is left for the bootstrap watchdog.
  }
}
async function applyVerifiedUpdate(release) {
  if (!ENTRYPOINT || !release || release.version === WORKER_VERSION) return false;
  const bundle = Buffer.from(String(release.bundle ?? ""), "base64");
  const expectedHash = String(release.sha256 ?? "");
  const actualHash = createHash("sha256").update(bundle).digest("hex");
  if (!bundle.length || actualHash !== expectedHash) throw new Error("Worker release hash verification failed.");
  const signature = Buffer.from(String(release.signature ?? ""), "base64");
  if (!signature.length || !verify(null, bundle, RELEASE_PUBLIC_KEY_PEM, signature)) throw new Error("Worker release signature verification failed.");
  const temp = `${ENTRYPOINT}.update-${process.pid}-${randomUUID()}.js`;
  const backupPath = `${ENTRYPOINT}.previous`;
  await writeFile(temp, bundle, { mode: 0o700 });
  const syntax = spawnSync(process.execPath, ["--check", temp], { stdio: "ignore" });
  if (syntax.status !== 0) {
    await unlink(temp).catch(() => undefined);
    throw new Error("Worker release syntax validation failed; previous release retained.");
  }
  const current = await readFile(ENTRYPOINT);
  await writeFile(backupPath, current, { mode: 0o700 });
  await rename(temp, ENTRYPOINT);
  await writeFile(pendingReleasePath, JSON.stringify({ version: String(release.version), backupPath, attempts: 0, createdAt: Date.now() }) + "\n", { mode: 0o600 });
  matrix.state = "UPDATING";
  matrix.lastAction = `verified release ${safeText(release.version, "unknown", 20)}; restarting safely`;
  matrix.lastError = "none";
  renderMatrix(true);
  stopping = true;
  for (const runtime of runtimes.values()) {
    await runtime.store.flush().catch(() => undefined);
    runtime.socket.end?.(new Error("Verified worker update requested restart."));
  }
  process.exitCode = 75;
  setTimeout(() => process.exit(75), 100);
  return true;
}
async function checkForUpdate() {
  if (!AUTO_UPDATE_ENABLED || !ENTRYPOINT || !credentialState?.credential) return;
  try {
    const release = await control("/workload/release", { workerVersion: WORKER_VERSION }, credentialState.credential);
    if (release.updateAvailable !== false && release.version && release.version !== WORKER_VERSION) await applyVerifiedUpdate(release);
  } catch (error) {
    noteError(error, "update check failed; current release retained");
  }
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
  if (existing && !waitForReady) return existing;
  if (existing && waitForReady) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const current = runtimes.get(sessionId);
      if (current?.ready) return current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`WhatsApp session ${sessionId} did not become ready after reconnect.`);
  }
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
  const runtime = { workspaceId, sessionId, socket, store, ready: false, pairingReady, pairingNoticePending: false };
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
      if (runtime.pairingNoticePending && runtime.socket.user?.id) {
        runtime.pairingNoticePending = false;
        void runtime.socket.sendMessage(runtime.socket.user.id, {
          text: "✦ PAPPY OMEGA MINI · CONNECTED\\n\\nYour WhatsApp session is now connected and ready.\\n\\nStatus · ACTIVE · VALID\\nTransport · Baileys multi-device\\nAction · Commands are ready.",
        }).catch((error) => noteError(error, "connected notice failed"));
      }
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
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === 401;
      const closeReason = statusCode
        ? `WhatsApp connection closed (code ${statusCode}).`
        : "WhatsApp connection closed.";
      if (loggedOut) {
        assignedSessions.delete(sessionId);
        intentionallyStopped.add(sessionId);
        void reportSessionStatus(runtime, "LOGGED_OUT", "INVALID", closeReason);
      } else {
        void reportSessionStatus(runtime, "DEGRADED", "DEGRADED", closeReason);
      }
      runtimes.delete(sessionId);
      renderMatrix(true);
      const restartable = !loggedOut && Boolean(state.creds.registered || state.creds.me || state.creds.pairingCode);
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
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method) || ["constructor", "end", "ev", "ws", "auth", "authState", "user"].includes(method))
    throw new Error(`Unsafe workload transport method: ${method}`);
  const args = normalizeArgs(runtime, method, encodedArgs);
  if (method === "sendGroup" || method === "sendGroupText") {
    const [jid, content] = args;
    return runtime.socket.sendMessage(jid, content);
  }
  if (method === "sendGroupStatus") {
    const [jid, payload] = args;
    const native = runtime.socket.sendGroupStatus;
    if (typeof native === "function") return native.apply(runtime.socket, args);
    return runtime.socket.sendMessage(jid, payload);
  }
  if (method === "sendGroupHidetag" || method === "sendGroupMentions") {
    const [jid, content] = args;
    return runtime.socket.sendMessage(jid, content);
  }
  const fn = runtime.socket[method];
  if (typeof fn !== "function") throw new Error(`Transport method is unavailable: ${method}`);
  return fn.apply(runtime.socket, args);
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
  if (command.kind === "session.purge") {
    await stopSession(command.sessionId);
    await rm(join(DATA_DIR, "sessions", command.workspaceId, command.sessionId), { recursive: true, force: true });
    assignedSessions.delete(command.sessionId);
    return { status: "PURGED" };
  }
  if (command.kind === "session.pair.request") {
    const runtime = await startSession(command.workspaceId, command.sessionId, false);
    runtime.pairingNoticePending = true;
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
    if (method === "requestPairingCode") {
      runtime.pairingNoticePending = true;
      await runtime.pairingReady;
    }
    return await executeTransport(runtime, method, command.payload.args ?? []);
  }
  throw new Error(`Unsupported workload command: ${command.kind}`);
}
async function register() {
  const existing = await loadState();
  if (existing?.credential && existing.workerId) { credentialState = existing; return; }
  await ensurePanelPairingCode();
  const registration = await control("/workload/register", {
    pairingCode: PANEL_PAIRING_CODE,
    workerName: normalizeWorkerName(WORKER_NAME),
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
  const restoredSessionIds = Array.isArray(result.assignedSessionIds)
    ? result.assignedSessionIds.filter((value) => typeof value === "string")
    : [];
  for (const sessionId of restoredSessionIds) assignedSessions.add(sessionId);
  if (typeof result.workspaceId === "string" && result.workspaceId) credentialState.workspaceId = result.workspaceId;
  await saveState(credentialState);
  if (credentialState.workspaceId) {
    for (const sessionId of restoredSessionIds) {
      if (!runtimes.has(sessionId) && !intentionallyStopped.has(sessionId)) {
        void startSession(credentialState.workspaceId, sessionId, false).catch((error) => noteError(error, `startup recovery failed for ${sessionId}`));
      }
    }
  }
  matrix.lastHeartbeatAt = Date.now();
  matrix.lastControlAt = matrix.lastHeartbeatAt;
  matrix.state = "ACTIVE";
  matrix.lastAction = `heartbeat; ${assignedSessions.size} assigned`;
  matrix.lastError = "none";
  await finalizeVerifiedRelease();
  renderMatrix();
  return result;
}
async function processCommand(command) {
  const previous = commandChains.get(command.sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    try {
      const result = await execute(command);
      matrix.lastAction = `command ${safeText(command.kind, "unknown", 28)} complete`;
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: true, result: encode(result) }, credentialState.credential);
    } catch (error) {
      noteError(error, `command ${safeText(command.kind, "unknown", 28)} failed`);
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, credentialState.credential).catch(() => undefined);
    }
  });
  commandChains.set(command.sessionId, current);
  try { await current; } finally { if (commandChains.get(command.sessionId) === current) commandChains.delete(command.sessionId); }
}
async function poll() {
  const data = await control("/workload/poll", { limit: 5, waitMs: 20_000 }, credentialState.credential);
  matrix.lastControlAt = Date.now();
  const commands = Array.isArray(data.commands) ? data.commands : [];
  await Promise.all(commands.map((command) => processCommand(command)));
  return commands.length;
}
async function run() {
  const baileys = await import("@crysnovax/baileys");
  makeWASocket = baileys.default;
  makeCacheManagerAuthState = baileys.makeCacheManagerAuthState;
  const logger = await import("pino");
  pino = logger.default;
  WORKER_NAME = normalizeWorkerName(WORKER_NAME);
  await ensureStorageSecret();
  assertConfig();
  await mkdir(DATA_DIR, { recursive: true });
  startPendingReleaseWatchdog();
  await register();
  if (AUTO_UPDATE_ENABLED) setTimeout(() => void checkForUpdate(), 8_000).unref?.();
  let nextHeartbeat = 0;
  let nextUpdateCheck = Date.now() + UPDATE_CHECK_MS;
  while (!stopping) {
    try {
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + HEARTBEAT_MS; }
      if (Date.now() >= nextUpdateCheck) { await checkForUpdate(); nextUpdateCheck = Date.now() + UPDATE_CHECK_MS; }
      const commandCount = await poll();
      if (commandCount === 0) await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
    } catch (error) {
      noteError(error, "control loop retrying");
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, CONTROL_POLL_MS * 3)));
    }
  }
}
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
run().catch((error) => {
  noteError(error, "fatal startup error");
  const message = error instanceof Error ? error.message : String(error);
  console.log(paint("\n[PAPPY SETUP · NOT FINISHED]", ANSI.red));
  if (/pairing code|expired|registered to this workspace/i.test(message)) {
    console.log(paint("Next step: return to Telegram → Workload → Add Workload, copy the PAPPY pairing code, and paste it into this panel console.", ANSI.yellow));
  } else {
    console.log(paint("Next step: read README.md, confirm the panel is online, then start it again and follow the Telegram pairing-code prompt.", ANSI.yellow));
  }
  console.log(paint(`Detail: ${message}`, ANSI.dim));
  process.exitCode = 1;
});
