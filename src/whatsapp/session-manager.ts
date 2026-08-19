import { access, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { saveWhatsAppMessageTrace } from "../persistence/mongo.js";
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
import { collectLinks } from "../links/link-collector.js";
import {
  clearLifecycle,
  getLifecycleState,
  noteCommandProcessed,
  noteError,
  noteMessageReceived,
  noteOutboundMessage,
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
const pairingNotifications = new Map<string, number>();
let pairingNotifier:
  ((chatId: number, message: string) => Promise<void>) | undefined;
export function setPairingNotifier(
  notifier: (chatId: number, message: string) => Promise<void>,
): void {
  pairingNotifier = notifier;
}
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
  const openingState = getLifecycleState(key);
  updateSession(workspaceId, sessionId, {
    status: "RECONNECTING",
    socketGeneration: openingState.socketGeneration,
    reconnectCount: openingState.reconnectAttempt,
    workerNodeId: process.env.HOSTNAME ?? `pid-${process.pid}`,
  });
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
  const sendTrackedMessage = async (
    jid: string,
    content: any,
  ): Promise<void> => {
    try {
      await socket.sendMessage(jid, content);
      const sentAt = noteOutboundMessage(key);
      updateSession(workspaceId, sessionId, {
        lastOutboundMessageAt: sentAt,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      noteError(key, reason);
      updateSession(workspaceId, sessionId, { lastError: reason });
      throw error;
    }
  };

  socket.ev.on("creds.update", () => void saveCreds());
  socket.ev.on(
    "messages.upsert",
    (event: {
      messages?: Array<{
        key?: {
          remoteJid?: string;
          remoteJidAlt?: string;
          participant?: string;
          participantAlt?: string;
          fromMe?: boolean;
          id?: string;
        };
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
      console.log(
        `[pappy-omega-mini] WhatsApp inbound upsert session=${sessionId} count=${event.messages?.length ?? 0}`,
      );
      for (const message of event.messages ?? []) {
        const receivedAt = noteMessageReceived(key);
        updateSession(workspaceId, sessionId, {
          lastMessageReceivedAt: receivedAt,
        });
        if (!message.key?.remoteJid) continue;
        const messageKey = message.key;

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
        const senderJid = message.key.fromMe
          ? ((socket as unknown as { user?: { id?: string } }).user?.id ?? message.key.remoteJid)
          : (message.key.participantAlt ??
            message.key.participant ??
            message.key.remoteJidAlt ??
            message.key.remoteJid);
        void saveWhatsAppMessageTrace({
          traceId: randomUUID(),
          workspaceId,
          sessionId,
          ...(message.key.id ? { messageId: message.key.id } : {}),
          direction: "inbound",
          remoteJid: message.key.remoteJid,
          ...(senderJid ? { senderJid } : {}),
          ...(text || quotedText ? { normalizedText: [text, quotedText].filter(Boolean).join("\\n") } : {}),
          outcome: text || quotedText ? "received" : "ignored",
          timestamp: receivedAt,
        }).catch(() => undefined);
        if (!text && !quotedText) continue;
        void collectLinks({
          workspaceId,
          text: [text, quotedText].filter(Boolean).join("\n"),
          sourceUserId: message.key.remoteJid,
          sourceSessionId: sessionId,
        }).catch(() => undefined);
        void routeWhatsAppText({
          workspaceId,
          sessionId,
          chatJid: message.key.remoteJid,
          senderJid,
          text,
          ...(quotedText ? { quotedText } : {}),
        })
          .then((reply) => {
            if (!reply) {
              void saveWhatsAppMessageTrace({
                traceId: randomUUID(),
                workspaceId,
                sessionId,
                ...(messageKey.id ? { messageId: messageKey.id } : {}),
                direction: "outbound",
                ...(messageKey.remoteJid ? { remoteJid: messageKey.remoteJid } : {}),
                outcome: "ignored",
                timestamp: Date.now(),
              }).catch(() => undefined);
              return;
            }
            const processedAt = noteCommandProcessed(key);
            updateSession(workspaceId, sessionId, {
              lastCommandProcessedAt: processedAt,
            });
            const jid = message.key?.remoteJid ?? "";
            if (typeof reply === "string") {
              void sendTrackedMessage(jid, { text: reply }).then(() =>
                saveWhatsAppMessageTrace({
                  traceId: randomUUID(), workspaceId, sessionId,
                  ...(messageKey.id ? { messageId: messageKey.id } : {}),
                  direction: "outbound", remoteJid: jid, normalizedText: reply,
                  handler: "routeWhatsAppText", outcome: "replied", timestamp: Date.now(),
                }).catch(() => undefined),
              ).catch((error) => saveWhatsAppMessageTrace({
                traceId: randomUUID(), workspaceId, sessionId,
                ...(messageKey.id ? { messageId: messageKey.id } : {}),
                direction: "outbound", remoteJid: jid, handler: "routeWhatsAppText",
                outcome: "failed", failureReason: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
              }).catch(() => undefined));
              return;
            }
            const mediaReply = reply as WhatsAppReply;
            if (mediaReply.media) {
              void sendTrackedMessage(jid, {
                [mediaReply.media.kind]: mediaReply.media.bytes,
                caption: mediaReply.caption ?? "",
              });
            } else if (mediaReply.text) {
              void sendTrackedMessage(jid, { text: mediaReply.text });
            }
          })
          .catch((error) => {
            console.error(
              `[pappy-omega-mini] WhatsApp command/reply failure session=${sessionId}:`,
              error instanceof Error ? error.message : String(error),
            );
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
        console.log(
          `[pappy-omega-mini] WhatsApp authenticated open workspace=${workspaceId} session=${sessionId}`,
        );
        markConnected(key);
        startHeartbeat({ key, workspaceId, sessionId });
        updateSession(workspaceId, sessionId, {
          status: "ACTIVE",
          connectedAt: Date.now(),
          lastHealthyAt: Date.now(),
          socketGeneration: getLifecycleState(key).socketGeneration,
          reconnectCount: 0,
          authHealth: "VALID",
          workerNodeId: process.env.HOSTNAME ?? `pid-${process.pid}`,
        });
        const chatId = pairingNotifications.get(key);
        if (chatId && pairingNotifier) {
          pairingNotifications.delete(key);
          void pairingNotifier(
            chatId,
            `✅ WhatsApp paired successfully. Session <b>${sessionId.slice(0, 12)}</b> is now online and ready to receive commands.`,
          ).catch(() => undefined);
        }
        return;
      }
      if (update.connection !== "close") return;
      const classification = classifyDisconnect(update.lastDisconnect?.error);
      console.warn(
        `[pappy-omega-mini] WhatsApp close workspace=${workspaceId} session=${sessionId} code=${classification.code ?? "unknown"} state=${classification.status}`,
      );
      const code = classification.code;
      const terminal = classification.terminal;
      markClosed(key);
      runtimes.delete(key);
      const ownedLock = sessionLocks.get(key);
      sessionLocks.delete(key);
      void ownedLock?.release();
      const authHealth = terminal ? "INVALID" : "DEGRADED";
      updateSession(workspaceId, sessionId, {
        status: classification.status,
        authHealth,
        lastReconnectAt: Date.now(),
        reconnectCount: getLifecycleState(key).reconnectAttempt,
        lastError: `transport:${code ?? "unknown"} · ${classification.label}`,
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

export async function hasPersistedWhatsAppAuth(
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const authRoot = join(env.SESSION_ROOT, workspaceId, sessionId);
  const credsPath = join(
    authRoot,
    `${encodeURIComponent(`${sessionId}:creds`)}.json`,
  );
  try {
    await access(credsPath);
    const credentials = (await readEncryptedJson(credsPath)) as {
      registered?: unknown;
    };
    return credentials?.registered === true;
  } catch {
    return false;
  }
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
  customCode = env.PAIRING_CUSTOM_CODE,
  telegramChatId?: number,
): Promise<string> {
  // Startup recovery can leave an unpaired socket reconnecting. Replace it
  // before issuing a new code so the code belongs to this pairing attempt.
  stopWhatsAppSession(workspaceId, sessionId);
  resetWhatsAppSessionLifecycle(workspaceId, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await startWhatsAppSession(workspaceId, sessionId);
  if (telegramChatId)
    pairingNotifications.set(
      lifecycleKey(workspaceId, sessionId),
      telegramChatId,
    );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const socket = getWhatsAppSocket(
        workspaceId,
        sessionId,
      ) as RuntimeSocket & {
        requestPairingCode?: (
          phoneNumber: string,
          customCode?: string,
        ) => Promise<string>;
      };
      if (typeof socket.requestPairingCode !== "function")
        throw new Error(
          "The installed WhatsApp transport does not support pairing codes.",
        );
      const normalizedCode = customCode
        .replace(/[^a-zA-Z0-9]/g, "")
        .toUpperCase();
      if (normalizedCode.length !== 8)
        throw new Error(
          "PAIRING_CUSTOM_CODE must contain exactly 8 letters or numbers for Baileys.",
        );
      return await socket.requestPairingCode(
        phoneNumber.replace(/\D/g, ""),
        normalizedCode,
      );
    } catch (error) {
      lastError = error;
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  const classification = classifyDisconnect(lastError);
  throw new Error(
    `Pairing transport ${classification.label}${classification.code ? ` (${classification.code})` : ""}: ${classification.recovery}`,
  );
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
