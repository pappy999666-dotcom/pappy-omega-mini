import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  makeCacheManagerAuthState,
  type CacheManagerStore,
  type WASocket,
} from "@crysnovax/baileys";
import { env } from "../config/env.js";
import {
  deleteSession,
  getSession,
  updateSession,
} from "../core/session-registry.js";
import {
  acquireSessionLock,
  closeSessionLockRedis,
  type SessionLock,
} from "../core/session-lock.js";
import {
  readEncryptedJson,
  removeEncryptedJson,
  writeEncryptedJson,
} from "../core/encrypted-store.js";
import { routeWhatsAppText, type WhatsAppReply } from "./message-router.js";
import {
  clearLifecycle,
  getLifecycleState,
  getStart,
  lifecycleKey,
  markClosed,
  markConnected,
  markOpening,
  markStopping,
  scheduleReconnect,
  setStart,
  startHeartbeat,
  stopAllLifecycles,
} from "./session-lifecycle.js";

interface RuntimeEvents {
  on(event: string, listener: (payload: any) => void): void;
}

interface RuntimeSocket extends WASocket {
  ev: RuntimeEvents;
  end: (error?: unknown) => void;
  waitForConnectionUpdate?: (
    predicate: (update: {
      connection?: string;
      lastDisconnect?: { error?: { output?: { statusCode?: number } } };
    }) => boolean,
  ) => Promise<unknown>;
}

interface RuntimeSession {
  socket: RuntimeSocket;
  stop: () => void;
}

const runtimes = new Map<string, RuntimeSession>();
const sessionLocks = new Map<string, SessionLock>();
export interface DisconnectClassification {
  code?: number;
  label: string;
  terminal: boolean;
  status: "LOGGED_OUT" | "ERROR" | "DEGRADED" | "RECONNECTING";
  recovery: string;
}

export function classifyDisconnect(error: unknown): DisconnectClassification {
  const candidate = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
    data?: { statusCode?: unknown };
  };
  const rawCode =
    candidate?.output?.statusCode ??
    candidate?.statusCode ??
    candidate?.data?.statusCode;
  const code = typeof rawCode === "number" ? rawCode : undefined;
  const known: Record<number, Omit<DisconnectClassification, "code">> = {
    401: {
      label: "logged-out",
      terminal: true,
      status: "LOGGED_OUT",
      recovery:
        "Pair this session again or purge it before creating a replacement.",
    },
    403: {
      label: "forbidden",
      terminal: true,
      status: "LOGGED_OUT",
      recovery:
        "WhatsApp rejected this authentication. Purge the session and pair again.",
    },
    405: {
      label: "device-mismatch",
      terminal: true,
      status: "ERROR",
      recovery:
        "This device session is incompatible. Purge the session and pair again.",
    },
    408: {
      label: "connection-closed",
      terminal: false,
      status: "DEGRADED",
      recovery: "The worker will retry with backoff.",
    },
    411: {
      label: "connection-lost",
      terminal: false,
      status: "DEGRADED",
      recovery: "The worker will retry with backoff.",
    },
    428: {
      label: "timed-out",
      terminal: false,
      status: "DEGRADED",
      recovery: "The worker will retry with backoff.",
    },
    440: {
      label: "connection-replaced",
      terminal: true,
      status: "ERROR",
      recovery:
        "Another WhatsApp Web session replaced this one. Purge and pair again if this is unintended.",
    },
    500: {
      label: "bad-session",
      terminal: true,
      status: "ERROR",
      recovery:
        "The saved authentication is invalid. Purge the session and pair again.",
    },
    503: {
      label: "service-unavailable",
      terminal: false,
      status: "DEGRADED",
      recovery: "WhatsApp is temporarily unavailable; the worker will retry.",
    },
    515: {
      label: "restart-required",
      terminal: false,
      status: "RECONNECTING",
      recovery:
        "WhatsApp requested a transport restart; the worker will retry.",
    },
  };
  const fallback = {
    label: "unknown-transport",
    terminal: false,
    status: "DEGRADED" as const,
    recovery:
      "The worker will retry with backoff; inspect the diagnostic reason if it persists.",
  };
  return {
    ...(code !== undefined ? { code } : {}),
    ...(code !== undefined && known[code] ? known[code] : fallback),
  };
}

