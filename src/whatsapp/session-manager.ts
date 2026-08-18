import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  makeCacheManagerAuthState,
  type CacheManagerStore,
  type WASocket,
} from "@crysnovax/baileys";
import { env } from "../config/env.js";
import { getSession, updateSession } from "../core/session-registry.js";
import { routeWhatsAppText } from "./message-router.js";
import {
  readEncryptedJson,
  removeEncryptedJson,
  writeEncryptedJson,
} from "../core/encrypted-store.js";

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

  async keys(pattern = "*"): Promise<string[]> {
    // Auth state uses exact keys; wildcard listing is intentionally narrow until
    // a production object-store adapter is configured.
    return pattern === "*" ? [] : [];
  }
}

export async function startWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  if (runtimes.has(sessionId)) return;
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
        updateSession(workspaceId, sessionId, {
          status: "ACTIVE",
          connectedAt: Date.now(),
          lastHealthyAt: Date.now(),
        });
        return;
      }
      if (update.connection !== "close") return;
      const code = update.lastDisconnect?.error?.output?.statusCode;
      updateSession(workspaceId, sessionId, {
        status:
          code && terminalDisconnectCodes.has(code) ? "LOGGED_OUT" : "DEGRADED",
        ...(code
          ? { disconnectReason: `transport:${code}` }
          : { disconnectReason: "connection closed" }),
      });
      runtimes.delete(sessionId);
    },
  );

  runtimes.set(sessionId, { socket, stop: () => socket.end() });
}

export function getWhatsAppSocket(
  workspaceId: string,
  sessionId: string,
): WASocket {
  getSession(workspaceId, sessionId);
  const runtime = runtimes.get(sessionId);
  if (!runtime) throw new Error("WhatsApp session is not connected.");
  return runtime.socket;
}

export function stopWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): void {
  getSession(workspaceId, sessionId);
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  runtime.stop();
  runtimes.delete(sessionId);
  updateSession(workspaceId, sessionId, {
    status: "DEGRADED",
    disconnectReason: "stopped by owner",
  });
}
