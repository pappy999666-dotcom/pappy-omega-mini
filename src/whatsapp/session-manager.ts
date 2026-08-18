import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  makeCacheManagerAuthState,
  type CacheManagerStore,
  type WASocket,
} from "@crysnovax/baileys";
import { env } from "../config/env.js";
import { getSession, updateSession } from "../core/session-registry.js";
import {
  readEncryptedJson,
  removeEncryptedJson,
  writeEncryptedJson,
} from "../core/encrypted-store.js";
import { routeWhatsAppText } from "./message-router.js";
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
}

interface RuntimeSession {
  socket: RuntimeSocket;
  stop: () => void;
}

const runtimes = new Map<string, RuntimeSession>();
const terminalDisconnectCodes = new Set([401, 403]);

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
          extendedTextMessage?: { text?: string };
        };
      }>;
    }) => {
      for (const message of event.messages ?? []) {
        if (message.key?.fromMe || !message.key?.remoteJid) continue;
        const text =
          message.message?.conversation ??
          message.message?.extendedTextMessage?.text;
        if (!text) continue;
        void routeWhatsAppText({
          workspaceId,
          sessionId,
          senderJid: message.key.remoteJid,
          text,
        }).then((reply) => {
          if (reply)
            void socket.sendMessage(message.key?.remoteJid ?? "", {
              text: reply,
            });
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
      const code = update.lastDisconnect?.error?.output?.statusCode;
      const terminal = Boolean(code && terminalDisconnectCodes.has(code));
      markClosed(key);
      runtimes.delete(key);
      updateSession(workspaceId, sessionId, {
        status: terminal ? "LOGGED_OUT" : "DEGRADED",
        ...(code
          ? { disconnectReason: `transport:${code}` }
          : { disconnectReason: "connection closed" }),
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
  const socket = getWhatsAppSocket(workspaceId, sessionId) as WASocket & {
    requestPairingCode?: (phoneNumber: string) => Promise<string>;
  };
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
  updateSession(workspaceId, sessionId, {
    status: "DEGRADED",
    disconnectReason: "stopped by owner",
  });
}

export function shutdownWhatsAppSessions(): void {
  stopAllLifecycles();
  for (const runtime of runtimes.values()) runtime.stop();
  runtimes.clear();
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