class FileAuthStore implements CacheManagerStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, `${encodeURIComponent(key)}.json`);
  }

  async get(key: string): Promise<unknown> {
    try {
      return await readEncryptedJson(this.path(key));
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<unknown> {
    await mkdir(this.root, { recursive: true });
    await writeEncryptedJson(this.path(key), value);
    return value;
  }

  async delete(key: string): Promise<boolean> {
    try {
      await removeEncryptedJson(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async keys(_pattern = "*"): Promise<string[]> {
    return [];
  }
}

async function openWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const key = lifecycleKey(workspaceId, sessionId);
  const lifecycle = getLifecycleState(key);
  if (lifecycle.stopping) return;
  if (runtimes.has(key)) return;

  markOpening(key);
  const lock = await acquireSessionLock(workspaceId, sessionId);
  if (!lock) {
    updateSession(workspaceId, sessionId, {
      status: "RECONNECTING",
      disconnectReason: "session is already managed by another worker",
    });
    return;
  }
  sessionLocks.set(key, lock);
  const session = getSession(workspaceId, sessionId);
  const authRoot = join(env.SESSION_ROOT, workspaceId, sessionId);
  await mkdir(authRoot, { recursive: true });
  const { state, saveCreds } = await makeCacheManagerAuthState(
    new FileAuthStore(authRoot),
    sessionId,
  );
  const socket = makeWASocket({ auth: state }) as unknown as RuntimeSocket;

  socket.ev.on("creds.update", () => void saveCreds());
  socket.ev.on(
    "messages.upsert",
    (event: {
      messages?: Array<{
        key?: { remoteJid?: string; fromMe?: boolean };
        message?: {
          conversation?: string;
          extendedTextMessage?: {
            text?: string;
            contextInfo?: { quotedMessage?: Record<string, unknown> };
          };
          imageMessage?: { caption?: string; mimetype?: string };
          videoMessage?: { caption?: string; mimetype?: string };
        };
      }>;
    }) => {
      for (const message of event.messages ?? []) {
        if (message.key?.fromMe || !message.key?.remoteJid) continue;
        const text =
          message.message?.conversation ??
          message.message?.extendedTextMessage?.text ??
          message.message?.imageMessage?.caption ??
          message.message?.videoMessage?.caption ??
          "";
        const quoted =
          message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText =
          typeof quoted?.conversation === "string"
            ? quoted.conversation
            : typeof (
                  quoted?.extendedTextMessage as { text?: unknown } | undefined
                )?.text === "string"
              ? (quoted?.extendedTextMessage as { text: string }).text
              : undefined;
        if (!text && !quotedText) continue;
        void routeWhatsAppText({
          workspaceId,
          sessionId,
          senderJid: message.key.remoteJid,
          text,
          ...(quotedText ? { quotedText } : {}),
        }).then((reply) => {
          if (!reply) return;
          const jid = message.key?.remoteJid ?? "";
          if (typeof reply === "string") {
            void socket.sendMessage(jid, { text: reply });
            return;
          }
          const mediaReply = reply as WhatsAppReply;
          if (mediaReply.media) {
            void socket.sendMessage(jid, {
              [mediaReply.media.kind]: mediaReply.media.bytes,
              caption: mediaReply.caption ?? "",
            });
          } else if (mediaReply.text) {
            void socket.sendMessage(jid, { text: mediaReply.text });
          }
        });
      }
    },
  );

  socket.ev.on(
    "connection.update",
    (update: {
      connection?: string;
      lastDisconnect?: { error?: { output?: { statusCode?: number } } };
    }) => {
      if (update.connection === "open") {
        markConnected(key);
        startHeartbeat({ key, workspaceId, sessionId });
        updateSession(workspaceId, sessionId, {
          status: "ACTIVE",
          connectedAt: Date.now(),
          lastHealthyAt: Date.now(),
        });
        return;
      }
      if (update.connection !== "close") return;
      const classification = classifyDisconnect(update.lastDisconnect?.error);
      const code = classification.code;
      const terminal = classification.terminal;
      markClosed(key);
      runtimes.delete(key);
      const ownedLock = sessionLocks.get(key);
      sessionLocks.delete(key);
      void ownedLock?.release();
      updateSession(workspaceId, sessionId, {
        status: classification.status,
        disconnectReason: `transport:${code ?? "unknown"} · ${classification.label}. ${classification.recovery}`,
      });
      if (!terminal && !getLifecycleState(key).stopping) {
        scheduleReconnect({
          key,
          workspaceId,
          sessionId,
          run: () => void startWhatsAppSession(workspaceId, sessionId),
        });
      }
    },
  );

  runtimes.set(key, { socket, stop: () => socket.end() });
}

export async function startWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const key = lifecycleKey(workspaceId, sessionId);
  if (runtimes.has(key)) return;
  const existing = getStart(key);
  if (existing) return existing;
  const promise = openWhatsAppSession(workspaceId, sessionId);
  setStart(key, promise);
  return promise;
}

export async function requestWhatsAppPairingCode(
  workspaceId: string,
  sessionId: string,
  phoneNumber: string,
): Promise<string> {
  await startWhatsAppSession(workspaceId, sessionId);
  const key = lifecycleKey(workspaceId, sessionId);
  const lifecycle = getLifecycleState(key);
  const socket = getWhatsAppSocket(workspaceId, sessionId) as RuntimeSocket & {
    requestPairingCode?: (phoneNumber: string) => Promise<string>;
  };
  if (!lifecycle.connected && socket.waitForConnectionUpdate) {
    const update = await Promise.race([
      socket.waitForConnectionUpdate(
        (next) => next.connection === "open" || next.connection === "close",
      ),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 20_000),
      ),
    ]);
    if (update && (update as { connection?: string }).connection === "close") {
      const code = (
        update as {
          lastDisconnect?: { error?: { output?: { statusCode?: number } } };
        }
      ).lastDisconnect?.error?.output?.statusCode;
      throw new Error(
        `WhatsApp connection closed before pairing (${code ?? "unknown"}).`,
      );
    }
    if (!getLifecycleState(key).connected)
      throw new Error(
        "WhatsApp connection did not become ready for pairing within 20 seconds.",
      );
  }
  if (typeof socket.requestPairingCode !== "function")
    throw new Error(
      "The installed WhatsApp transport does not support pairing codes.",
    );
  return socket.requestPairingCode(phoneNumber.replace(/\D/g, ""));
}

