import { access, mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import makeWASocket, {
  makeCacheManagerAuthState,
  type CacheManagerStore,
  type WASocket,
} from "@crysnovax/baileys";
import pino from "pino";
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
import { runAntiChecks, runAntiParticipantEvent } from "./anti-system/engine.js";
import { collectLinks, extractWhatsAppGroupInviteUrls } from "../links/link-collector.js";
import { prepareCanonicalPreviewContent } from "./baileys-native-preview.js";
import { enqueueInbound } from "./inbound-admission.js";
import { enqueueOutbound } from "./outbound-admission.js";
import {
  extractMessageContextInfo,
  extractMessageText,
  extractWhatsAppInteraction,
  extractQuotedMessage,
  extractQuotedText,
  resolveMediaPayload,
} from "./quoted-payload-resolver.js";
import { phoneJidFromIdentity } from "./identity-normalization.js";
import { trackInboundMessage } from "./moderation-message-tracker.js";
import { createAssignedWorkloadSocket, callAssignedWorkloadTransport } from "./workload-transport.js";
import {
  queueWorkloadCommand,
  revokeWorkloadSessionAssignment,
  waitForWorkloadCommand,
} from "../workload/service.js";
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
  ws?: {
    isOpen?: boolean;
    on?: (
      event: "error" | "close",
      listener: (error?: unknown) => void,
    ) => void;
  };
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
  generation: number;
  stop: () => void;
  flushAuth: () => Promise<void>;
}

const runtimes = new Map<string, RuntimeSession>();
const lastInboundSessionPersistAt = new Map<string, number>();
const sessionLocks = new Map<string, SessionLock>();
const pairingNotifications = new Map<string, number>();
let pairingNotifier:
  ((chatId: number, message: string) => Promise<void>) | undefined;
