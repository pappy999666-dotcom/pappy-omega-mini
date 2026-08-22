let makeWASocket;
let makeCacheManagerAuthState;
let makeInMemoryStore;
let downloadMediaMessage;
let pino;
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
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
const broadcastDataDir = join(DATA_DIR, "broadcasts");
const runtimes = new Map();
const assignedSessions = new Set();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const intentionallyStopped = new Set();
const commandChains = new Map();
const backgroundCommandChains = new Map();
const broadcastCommandChains = new Map();
function isBackgroundCommand(command) {
  if (command?.kind !== "bridge.command") return false;
  const method = String(command?.payload?.method ?? "");
  return method === "groupGetInviteInfo" || method === "groupAcceptInvite";
}
function commandChainFor(command) {
  if (command?.kind === "broadcast.start" || command?.kind === "broadcast.cancel") return broadcastCommandChains;
  if (isBackgroundCommand(command)) return backgroundCommandChains;
  return commandChains;
}
const broadcastRunners = new Map();
const broadcastGroupCache = new Map();
const groupSummaryCache = new Map();
const groupSummaryInflight = new Map();
let credentialState;
let stopping = false;
const matrix = { state: "BOOTING", lastHeartbeatAt: 0, lastControlAt: 0, lastAction: "starting", lastError: "none", lastRenderAt: 0 };
let trafficPaused = false;
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
function isScopedInviteValidationFailure(command, error) {
  if (command?.kind !== "bridge.command" || String(command?.payload?.method ?? "") !== "groupGetInviteInfo") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /growth[- ]locked|not[- ]authorized|not authorized/i.test(message);
}
function noteScopedInviteValidationFailure(command, error) {
  const message = error instanceof Error ? error.message : String(error);
  matrix.lastAction = `invite validation deferred: ${safeText(message, "scoped failure", 96)}`;
  if (matrix.state !== "DEGRADED" && matrix.state !== "ERROR") matrix.lastError = "none";
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
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${CONTROL_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(35_000),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok !== false) return data;
      const message = data.error ?? `Control request failed (${response.status}).`;
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= 2) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 300 : 1_000));
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/413|too large|not.?authori[sz]ed|authentication|expired|revoked/i.test(message) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 300 : 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  const logger = pino({ level: "warn" });
  const contactStore = makeInMemoryStore({ logger });
  const socket = makeWASocket({ auth: state, logger, generateHighQualityLinkPreview: true, store: contactStore });
  contactStore.bind(socket.ev);
  socket.store = contactStore;
  socket.ev.on("creds.update", saveCreds);
  let pairingReadyResolve;
  let pairingReadyReject;
  const pairingReady = new Promise((resolve, reject) => {
    pairingReadyResolve = resolve;
    pairingReadyReject = reject;
    setTimeout(() => reject(new Error("WhatsApp did not reach the pairing state.")), 15_000);
  });
  pairingReady.catch(() => undefined);
  const runtime = { workspaceId, sessionId, socket, store, contactStore, ready: false, pairingReady, pairingNoticePending: false };
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
      void localBroadcastGroups(runtime)
        .then((groups) => {
          matrix.lastAction = `group inventory cached · ${groups.length} groups`;
          matrix.lastError = "none";
          renderMatrix(true);
        })
        .catch(() => undefined);
      void resumeBroadcastsForSession(workspaceId, sessionId);
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
function normalizedMessage(message) {
  if (!message || typeof message !== "object") return undefined;
  let current = message;
  for (let index = 0; index < 5; index += 1) {
    const wrapperKey = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "groupStatusMessage", "groupStatusMessageV2"].find((name) => current?.[name]);
    if (!wrapperKey) break;
    const wrapper = current[wrapperKey];
    current = wrapper?.message && typeof wrapper.message === "object" ? wrapper.message : wrapper;
  }
  return current;
}
function mediaKind(message) {
  const content = normalizedMessage(message);
  for (const kind of ["image", "video", "audio", "document", "sticker"]) {
    if (content?.[`${kind}Message`] && typeof content[`${kind}Message`] === "object") return kind;
  }
  return undefined;
}
async function serializeInboundMedia(runtime, envelope) {
  if (typeof downloadMediaMessage !== "function" || !envelope?.message) return undefined;
  const content = normalizedMessage(envelope.message);
  const kind = mediaKind(content);
  if (!kind) return undefined;
  try {
    const bytes = await downloadMediaMessage(envelope, "buffer", {}, runtime.socket);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024) return undefined;
    const body = content?.[`${kind}Message`] ?? {};
    return {
      kind,
      bytes: bytes.toString("base64"),
      ...(typeof body.mimetype === "string" ? { mimeType: body.mimetype } : {}),
      ...(typeof body.fileName === "string" ? { fileName: body.fileName } : {}),
      ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
      ...(typeof body.ptt === "boolean" ? { ptt: body.ptt } : {}),
    };
  } catch (error) {
    matrix.lastAction = "inbound media download failed";
    matrix.lastError = error instanceof Error ? error.message : String(error);
    renderMatrix(true);
    return undefined;
  }
}
async function emitInbound(runtime, message) {
  if (trafficPaused) return;
  const key = message?.key ?? {};
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== "string" || !message.message) return;
  const text = messageText(message.message);
  const context = message.message.extendedTextMessage?.contextInfo ?? message.message.imageMessage?.contextInfo ?? message.message.videoMessage?.contextInfo ?? message.message.documentMessage?.contextInfo;
  const quotedMessage = context?.quotedMessage;
  const quotedText = messageText(quotedMessage);
  if (!text && !quotedText) return;
  const directMediaKind = mediaKind(message.message);
  const quotedMediaKind = quotedMessage ? mediaKind(quotedMessage) : undefined;
  const directMedia = directMediaKind
    ? await serializeInboundMedia(runtime, { key, message: message.message })
    : undefined;
  const quotedMedia = !directMedia && quotedMediaKind && quotedMessage
    ? await serializeInboundMedia(runtime, { key: { ...key, ...(typeof context?.stanzaId === "string" ? { id: context.stanzaId } : {}) }, message: quotedMessage })
    : undefined;
  const inboundMedia = directMedia ?? quotedMedia;
  const senderJid = key.fromMe ? (runtime.socket.user?.id ?? remoteJid) : (key.participantAlt ?? key.remoteJidAlt ?? key.participant ?? remoteJid);
  const eventPayload = {
    workspaceId: runtime.workspaceId,
    sessionId: runtime.sessionId,
    ...(typeof key.id === "string" ? { messageId: key.id } : {}),
    remoteJid,
    senderJid,
    text,
    ...(quotedText ? { quotedText } : {}),
    ...(typeof context?.participant === "string" ? { quotedSenderJid: context.participant } : {}),
    ...(Array.isArray(context?.mentionedJid) ? { mentionedJids: context.mentionedJid.slice(0, 100) } : {}),
    ...(inboundMedia ? { media: inboundMedia } : {}),
    ...(key.fromMe ? { fromMe: true } : {}),
  };
  try {
    await control("/workload/event", eventPayload, credentialState.credential);
  } catch (error) {
    if (!inboundMedia || !/413|too large|payload/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const compactPayload = { ...eventPayload };
    delete compactPayload.media;
    await control("/workload/event", compactPayload, credentialState.credential);
  }
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
function materializeWorkloadContent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const value = payload;
  const media = value.media;
  if (media && typeof media === "object" && !Array.isArray(media) && Buffer.isBuffer(media.bytes) && typeof media.kind === "string") {
    const content = { [media.kind]: media.bytes };
    if (typeof value.text === "string" && value.text) content.caption = value.text;
    if (typeof media.mimeType === "string" && media.mimeType) content.mimetype = media.mimeType;
    if (typeof media.fileName === "string" && media.fileName) content.fileName = media.fileName;
    if (media.kind === "audio" && media.ptt !== undefined) content.ptt = Boolean(media.ptt);
    return content;
  }
  const { media: _media, groupStatus: _groupStatus, groupStatusMessage: _groupStatusMessage, ...content } = value;
  return content;
}
async function getStatusJidList(runtime) {
  const recipients = new Set();
  const contacts = runtime.contactStore?.contacts ?? runtime.socket.store?.contacts ?? {};
  const entries = Array.isArray(contacts) ? contacts.map((value) => ["", value]) : Object.entries(contacts);
  for (const [key, value] of entries) {
    const item = value && typeof value === "object" ? { ...value, id: value.id ?? key } : { id: value ?? key };
    const jid = await workerParticipantJid(item, runtime);
    if (jid) recipients.add(jid.replace(/:\d+(?=@)/, ""));
  }
  const self = await workerParticipantJid({ id: runtime.socket.user?.id }, runtime);
  if (self) recipients.add(self.replace(/:\d+(?=@)/, ""));
  return [...recipients];
}
async function executeTransport(runtime, method, encodedArgs) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method) || ["constructor", "end", "ev", "ws", "auth", "authState", "user"].includes(method))
    throw new Error(`Unsafe workload transport method: ${method}`);
  const args = normalizeArgs(runtime, method, encodedArgs);
  if (method === "getStatusJidList") return getStatusJidList(runtime);
  if (method === "sendGroup" || method === "sendGroupText") {
    const [jid, content] = args;
    return runtime.socket.sendMessage(jid, materializeWorkloadContent(content));
  }
  if (method === "sendGroupStatus") {
    const [jid, payload] = args;
    const native = runtime.socket.sendGroupStatus;
    const hasMedia = Boolean(payload && typeof payload === "object" && payload.media);
    const text = payload && typeof payload === "object" && typeof payload.text === "string" ? payload.text : "";
    if (typeof native === "function" && !hasMedia && !/https?:\/\/\S+/i.test(text)) return native.apply(runtime.socket, args);
    const content = materializeWorkloadContent(payload);
    if (hasMedia) return runtime.socket.sendMessage(jid, { groupStatusMessage: content });
    return runtime.socket.sendMessage(jid, { ...content, groupStatus: true });
  }
  if (method === "sendGroupHidetag" || method === "sendGroupMentions") {
    const [jid, content] = args;
    return runtime.socket.sendMessage(jid, content);
  }
  if (method === "listGroupSummaries") {
    const cacheKey = runtime.sessionId;
    const cached = groupSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.groups;
    const pending = groupSummaryInflight.get(cacheKey);
    if (pending) return pending;
    const request = (async () => {
      const raw = await runtime.socket.groupFetchAllParticipating();
      const groups = Object.entries(raw ?? {}).map(([jid, metadata]) => {
        const item = metadata && typeof metadata === "object" ? metadata : {};
        const participants = Array.isArray(item.participants) ? item.participants.length : 0;
        return {
          jid,
          subject: typeof item.subject === "string" && item.subject ? item.subject : jid,
          participantCount: participants,
        };
      });
      groupSummaryCache.set(cacheKey, { expiresAt: Date.now() + 30_000, groups });
      return groups;
    })().finally(() => groupSummaryInflight.delete(cacheKey));
    groupSummaryInflight.set(cacheKey, request);
    return request;
  }
  if (method === "previewUpload") {
    const [encodedBytes, options] = args;
    if (!Buffer.isBuffer(encodedBytes)) throw new Error("Preview upload requires encoded thumbnail bytes.");
    if (encodedBytes.byteLength > 8 * 1024 * 1024) throw new Error("Preview thumbnail upload exceeds the 8 MiB safety limit.");
    const previewDir = join(DATA_DIR, "preview-uploads");
    const filePath = join(previewDir, `${randomUUID()}.enc`);
    await mkdir(previewDir, { recursive: true });
    await writeFile(filePath, encodedBytes, { mode: 0o600 });
    try {
      const upload = runtime.socket.waUploadToServer;
      if (typeof upload !== "function") throw new Error("Transport method is unavailable: waUploadToServer");
      return await upload.call(runtime.socket, filePath, options);
    } finally {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }
  const fn = runtime.socket[method];
  if (typeof fn !== "function") throw new Error(`Transport method is unavailable: ${method}`);
  if (method === "groupGetInviteInfo") {
    try {
      return await fn.apply(runtime.socket, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/bad.?request|400|invalid invite|invite.*not found|revoked|expired/i.test(message)) return {};
      throw error;
    }
  }
  return fn.apply(runtime.socket, args);
}
function broadcastCheckpointPath(jobId) {
  return join(broadcastDataDir, `${encodeURIComponent(jobId)}.json`);
}
async function readBroadcastCheckpoint(jobId) {
  try {
    return decrypt(await readFile(broadcastCheckpointPath(jobId), "utf8"));
  } catch {
    return undefined;
  }
}
async function writeBroadcastCheckpoint(checkpoint) {
  await mkdir(broadcastDataDir, { recursive: true });
  const path = broadcastCheckpointPath(checkpoint.jobId);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, encrypt(checkpoint), { mode: 0o600 });
  await rename(temp, path);
}
function broadcastInaccessible(message) {
  return /group is locked|group locked|group banned|group was banned|group does not exist|group not found|not a participant|not in the group|you were removed|you were kicked|kicked from the group|revoked group|invalid group/i.test(String(message));
}
function broadcastTransient(message) {
  return /rate|over.?limit|429|timeout|tempor|network|closed|not connected|unavailable|5\d\d/i.test(String(message));
}
async function localBroadcastGroups(runtime) {
  const cached = broadcastGroupCache.get(runtime.sessionId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.groups];
  const raw = await runtime.socket.groupFetchAllParticipating();
  const groups = Object.keys(raw ?? {}).filter((jid) => jid.endsWith("@g.us"));
  broadcastGroupCache.set(runtime.sessionId, { expiresAt: Date.now() + 5 * 60_000, groups });
  return [...groups];
}
async function loadBroadcastMedia(intent) {
  if (!intent.mediaRef || typeof intent.mediaRef !== "object") return undefined;
  const response = await control("/workload/media", { mediaRef: intent.mediaRef }, credentialState.credential);
  const value = decode(response.media);
  if (!value || typeof value !== "object" || !Buffer.isBuffer(value.bytes)) throw new Error("Worker could not resolve the broadcast media reference.");
  return value;
}
async function workerParticipantJid(participant, runtime) {
  if (!participant || typeof participant !== "object") return "";
  const value = participant;
  let jid = String(value.phoneNumber ?? value.pn ?? value.id ?? "");
  if (!jid) return "";
  if (jid.endsWith("@lid") || jid.endsWith("@hosted.lid")) {
    const mapping = runtime.socket.signalRepository?.lidMapping?.getPNForLID;
    const mapped = mapping ? await mapping.call(runtime.socket.signalRepository.lidMapping, jid).catch(() => "") : "";
    jid = typeof mapped === "string" ? mapped : "";
  }
  if (!jid) return "";
  return jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
}
const broadcastPreviewCache = new Map();
async function resolveBroadcastPreview(runtime, intent) {
  const text = typeof intent.text === "string" ? intent.text : "";
  if (!/https?:\/\/\S+/i.test(text)) return undefined;
  const cacheKey = `${runtime.sessionId}:${text}`;
  const cached = broadcastPreviewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.preview;
  try {
    const response = await control("/workload/preview", {
      workspaceId: runtime.workspaceId,
      sessionId: runtime.sessionId,
      text,
    }, credentialState.credential);
    const preview = response.preview ? decode(response.preview) : undefined;
    broadcastPreviewCache.set(cacheKey, { expiresAt: Date.now() + 60_000, preview });
    return preview;
  } catch (error) {
    noteError(error, "broadcast preview resolution failed");
    broadcastPreviewCache.set(cacheKey, { expiresAt: Date.now() + 5_000, preview: undefined });
    return undefined;
  }
}
async function sendLocalBroadcast(runtime, intent, jid, media, linkPreview) {
  const text = typeof intent.text === "string" ? intent.text : "";
  const content = media ? { media: { ...media, bytes: media.bytes }, text } : { text };
  if (intent.kind === "allstatus") {
    const hasMedia = Boolean(media);
    const hasUrl = /https?:\/\/\S+/i.test(text);
    if (typeof runtime.socket.sendGroupStatus === "function" && !hasMedia && !hasUrl) {
      await runtime.socket.sendGroupStatus(jid, { text });
      return;
    }
    const materialized = materializeWorkloadContent(content);
    const withPreview = linkPreview && typeof linkPreview === "object"
      ? { ...materialized, linkPreview }
      : materialized;
    if (hasMedia) await runtime.socket.sendMessage(jid, { groupStatusMessage: withPreview });
    else await runtime.socket.sendMessage(jid, { ...withPreview, groupStatus: true });
    return;
  }
  const metadata = await runtime.socket.groupMetadata(jid);
  const participants = (await Promise.all((metadata?.participants ?? []).map((participant) => workerParticipantJid(participant, runtime))))
    .filter(Boolean)
    .slice(0, 1000);
  const materialized = materializeWorkloadContent(content);
  const withPreview = linkPreview && typeof linkPreview === "object"
    ? { ...materialized, linkPreview }
    : materialized;
  await runtime.socket.sendMessage(jid, { ...withPreview, mentions: participants });
}
async function remoteBroadcastCancelled(runtime, jobId) {
  try {
    const response = await control("/workload/progress/get", { workspaceId: runtime.workspaceId, jobId }, credentialState.credential);
    return response.cancelRequested === true;
  } catch {
    return false;
  }
}
async function reportLocalBroadcast(runtime, checkpoint) {
  await control("/workload/progress", {
    workspaceId: checkpoint.workspaceId,
    sessionId: checkpoint.sessionId,
    jobId: checkpoint.jobId,
    state: checkpoint.state,
    totalGroups: checkpoint.totalGroups,
    completed: checkpoint.completed,
    failed: checkpoint.failed,
    skipped: checkpoint.skipped,
    ...(checkpoint.currentGroup ? { currentGroup: checkpoint.currentGroup } : {}),
    ...(checkpoint.nextActionAt ? { nextActionAt: checkpoint.nextActionAt } : {}),
    ...(checkpoint.error ? { error: String(checkpoint.error).slice(0, 500) } : {}),
    updatedAt: Date.now(),
  }, credentialState.credential).catch((error) => noteError(error, "broadcast progress report failed"));
}
async function runLocalBroadcast(runtime, intent, groups, media) {
  const repeat = Math.max(1, Math.min(20, Number(intent.repeat ?? 1)));
  const delayMs = Math.max(1_000, Math.min(120_000, Number(intent.delayMs ?? 20_000)));
  const previous = await readBroadcastCheckpoint(intent.jobId);
  const checkpoint = previous && previous.jobId === intent.jobId
    ? { ...previous, groups: Array.isArray(previous.groups) ? previous.groups : groups, totalGroups: Number(previous.totalGroups ?? groups.length), nextDelivery: Number(previous.nextDelivery ?? (Number(previous.completed ?? 0) + Number(previous.failed ?? 0) + Number(previous.skipped ?? 0))), state: "RUNNING" }
    : { jobId: intent.jobId, workspaceId: runtime.workspaceId, sessionId: runtime.sessionId, kind: intent.kind, text: intent.text, mediaRef: intent.mediaRef, delayMs, repeat, groups, totalGroups: groups.length, nextDelivery: 0, completed: 0, failed: 0, skipped: 0, state: "RUNNING", updatedAt: Date.now() };
  await writeBroadcastCheckpoint(checkpoint);
  await reportLocalBroadcast(runtime, checkpoint);
  const linkPreview = await resolveBroadcastPreview(runtime, intent);
  let lastPostAt = 0;
  let lastReportAt = 0;
  const totalDeliveries = checkpoint.totalGroups * repeat;
  for (let delivery = Number(checkpoint.nextDelivery ?? 0); delivery < totalDeliveries; delivery += 1) {
    if (broadcastCancelRequested.has(intent.jobId) || await remoteBroadcastCancelled(runtime, intent.jobId)) {
      checkpoint.state = "CANCELLED";
      checkpoint.nextDelivery = delivery;
      await writeBroadcastCheckpoint(checkpoint);
      await reportLocalBroadcast(runtime, checkpoint);
      return checkpoint;
    }
    if (lastPostAt) {
      const waitMs = Math.max(0, delayMs - (Date.now() - lastPostAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const index = Math.floor(delivery / repeat);
    const jid = groups[index];
    checkpoint.currentGroup = jid;
    checkpoint.nextActionAt = Date.now() + delayMs;
    let delivered = false;
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await sendLocalBroadcast(runtime, intent, jid, media, linkPreview);
        delivered = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (broadcastInaccessible(lastError)) break;
        if (!broadcastTransient(lastError) && attempt >= 3) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1_000 * attempt)));
      }
    }
    if (delivered) checkpoint.completed += 1;
    else if (broadcastInaccessible(lastError)) checkpoint.skipped += 1;
    else { checkpoint.failed += 1; checkpoint.error = lastError.slice(0, 500); }
    lastPostAt = Date.now();
    checkpoint.nextDelivery = delivery + 1;
    checkpoint.updatedAt = Date.now();
    await writeBroadcastCheckpoint(checkpoint);
    if (Date.now() - lastReportAt >= 2_000 || checkpoint.nextDelivery >= totalDeliveries) {
      lastReportAt = Date.now();
      await reportLocalBroadcast(runtime, checkpoint);
    }
  }
  checkpoint.state = checkpoint.failed > 0 ? "PARTIAL" : "COMPLETED";
  checkpoint.nextActionAt = Date.now();
  await writeBroadcastCheckpoint(checkpoint);
  await reportLocalBroadcast(runtime, checkpoint);
  broadcastCancelRequested.delete(intent.jobId);
  return checkpoint;
}
const broadcastCancelRequested = new Set();
async function startLocalBroadcast(runtime, intent) {
  if (!intent || typeof intent.jobId !== "string" || !intent.jobId) throw new Error("broadcast.start requires jobId.");
  if (intent.kind !== "allstatus" && intent.kind !== "allchat") throw new Error("broadcast.start has an unsupported kind.");
  if (!String(intent.text ?? "").trim() && !intent.mediaRef) throw new Error("Broadcast requires text or media.");
  const current = broadcastRunners.get(intent.jobId);
  if (current) return current.ready;
  const previous = await readBroadcastCheckpoint(intent.jobId);
  const groups = previous && Array.isArray(previous.groups) && previous.groups.length ? previous.groups : await localBroadcastGroups(runtime);
  const media = await loadBroadcastMedia(intent);
  const ready = Promise.resolve({ accepted: true, jobId: intent.jobId, totalGroups: groups.length, totalPosts: groups.length * Math.max(1, Math.min(20, Number(intent.repeat ?? 1))), delayMs: Math.max(1_000, Math.min(120_000, Number(intent.delayMs ?? 20_000))) });
  const done = ready.then(() => runLocalBroadcast(runtime, intent, groups, media)).catch(async (error) => {
    const failed = { jobId: intent.jobId, workspaceId: runtime.workspaceId, sessionId: runtime.sessionId, state: "FAILED", totalGroups: groups.length, completed: 0, failed: groups.length, skipped: 0, error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
    await writeBroadcastCheckpoint(failed).catch(() => undefined);
    await reportLocalBroadcast(runtime, failed).catch(() => undefined);
    throw error;
  });
  broadcastRunners.set(intent.jobId, { ready, done });
  void done.finally(() => { if (broadcastRunners.get(intent.jobId)?.done === done) broadcastRunners.delete(intent.jobId); }).catch(() => undefined);
  return ready;
}
async function resumeBroadcastsForSession(workspaceId, sessionId) {
  try {
    const entries = await readdir(broadcastDataDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const checkpoint = await readBroadcastCheckpoint(decodeURIComponent(entry.slice(0, -5)));
      if (!checkpoint || checkpoint.workspaceId !== workspaceId || checkpoint.sessionId !== sessionId || ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(checkpoint.state)) continue;
      const runtime = runtimes.get(sessionId);
      if (!runtime || broadcastRunners.has(checkpoint.jobId)) continue;
      void startLocalBroadcast(runtime, { jobId: checkpoint.jobId, kind: checkpoint.kind, text: checkpoint.text ?? "", mediaRef: checkpoint.mediaRef, delayMs: checkpoint.delayMs, repeat: checkpoint.repeat }).catch((error) => noteError(error, `broadcast resume failed for ${checkpoint.jobId}`));
    }
  } catch {
    // The directory may not exist on a new panel.
  }
}
async function execute(command) {
  if (trafficPaused) throw new Error("Panel traffic is paused by the administrator.");
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
  if (command.kind === "broadcast.start") {
    const runtime = await startSession(command.workspaceId, command.sessionId);
    const intent = { ...command.payload, jobId: String(command.payload.jobId ?? ""), kind: String(command.payload.kind ?? ""), text: String(command.payload.text ?? ""), delayMs: Number(command.payload.delayMs ?? 20_000), repeat: Number(command.payload.repeat ?? 1) };
    return await startLocalBroadcast(runtime, intent);
  }
  if (command.kind === "broadcast.cancel") {
    const jobId = String(command.payload.jobId ?? "");
    if (!jobId) throw new Error("broadcast.cancel requires jobId.");
    broadcastCancelRequested.add(jobId);
    const checkpoint = await readBroadcastCheckpoint(jobId);
    if (checkpoint && ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(checkpoint.state)) broadcastCancelRequested.delete(jobId);
    return { accepted: true, jobId };
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
  trafficPaused = result.status === "DISABLED";
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
  matrix.state = trafficPaused ? "PAUSED" : "ACTIVE";
  matrix.lastAction = trafficPaused ? `traffic paused; ${assignedSessions.size} assigned` : `heartbeat; ${assignedSessions.size} assigned`;
  matrix.lastError = "none";
  await finalizeVerifiedRelease();
  renderMatrix();
  return result;
}
async function processCommand(command) {
  const chains = commandChainFor(command);
  const previous = chains.get(command.sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    try {
      const result = await execute(command);
      matrix.lastAction = `command ${safeText(command.kind, "unknown", 28)} complete`;
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: true, result: encode(result) }, credentialState.credential);
    } catch (error) {
      if (isScopedInviteValidationFailure(command, error)) noteScopedInviteValidationFailure(command, error);
      else noteError(error, `command ${safeText(command.kind, "unknown", 28)} failed`);
      await control("/workload/result", { commandId: command.commandId, requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, credentialState.credential).catch(() => undefined);
    }
  });
  chains.set(command.sessionId, current);
  try { await current; } finally { if (chains.get(command.sessionId) === current) chains.delete(command.sessionId); }
}
async function poll() {
  if (trafficPaused) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(CONTROL_POLL_MS, 5_000)));
    return 0;
  }
  const data = await control("/workload/poll", { limit: 5, waitMs: 20_000 }, credentialState.credential);
  matrix.lastControlAt = Date.now();
  const commands = Array.isArray(data.commands) ? data.commands : [];
  for (const command of commands) void processCommand(command);
  return commands.length;
}
async function run() {
  const baileys = await import("@crysnovax/baileys");
  makeWASocket = baileys.default;
  makeCacheManagerAuthState = baileys.makeCacheManagerAuthState;
  makeInMemoryStore = baileys.makeInMemoryStore;
  downloadMediaMessage = baileys.downloadMediaMessage;
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