export function getWhatsAppSocket(
  workspaceId: string,
  sessionId: string,
): WASocket {
  getSession(workspaceId, sessionId);
  const runtime = runtimes.get(lifecycleKey(workspaceId, sessionId));
  if (!runtime) throw new Error("WhatsApp session is not connected.");
  return runtime.socket;
}

export async function purgeWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  getSession(workspaceId, sessionId);
  stopWhatsAppSession(workspaceId, sessionId);
  await rm(join(env.SESSION_ROOT, workspaceId, sessionId), {
    recursive: true,
    force: true,
  });
  resetWhatsAppSessionLifecycle(workspaceId, sessionId);
  await deleteSession(workspaceId, sessionId);
}

export function stopWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): void {
  getSession(workspaceId, sessionId);
  const key = lifecycleKey(workspaceId, sessionId);
  markStopping(key);
  const runtime = runtimes.get(key);
  if (runtime) {
    runtime.stop();
    runtimes.delete(key);
  }
  const ownedLock = sessionLocks.get(key);
  sessionLocks.delete(key);
  void ownedLock?.release();
  updateSession(workspaceId, sessionId, {
    status: "DEGRADED",
    disconnectReason: "stopped by owner",
  });
}

export function shutdownWhatsAppSessions(): void {
  stopAllLifecycles();
  for (const runtime of runtimes.values()) runtime.stop();
  runtimes.clear();
  for (const lock of sessionLocks.values()) void lock.release();
  sessionLocks.clear();
  void closeSessionLockRedis();
}

export function getWhatsAppRuntimeCount(): number {
  return runtimes.size;
}

export function resetWhatsAppSessionLifecycle(
  workspaceId: string,
  sessionId: string,
): void {
  clearLifecycle(lifecycleKey(workspaceId, sessionId));
}