const pendingWhatsAppPairingNotice = new Set<string>();
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
    message?: unknown;
    output?: { statusCode?: unknown };
    statusCode?: unknown;
    data?: { statusCode?: unknown };
  };
  const message = String(
    candidate?.message ?? (error instanceof Error ? error.message : error ?? ""),
  ).toLowerCase();
  const explicitLogout = /logged[ _-]?out|auth[ _-]?revoked|invalid[ _-]?session|device[ _-]?removed|account[ _-]?logout/.test(message);
  const rawCode =
    candidate?.output?.statusCode ??
    candidate?.statusCode ??
    candidate?.data?.statusCode;
  const code = typeof rawCode === "number" ? rawCode : undefined;
  if (explicitLogout) {
    return {
      ...(code !== undefined ? { code } : {}),
      label: "logged-out",
      terminal: true,
      status: "LOGGED_OUT",
      recovery: "WhatsApp explicitly confirmed permanent logout or auth invalidation.",
    };
  }
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
      terminal: false,
      status: "DEGRADED",
      recovery:
        "WhatsApp returned forbidden without explicit logout confirmation; credentials are preserved and recovery is scheduled.",
    },
    405: {
      label: "device-mismatch",
      terminal: false,
      status: "DEGRADED",
      recovery:
        "WhatsApp reported a device mismatch; credentials are preserved and recovery is scheduled.",
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
      terminal: false,
      status: "DEGRADED",
      recovery:
        "Another WhatsApp stream may have replaced this connection; credentials are preserved and recovery is scheduled.",
    },
    500: {
      label: "bad-session",
      terminal: false,
      status: "DEGRADED",
      recovery:
        "WhatsApp returned a bad-session signal without explicit logout confirmation; credentials are preserved and recovery is scheduled.",
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
  if (code === 401 && !explicitLogout) {
    return {
      code,
      label: "unauthorized-paused",
      terminal: false,
      status: "LOGGED_OUT",
      recovery:
        "WhatsApp rejected this socket with 401; credentials are preserved, automatic reconnect is paused, and the session can be paired or resumed explicitly.",
    };
  }
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
  private readonly pendingWrites = new Map<string, Promise<void>>();

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
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.root, { recursive: true });
        await writeEncryptedJson(this.path(key), value);
      });
    this.pendingWrites.set(key, write);
    try {
      await write;
      return value;
    } finally {
      if (this.pendingWrites.get(key) === write) this.pendingWrites.delete(key);
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingWrites.values());
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
  const socketGeneration = openingState.socketGeneration;
  updateSession(workspaceId, sessionId, {
    status: "RECONNECTING",
    socketGeneration,
    reconnectCount: openingState.reconnectAttempt,
    workerNodeId: process.env.HOSTNAME ?? `pid-${process.pid}`,
  });
  const lock = await acquireSessionLock(workspaceId, sessionId);
  if (!lock) {
    updateSession(workspaceId, sessionId, {
      status: "RECONNECTING",
      disconnectReason: "session is already managed by another worker; retry scheduled",
    });
    scheduleReconnect({
      key,
      workspaceId,
      sessionId,
      run: () => void startWhatsAppSession(workspaceId, sessionId),
    });
    return;
  }
  sessionLocks.set(key, lock);
  const session = getSession(workspaceId, sessionId);
  const authRoot = join(env.SESSION_ROOT, workspaceId, sessionId);
  await mkdir(authRoot, { recursive: true });
  const authStore = new FileAuthStore(authRoot);
  const { state, saveCreds } = await makeCacheManagerAuthState(
    authStore,
    sessionId,
  );
  let recoverStaleSocket: ((reason: string) => void) | undefined;
  let staleRecoveryTriggered = false;
  let cryptoErrorWindowStartedAt = 0;
  let cryptoErrorCount = 0;
  let cryptoStormRecoveryTriggered = false;
  let stableOpenTimer: ReturnType<typeof setTimeout> | undefined;
  const CRYPTO_ERROR_WINDOW_MS = 30_000;
  const CRYPTO_ERROR_LIMIT = 12;
  const logger = pino({
    level: process.env.PAPPY_WA_LOG_LEVEL ?? "warn",
    hooks: {
      logMethod(inputArgs, method) {
        const rendered = inputArgs
          .map((value) =>
            typeof value === "string"
              ? value
              : (() => {
                  try {
                    return JSON.stringify(value);
                  } catch {
                    return String(value);
                  }
                })(),
          )
          .join(" ");
        const cryptoFailure = /failed to decrypt message|No session found to decrypt message|Expected Buffer instead of|Received message with old counter/i.test(rendered);
        if (cryptoFailure) {
          const now = Date.now();
          if (!cryptoErrorWindowStartedAt || now - cryptoErrorWindowStartedAt > CRYPTO_ERROR_WINDOW_MS) {
            cryptoErrorWindowStartedAt = now;
            cryptoErrorCount = 0;
            cryptoStormRecoveryTriggered = false;
          }
          cryptoErrorCount += 1;
          if (cryptoErrorCount >= CRYPTO_ERROR_LIMIT && !cryptoStormRecoveryTriggered) {
            cryptoStormRecoveryTriggered = true;
            console.warn(
              `[pappy-omega-mini] Baileys crypto error storm session=${sessionId}; recovering socket after ${cryptoErrorCount} failures in ${Math.round((now - cryptoErrorWindowStartedAt) / 1000)}s`,
            );
            queueMicrotask(() => recoverStaleSocket?.("Baileys crypto error storm"));
          }
          return;
        }
        if (rendered.includes("smax-invalid") && !staleRecoveryTriggered) {
          staleRecoveryTriggered = true;
          queueMicrotask(() => recoverStaleSocket?.(rendered));
        }
        method.apply(this, inputArgs);
      },
    },
  });
  const { makeInMemoryStore } = (await import("@crysnovax/baileys")) as unknown as {
    makeInMemoryStore: (config?: Record<string, unknown>) => {
      contacts?: Record<string, unknown>;
      bind: (events: RuntimeEvents) => void;
    };
  };
  const contactStore = makeInMemoryStore({ logger });
  const socket = makeWASocket({
    auth: state,
    logger,
    generateHighQualityLinkPreview: true,
    store: contactStore,
  } as never) as unknown as RuntimeSocket;
  const isCurrentSocket = (): boolean => {
    const lifecycleState = getLifecycleState(key);
    const runtime = runtimes.get(key);
    return lifecycleState.socketGeneration === socketGeneration &&
      (!runtime || runtime.socket === socket);
  };
  contactStore.bind(socket.ev);
  (socket as unknown as { store?: unknown }).store = contactStore;
  const forceSocketRecovery = (error?: unknown) => {
    if (!isCurrentSocket()) return;
    const reason =
      error instanceof Error
        ? error.message
        : String(error ?? "websocket closed");
    console.warn(
      `[pappy-omega-mini] low-level WhatsApp websocket failure workspace=${workspaceId} session=${sessionId}: ${reason}`,
    );
    try {
      socket.end(error ?? new Error(reason));
    } catch {
      // The connection.update close handler owns state transition and reconnect scheduling.
    }
  };
  recoverStaleSocket = (reason) =>
    forceSocketRecovery(new Error(`Baileys server rejection: ${reason}`));
  socket.ws?.on?.("error", forceSocketRecovery);
  socket.ws?.on?.("close", () => {
    if (isCurrentSocket())
      forceSocketRecovery(new Error("WhatsApp websocket closed."));
  });
  const sendTrackedMessage = async (
    jid: string,
    content: any,
  ): Promise<void> => {
    await enqueueOutbound({
      sessionId: key,
      priority: 1,
      run: async () => {
    try {
      const nativeTable = content?.nativeTable as { title?: string; headers?: unknown[]; rows?: unknown[][]; buttons?: Array<{ id?: string; text?: string }>; footer?: string } | undefined;
      const richMenu = content?.richMenu as Record<string, unknown> | undefined;
      const richMenuSender = (socket as unknown as { richMenu?: (target: string, value: Record<string, unknown>) => Promise<unknown> }).richMenu;
      const mentions = Array.isArray(content?.mentions) ? content.mentions.filter((value: unknown): value is string => typeof value === "string") : [];
      if (richMenu && typeof richMenuSender === "function") {
        await richMenuSender(jid, richMenu);
      } else if (nativeTable && typeof socket.sendInteractiveTable === "function") {
        await socket.sendInteractiveTable(jid, nativeTable, mentions.length ? { mentions } : {});
      } else {
        const { nativeTable: _nativeTable, richMenu: _richMenu, ...safeContent } = content ?? {};
        const text =
          typeof safeContent?.text === "string"
            ? safeContent.text
            : typeof safeContent?.caption === "string"
              ? safeContent.caption
              : undefined;
        const outbound = await prepareCanonicalPreviewContent({
          ...(text ? { text } : {}),
          content: safeContent as Record<string, unknown>,
          socket,
          cacheScope: `${workspaceId}:${sessionId}`,
        });
        await socket.sendMessage(jid, outbound);
      }
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
      },
    });
  };
  socket.ev.on(
    "creds.update", () => {
    if (isCurrentSocket()) void saveCreds();
  });
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
            contextInfo?: {
              quotedMessage?: Record<string, unknown>;
              participant?: string;
              mentionedJid?: string[];
            };
          };
          imageMessage?: { caption?: string; mimetype?: string };
          videoMessage?: { caption?: string; mimetype?: string };
        };
      }>;
    }) => {
      if (!isCurrentSocket()) return;
      if (process.env.PAPPY_DEBUG_WA_EVENTS === "1")
        console.log(
          `[pappy-omega-mini] WhatsApp inbound upsert session=${sessionId} count=${event.messages?.length ?? 0}`,
        );
      for (const message of event.messages ?? []) {
        enqueueInbound({
          sessionId: key,
          priority: 1,
          run: async () => {
        const receivedAt = noteMessageReceived(key);
        const lastPersistedAt = lastInboundSessionPersistAt.get(key) ?? 0;
        if (receivedAt - lastPersistedAt >= 5_000 || message.key?.fromMe === true) {
          lastInboundSessionPersistAt.set(key, receivedAt);
          updateSession(workspaceId, sessionId, {
            lastMessageReceivedAt: receivedAt,
          });
        }
        if (!message.key?.remoteJid) return;
        const messageKey = message.key;

        const envelope = {
          key: message.key as Record<string, unknown>,
          ...(message.message
            ? { message: message.message as Record<string, unknown> }
            : {}),
        };
        const interaction = extractWhatsAppInteraction(envelope.message);
        const interactionId = interaction?.id ?? undefined;
        const text = interactionId ?? extractMessageText(envelope.message);
        const quoted = extractQuotedMessage(envelope.message);
        const quotedText = extractQuotedText(quoted);
        const combinedText = [text, quotedText].filter(Boolean).join("\n");
        const commandSource = combinedText.trim().toLowerCase();
        const sessionPrefix = getSession(workspaceId, sessionId).prefix.trim();
        const isPrefixedCommand = Boolean(
          interactionId || (sessionPrefix && commandSource.startsWith(sessionPrefix)),
        );
        const hasGroupInvite = extractWhatsAppGroupInviteUrls(combinedText).length > 0;
        const shouldTraceInbound = Boolean(text || quotedText) && (isPrefixedCommand || hasGroupInvite);
        const mediaCommand =
          /(?:pfp|setpfp|setgpp|gpp|creategroup|newgroup|groupcreate|allstatus|allchat|gstatus|tag|stag|status)/.test(
            commandSource,
          );
        const inboundMedia = mediaCommand
          ? ((await resolveMediaPayload(envelope, socket)) ??
            (quoted
              ? await resolveMediaPayload(
                  { key: envelope.key, message: quoted },
                  socket,
                )
              : undefined))
          : undefined;
        const senderJid = message.key.fromMe
          ? ((socket as unknown as { user?: { id?: string } }).user?.id ??
            message.key.remoteJid)
          : (message.key.participantAlt ??
            message.key.remoteJidAlt ??
            message.key.participant ??
            message.key.remoteJid);
        const contextInfo = extractMessageContextInfo(envelope.message) as
          | { quotedMessage?: Record<string, unknown>; participant?: string; mentionedJid?: string[]; stanzaId?: string }
          | undefined;
        const lidMapping = (
          socket as unknown as {
            signalRepository?: {
              lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> };
            };
          }
        ).signalRepository?.lidMapping;
        const resolvePhoneJid = async (candidate?: string): Promise<string | undefined> => {
          if (!candidate) return undefined;
          const trimmed = candidate.trim();
          const mapped = trimmed.endsWith("@lid") || trimmed.endsWith("@hosted.lid")
            ? await lidMapping?.getPNForLID?.(trimmed)
            : trimmed;
          return phoneJidFromIdentity(mapped);
        };
        const resolvedSenderJid = await resolvePhoneJid(senderJid);
        if (message.key.remoteJid?.endsWith("@g.us") && resolvedSenderJid && message.key.id)
          trackInboundMessage(workspaceId, sessionId, message.key.remoteJid, resolvedSenderJid, message.key as Record<string, unknown>);
        const quotedSenderJid = await resolvePhoneJid(contextInfo?.participant);
        const quotedMessageKey = contextInfo?.stanzaId && message.key.remoteJid
          ? {
              remoteJid: message.key.remoteJid,
              id: contextInfo.stanzaId,
              ...(quotedSenderJid ? { participant: quotedSenderJid } : {}),
            }
          : undefined;
        const mentionedJids = await Promise.all(
          (contextInfo?.mentionedJid ?? []).map((candidate) => resolvePhoneJid(candidate)),
        );

        if (!interactionId) void runAntiChecks({
          workspaceId,
          sessionId,
          groupJid: message.key.remoteJid,
          ...(message.key.id ? { messageId: message.key.id } : {}),
          senderJid: resolvedSenderJid ?? "",
          ...(message.key.fromMe ? { fromMe: true } : {}),
          text,
          ...(sessionPrefix ? { prefix: sessionPrefix } : {}),
          ...(quotedText ? { quotedText } : {}),
          ...(envelope.message ? { message: envelope.message } : {}),
          ...(message.key ? { rawKey: message.key as Record<string, unknown> } : {}),
          ...(mentionedJids.filter((value): value is string => Boolean(value)).length
            ? { mentionedJids: mentionedJids.filter((value): value is string => Boolean(value)) }
            : {}),
          ...(inboundMedia?.kind ? { mediaKind: inboundMedia.kind } : {}),
          ...(inboundMedia?.ptt !== undefined ? { mediaPtt: inboundMedia.ptt } : {}),
        }).catch((error) => {
          if (process.env.PAPPY_DEBUG_WA_ANTI === "1")
            console.warn(`[pappy-omega-mini] isolated Anti System check failed session=${sessionId}:`, error);
        });
        if (shouldTraceInbound)
          void saveWhatsAppMessageTrace({
            traceId: randomUUID(),
            workspaceId,
            sessionId,
            ...(message.key.id ? { messageId: message.key.id } : {}),
            direction: "inbound",
            remoteJid: message.key.remoteJid,
            ...(senderJid ? { senderJid } : {}),
            normalizedText: combinedText,
            outcome: "received",
            timestamp: receivedAt,
          }).catch(() => undefined);
        if (!text && !quotedText) return;
        if (!interactionId && !isPrefixedCommand && hasGroupInvite) {
          void collectLinks({
            workspaceId,
            text: [text, quotedText].filter(Boolean).join("\n"),
            sourceUserId: senderJid,
            sourceSessionId: sessionId,
          })
            .then(async (collection) => {
              if (collection.added <= 0) return;
              const collectedAt = Date.now();
              const latestSession = getSession(workspaceId, sessionId);
              const next = updateSession(workspaceId, sessionId, {
                collectedLinkCount:
                  (latestSession.collectedLinkCount ?? 0) + collection.added,
                lastLinkCollectedAt: collectedAt,
              });
              const urls = collection.urls;
              if (!urls.length) return;
              const { runValidatorSweepNow } = await import("../jobs/runtime.js");
              await runValidatorSweepNow();
            })
            .catch((error) => {
              console.error(
                `[pappy-omega-mini] automatic link collection/validation failed session=${sessionId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
        if (!interactionId && !isPrefixedCommand && sessionPrefix) return;
        if (process.env.PAPPY_DEBUG_WA_COMMANDS === "1")
          console.info(
            `[pappy-omega-mini] WhatsApp command candidate session=${sessionId} chat=${message.key.remoteJid} text=${JSON.stringify(text.slice(0, 160))}`,
          );
        void           routeWhatsAppText({
            workspaceId,
            sessionId,
            ...(messageKey.id ? { messageId: messageKey.id } : {}),
            chatJid: message.key.remoteJid,
            senderJid,
            ...(quotedSenderJid ? { quotedSenderJid } : {}),
            ...(quotedMessageKey ? { quotedMessageKey } : {}),
            ...(mentionedJids.filter((value): value is string => Boolean(value)).length
            ? { mentionedJids: mentionedJids.filter((value): value is string => Boolean(value)) }
            : {}),
          text: interactionId ? "" : text,
          ...(interactionId ? { interactionId } : {}),
          ...(message.key.fromMe ? { fromMe: true } : {}),
          ...(quotedText ? { quotedText } : {}),
          ...(inboundMedia ? { media: inboundMedia } : {}),
        })
          .then((reply) => {
            if (!reply) {
              void saveWhatsAppMessageTrace({
                traceId: randomUUID(),
                workspaceId,
                sessionId,
                ...(messageKey.id ? { messageId: messageKey.id } : {}),
                direction: "outbound",
                ...(messageKey.remoteJid
                  ? { remoteJid: messageKey.remoteJid }
                  : {}),
                outcome: "ignored",
                timestamp: Date.now(),
              }).catch(() => undefined);
              return;
            }
            const processedAt = noteCommandProcessed(key);
            updateSession(workspaceId, sessionId, {
              lastCommandProcessedAt: processedAt,
            });
            void saveWhatsAppMessageTrace({
              traceId: randomUUID(),
              workspaceId,
              sessionId,
              ...(messageKey.id ? { messageId: messageKey.id } : {}),
              direction: "inbound",
              remoteJid: messageKey.remoteJid ?? "unknown",
              ...(senderJid ? { senderJid } : {}),
              normalizedText: text.slice(0, 4000),
              handler: "routeWhatsAppText",
              outcome: "processed",
              timestamp: processedAt,
            }).catch(() => undefined);
            const jid = message.key?.remoteJid ?? "";
            if (typeof reply === "string") {
              void sendTrackedMessage(jid, { text: reply })
                .then(() =>
                  saveWhatsAppMessageTrace({
                    traceId: randomUUID(),
                    workspaceId,
                    sessionId,
                    ...(messageKey.id ? { messageId: messageKey.id } : {}),
                    direction: "outbound",
                    remoteJid: jid,
                    normalizedText: reply,
                    handler: "routeWhatsAppText",
                    outcome: "replied",
                    timestamp: Date.now(),
                  }).catch(() => undefined),
                )
                .catch((error) =>
                  saveWhatsAppMessageTrace({
                    traceId: randomUUID(),
                    workspaceId,
                    sessionId,
                    ...(messageKey.id ? { messageId: messageKey.id } : {}),
                    direction: "outbound",
                    remoteJid: jid,
                    handler: "routeWhatsAppText",
                    outcome: "failed",
                    failureReason:
                      error instanceof Error ? error.message : String(error),
                    timestamp: Date.now(),
                  }).catch(() => undefined),
                );
              return;
            }
            const mediaReply = reply as WhatsAppReply;
            const deliverObjectReply = async (): Promise<void> => {
              const content = mediaReply.media
                ? {
                    [mediaReply.media.kind]: mediaReply.media.bytes,
                    ...(mediaReply.media.kind !== "audio" && (mediaReply.caption ?? "") ? { caption: mediaReply.caption } : {}),
                    ...(mediaReply.media.mimeType ? { mimetype: mediaReply.media.mimeType } : {}),
                    ...(mediaReply.media.kind === "video" || mediaReply.media.kind === "document" ? { fileName: mediaReply.media.fileName } : {}),
                    ...(mediaReply.nativeFlow ? { nativeFlow: mediaReply.nativeFlow } : {}),
                    ...(mediaReply.nativeTable ? { nativeTable: mediaReply.nativeTable } : {}),
                    ...(mediaReply.richMenu ? { richMenu: mediaReply.richMenu } : {}),
                    ...(mediaReply.mentions?.length ? { mentions: mediaReply.mentions } : {}),
                  }
                : {
                    ...(mediaReply.text ? { text: mediaReply.text } : {}),
                    ...(mediaReply.nativeFlow ? { nativeFlow: mediaReply.nativeFlow } : {}),
                    ...(mediaReply.nativeTable ? { nativeTable: mediaReply.nativeTable } : {}),
                    ...(mediaReply.richMenu ? { richMenu: mediaReply.richMenu } : {}),
                    ...(mediaReply.mentions?.length ? { mentions: mediaReply.mentions } : {}),
                  };
              try {
                await sendTrackedMessage(jid, content);
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (!mediaReply.nativeFlow) throw error;
                // nativeFlow is an optional enhancement; a rejected extension must never suppress the command reply.
                const { nativeFlow: _nativeFlow, nativeTable: _nativeTable, richMenu: _richMenu, ...plainContent } = content;
                await sendTrackedMessage(jid, plainContent).catch((fallbackError) => {
                  throw new Error(`${reason}; plain-text fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
                });
              }
            };
            if (mediaReply.media || mediaReply.text || mediaReply.nativeFlow || mediaReply.nativeTable || mediaReply.richMenu || mediaReply.mentions?.length) {
              void deliverObjectReply()
                .then(() =>
                  saveWhatsAppMessageTrace({
                    traceId: randomUUID(),
                    workspaceId,
                    sessionId,
                    ...(messageKey.id ? { messageId: messageKey.id } : {}),
                    direction: "outbound",
                    remoteJid: jid,
                    normalizedText: mediaReply.text ?? mediaReply.caption ?? "",
                    handler: "routeWhatsAppText",
                    outcome: "replied",
                    timestamp: Date.now(),
                  }).catch(() => undefined),
                )
                .catch((error) =>
                  saveWhatsAppMessageTrace({
                    traceId: randomUUID(),
                    workspaceId,
                    sessionId,
                    ...(messageKey.id ? { messageId: messageKey.id } : {}),
                    direction: "outbound",
                    remoteJid: jid,
                    normalizedText: mediaReply.text ?? mediaReply.caption ?? "",
                    handler: "routeWhatsAppText",
                    outcome: "failed",
                    failureReason: error instanceof Error ? error.message : String(error),
                    timestamp: Date.now(),
                  }).catch(() => undefined),
                );
            }
          })
          .catch((error) => {
            const reason =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[pappy-omega-mini] WhatsApp command/reply failure session=${sessionId}:`,
              reason,
            );
            void saveWhatsAppMessageTrace({
              traceId: randomUUID(),
              workspaceId,
              sessionId,
              ...(messageKey.id ? { messageId: messageKey.id } : {}),
              direction: "inbound",
              remoteJid: messageKey.remoteJid ?? "unknown",
              ...(senderJid ? { senderJid } : {}),
              normalizedText: text.slice(0, 4000),
              authorized: true,
              handler: "routeWhatsAppText",
              outcome: "failed",
              failureReason: reason.slice(0, 500),
              timestamp: Date.now(),
            }).catch(() => undefined);
          });
          },
          onDrop: () => noteError(key, "Inbound admission queue full; event dropped."),
        });
      }
    },
  );

  socket.ev.on(
    "group-participants.update",
    (update: {
      id?: string;
      participants?: string[];
      action?: string;
      author?: string;
    }) => {
      if (!isCurrentSocket()) return;
      if (update.action !== "promote" && update.action !== "demote") return;
      const participantAction: "promote" | "demote" = update.action;
      const groupJid = update.id ?? "";
      const participants = (update.participants ?? []).filter((value): value is string => typeof value === "string" && value.length > 0);
      if (!groupJid || !participants.length) return;
      void (async () => {
        const lidMapping = (socket as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } }).signalRepository?.lidMapping;
        const resolveEventIdentity = async (candidate: string): Promise<string | undefined> => {
          const mapped = candidate.endsWith("@lid") || candidate.endsWith("@hosted.lid")
            ? await lidMapping?.getPNForLID?.(candidate)
            : candidate;
          return phoneJidFromIdentity(mapped);
        };
        const resolvedParticipants = (await Promise.all(participants.map(resolveEventIdentity))).filter((value): value is string => Boolean(value));
        if (!resolvedParticipants.length) return;
        const resolvedAuthor = update.author ? await resolveEventIdentity(update.author) : undefined;
        await runAntiParticipantEvent({
          workspaceId,
          sessionId,
          groupJid,
          participants: resolvedParticipants,
          action: participantAction,
          ...(resolvedAuthor ? { author: resolvedAuthor } : {}),
        });
      })().catch((error) => {
        if (process.env.PAPPY_DEBUG_WA_ANTI === "1")
          console.warn(`[pappy-omega-mini] isolated Anti participant check failed session=${sessionId}:`, error);
      });
    },
  );

  socket.ev.on(
    "connection.update",
    (update: {
      connection?: string;
      lastDisconnect?: { error?: { output?: { statusCode?: number } } };
    }) => {
      if (!isCurrentSocket()) return;
      if (update.connection === "open") {
        console.log(
          `[pappy-omega-mini] WhatsApp authenticated open workspace=${workspaceId} session=${sessionId}`,
        );
        markConnected(key);
        staleRecoveryTriggered = false;
        startHeartbeat({
          key,
          workspaceId,
          sessionId,
          intervalMs: 10_000,
          probe: async () => {
            if (!isCurrentSocket())
              throw new Error("WhatsApp socket generation is no longer current.");
            if (socket.ws && socket.ws.isOpen === false)
              throw new Error("WhatsApp websocket is closed.");
            // A passive socket/lifecycle check is the default. Presence updates
            // are opt-in because heartbeat traffic must not become account traffic.
            if (process.env.PAPPY_WA_HEARTBEAT_SEND_PRESENCE === "1") {
              const probe = (
                socket as RuntimeSocket & {
                  sendPresenceUpdate?: (presence: string) => Promise<void>;
                }
              ).sendPresenceUpdate;
              if (typeof probe === "function") {
                await probe.call(socket, "available");
                if (socket.ws && socket.ws.isOpen === false)
                  throw new Error("WhatsApp websocket closed during heartbeat.");
                return;
              }
            }
            if (!runtimes.has(key) || runtimes.get(key)?.socket !== socket)
              throw new Error("WhatsApp socket is no longer registered.");
          },
          onFailure: (error) => {
            const reason =
              error instanceof Error ? error.message : String(error);
            noteError(key, `heartbeat: ${reason}`);
            updateSession(workspaceId, sessionId, {
              status: "DEGRADED",
              lastError: `heartbeat: ${reason}`,
            });
            try {
              socket.end(error);
            } catch {
              // The connection.update close handler owns reconnect scheduling.
            }
          },
          });
          if (stableOpenTimer) clearTimeout(stableOpenTimer);
          updateSession(workspaceId, sessionId, {
            status: "RECONNECTING",
            connectedAt: Date.now(),
            socketGeneration: getLifecycleState(key).socketGeneration,
            reconnectCount: 0,
            authHealth: "DEGRADED",
            lastError: undefined,
            disconnectReason: "transport opened; awaiting stable connection check",
            workerNodeId: process.env.HOSTNAME ?? `pid-${process.pid}`,
          });
          stableOpenTimer = setTimeout(() => {
            stableOpenTimer = undefined;
            const lifecycle = getLifecycleState(key);
            if (!isCurrentSocket() || lifecycle.stopping || socket.ws?.isOpen === false) return;
            updateSession(workspaceId, sessionId, {
              status: "ACTIVE",
              lastHealthyAt: Date.now(),
              authHealth: "VALID",
              lastError: undefined,
              disconnectReason: undefined,
            });
            const chatId = pairingNotifications.get(key);
            const selfJid = (socket as unknown as { user?: { id?: string } }).user?.id;
            if (pendingWhatsAppPairingNotice.has(key) && selfJid) {
              pendingWhatsAppPairingNotice.delete(key);
              void sendTrackedMessage(selfJid, {
                text: "✦ PAPPY OMEGA MINI · CONNECTED\\n\\nYour WhatsApp session is now connected and ready.\\n\\nStatus · ACTIVE · VALID\\nTransport · Baileys multi-device\\nAction · Commands are ready.",
              }).catch(() => undefined);
            }
            if (chatId && pairingNotifier) {
              pairingNotifications.delete(key);
              void pairingNotifier(
                chatId,
                `🟢 <b>WhatsApp Session Connected</b>\\n\\n<blockquote><b>Session:</b> <code>${sessionId.slice(0, 12)}</code>\\n<b>Status:</b> ACTIVE · VALID\\n<b>Transport:</b> Baileys multi-device\\n<b>Action:</b> Ready to receive commands</blockquote>\\n\\nOpen <b>Workload</b> or <b>Sessions</b> to manage this connection.`,
              ).catch(() => undefined);
            }
          }, 5_000);
          stableOpenTimer.unref?.();
          return;
      }
      if (update.connection !== "close") return;
      const classification = classifyDisconnect(update.lastDisconnect?.error);
      console.warn(
        `[pappy-omega-mini] WhatsApp close workspace=${workspaceId} session=${sessionId} code=${classification.code ?? "unknown"} state=${classification.status}`,
      );
      const code = classification.code;
      const terminal = classification.terminal;
      const currentRuntime = runtimes.get(key);
      if (currentRuntime?.socket !== socket) return;
      markClosed(key);
      if (stableOpenTimer) {
        clearTimeout(stableOpenTimer);
        stableOpenTimer = undefined;
      }
      runtimes.delete(key);
      const ownedLock = sessionLocks.get(key);
      sessionLocks.delete(key);
      void ownedLock?.release();
      try {
        getSession(workspaceId, sessionId);
      } catch {
        // Purge Session may have removed the registry record while the socket closed.
        return;
      }
      const authHealth = terminal ? "INVALID" : "DEGRADED";
      updateSession(workspaceId, sessionId, {
        status: classification.status,
        authHealth,
        lastReconnectAt: Date.now(),
        reconnectCount: getLifecycleState(key).reconnectAttempt,
        lastError: `transport:${code ?? "unknown"} · ${classification.label}`,
        disconnectReason: `transport:${code ?? "unknown"} · ${classification.label}. ${classification.recovery}`,
      });
      if (terminal) {
        void purgeWhatsAppSession(workspaceId, sessionId)
          .then((purged) => {
            console.warn(
              `[pappy-omega-mini] terminal session purged session=${sessionId} jobs=${purged.jobs} links=${purged.links} traces=${purged.traces}`,
            );
          })
          .catch((error) => {
            console.error(
              `[pappy-omega-mini] terminal session purge failed session=${sessionId}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
      }
      if (!terminal && classification.status !== "LOGGED_OUT" && !getLifecycleState(key).stopping) {
        scheduleReconnect({
          key,
          workspaceId,
          sessionId,
          run: () => void startWhatsAppSession(workspaceId, sessionId),
        });
      }
    },
  );

  runtimes.set(key, {
    socket,
    generation: socketGeneration,
    stop: () => socket.end(),
    flushAuth: () => authStore.flush(),
  });
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
      me?: unknown;
      account?: unknown;
      noiseKey?: unknown;
      signedIdentityKey?: unknown;
      signedPreKey?: unknown;
    };
    return (
      credentials?.registered === true ||
      typeof credentials?.me === "object" ||
      typeof credentials?.account === "object" ||
      typeof credentials?.noiseKey === "object" ||
      typeof credentials?.signedIdentityKey === "object" ||
      typeof credentials?.signedPreKey === "object" ||
      Object.keys(credentials ?? {}).length > 0
    );
  } catch (error) {
    console.warn(
      `[pappy-omega-mini] persisted WhatsApp auth unreadable session=${sessionId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export async function startWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const assigned = getSession(workspaceId, sessionId).workloadWorkerId;
  if (assigned) {
    updateSession(workspaceId, sessionId, { status: "RECONNECTING", disconnectReason: "Starting on assigned workload worker." });
    const command = await queueWorkloadCommand(workspaceId, sessionId, "session.start", {});
    await waitForWorkloadCommand(command.commandId);
    updateSession(workspaceId, sessionId, { status: "ACTIVE", authHealth: "VALID", connectedAt: Date.now(), lastHealthyAt: Date.now(), lastError: undefined, disconnectReason: undefined });
    return;
  }
  const key = lifecycleKey(workspaceId, sessionId);
  if (runtimes.has(key)) return;
  const existing = getStart(key);
  if (existing) return existing;
  const promise = openWhatsAppSession(workspaceId, sessionId);
  setStart(key, promise);
  return promise;
}

export async function restartWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  if (getSession(workspaceId, sessionId).workloadWorkerId) {
    await stopWhatsAppSession(workspaceId, sessionId);
    await startWhatsAppSession(workspaceId, sessionId);
    return waitForWhatsAppSessionReady(workspaceId, sessionId, env.WHATSAPP_READY_TIMEOUT_MS);
  }
  await stopWhatsAppSession(workspaceId, sessionId);
  resetWhatsAppSessionLifecycle(workspaceId, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await startWhatsAppSession(workspaceId, sessionId);
  return waitForWhatsAppSessionReady(
    workspaceId,
    sessionId,
    env.WHATSAPP_READY_TIMEOUT_MS,
  );
}

export async function waitForWhatsAppSessionReady(
  workspaceId: string,
  sessionId: string,
  timeoutMs = env.WHATSAPP_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = getSession(workspaceId, sessionId);
    if (session.status === "ACTIVE" && session.authHealth === "VALID")
      return true;
    if (session.status === "LOGGED_OUT" || session.authHealth === "INVALID")
      return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const session = getSession(workspaceId, sessionId);
  return session.status === "ACTIVE" && session.authHealth === "VALID";
}

export async function requestWhatsAppPairingCode(
  workspaceId: string,
  sessionId: string,
  phoneNumber: string,
  customCode = env.PAIRING_CUSTOM_CODE,
  telegramChatId?: number,
): Promise<string> {
  const assigned = getSession(workspaceId, sessionId).workloadWorkerId;
  if (assigned) {
    const result = await callAssignedWorkloadTransport(workspaceId, sessionId, "requestPairingCode", [phoneNumber.replace(/\D/g, ""), customCode]);
    const code = result && typeof result === "object" && "code" in result ? (result as { code?: unknown }).code : result;
    if (typeof code !== "string" || !code) throw new Error("Assigned workload worker did not return a pairing code.");
    updateSession(workspaceId, sessionId, { status: "PAIRING", phoneNumber: phoneNumber.replace(/\D/g, "") });
    return code;
  }
  // Startup recovery can leave an unpaired socket reconnecting. Replace it
  // before issuing a new code so the code belongs to this pairing attempt.
  const lifecycle = lifecycleKey(workspaceId, sessionId);
  pendingWhatsAppPairingNotice.add(lifecycle);
  if (telegramChatId) pairingNotifications.set(lifecycle, telegramChatId);
  await stopWhatsAppSession(workspaceId, sessionId);
  resetWhatsAppSessionLifecycle(workspaceId, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await startWhatsAppSession(workspaceId, sessionId);
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
  const session = getSession(workspaceId, sessionId);
  if (session.workloadWorkerId)
    return createAssignedWorkloadSocket(workspaceId, sessionId);
  const runtime = runtimes.get(lifecycleKey(workspaceId, sessionId));
  if (!runtime) throw new Error("WhatsApp session is not connected.");
  return runtime.socket;
}

export async function purgeWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ jobs: number; links: number; traces: number; autoPromoteConfigs: number; autoPromoteRuns: number; remoteCleanup: "CONFIRMED" | "UNREACHABLE" }> {
  const session = getSession(workspaceId, sessionId);
  let remoteCleanup: "CONFIRMED" | "UNREACHABLE" = "CONFIRMED";
  if (session.workloadWorkerId) {
    try {
      const command = await queueWorkloadCommand(workspaceId, sessionId, "session.purge", {});
      await waitForWorkloadCommand(command.commandId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no reachable workload assignment|not authorized|control timeout|did not respond|worker is/i.test(message)) throw error;
      remoteCleanup = "UNREACHABLE";
    }
    await revokeWorkloadSessionAssignment(workspaceId, sessionId, remoteCleanup === "CONFIRMED" ? "Session purged remotely." : "Session purged centrally; panel was unreachable.");
  } else {
    await stopWhatsAppSession(workspaceId, sessionId);
  }
  const [{ purgeRuntimeSessionData }, { purgeWhatsAppSessionTraces }] =
    await Promise.all([
      import("../jobs/runtime.js"),
      import("../persistence/mongo.js"),
    ]);
  await rm(join(env.SESSION_ROOT, workspaceId, sessionId), {
    recursive: true,
    force: true,
  });
  resetWhatsAppSessionLifecycle(workspaceId, sessionId);
  // Remove the registry record before Auto Promote reconciliation so the
  // scheduler cannot observe this session as ACTIVE and recreate a run.
  await deleteSession(workspaceId, sessionId);
  const runtimeData = await purgeRuntimeSessionData(workspaceId, sessionId);
  const traces = await purgeWhatsAppSessionTraces(workspaceId, sessionId);
  return { ...runtimeData, traces, remoteCleanup };
}

export async function stopWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const assigned = getSession(workspaceId, sessionId).workloadWorkerId;
  if (assigned) {
    const command = await queueWorkloadCommand(workspaceId, sessionId, "session.stop", {});
    await waitForWorkloadCommand(command.commandId);
    updateSession(workspaceId, sessionId, { status: "DEGRADED", disconnectReason: "Stopped on assigned workload worker." });
    return;
  }
  const key = lifecycleKey(workspaceId, sessionId);
  markStopping(key);
  const runtime = runtimes.get(key);
  if (runtime) {
    runtime.stop();
    runtimes.delete(key);
    await runtime.flushAuth().catch(() => undefined);
  }
  const ownedLock = sessionLocks.get(key);
  sessionLocks.delete(key);
  void ownedLock?.release();
  updateSession(workspaceId, sessionId, {
    status: "DEGRADED",
    disconnectReason: "stopped by owner",
  });
}

export async function shutdownWhatsAppSessions(): Promise<void> {
  stopAllLifecycles();
  const flushes: Promise<void>[] = [];
  for (const runtime of runtimes.values()) {
    runtime.stop();
    flushes.push(runtime.flushAuth().catch(() => undefined));
  }
  runtimes.clear();
  for (const lock of sessionLocks.values()) void lock.release();
  sessionLocks.clear();
  await Promise.allSettled(flushes);
  await closeSessionLockRedis();
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
