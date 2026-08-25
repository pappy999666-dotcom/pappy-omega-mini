import {
  executeCommand,
  createCommandRegistry,
  type EnqueueJobResult,
  type EnqueueJoinJobResult,
} from "./command-registry.js";
import {
  createSession,
  getSession,
  getSessionJoinSettings,
  getWorkspaceDefaults,
  getWorkspaceOwnerTelegramUserId,
  getWorkspaceSudo,
} from "../core/session-registry.js";
import { createHash } from "node:crypto";
import { getEmergencyState } from "../core/control-plane.js";
import { isWorkerProcess } from "../config/env.js";
import { isPanelAssignedSession } from "./workload-transport.js";

const BROADCAST_INVENTORY_ACK_TIMEOUT_MS = 4_000;
import { persistJobMedia } from "./job-media-store.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import type { GroupControlTable } from "./group-control-confirmation.js";
import { getWorkerRuntime } from "../jobs/runtime.js";
import { requestWhatsAppPairingCode } from "./session-manager.js";
import {
  listGroups,
  sendGroupMentions,
  sendGroupStatus,
  sendGroupColorStatus,
  sendPersonalStatus,
  sendGroupText,
  sendDirectText,
  sendGroupPoll,
} from "./transport-adapter.js";
import {
  buildWhatsappHelpPayload,
  buildWhatsappMenuPayload,
  buildWhatsappTextMenuPayload,
} from "../menus/whatsapp-menu.js";
import { resolveMenuInteraction, resolveMenuViewInteraction, type RichMenuContent } from "../menus/rich-menu-runtime.js";
import {
  routeViaRemoteBridge,
  shouldProxyWhatsAppSession,
} from "./remote-bridge.js";
import {
  buildStickerCommandInput,
  getStickerCommandBinding,
  stickerBindingMatches,
} from "./sticker-command-bindings.js";

const registry = createCommandRegistry();
const recentStickerTriggers = new Map<string, number>();
const STICKER_TRIGGER_DEDUPE_MS = 30_000;

function acceptStickerTrigger(message: IncomingTextMessage): boolean {
  if (!message.messageId || !message.stickerFingerprint) return true;
  const now = Date.now();
  for (const [key, expiresAt] of recentStickerTriggers) if (expiresAt <= now) recentStickerTriggers.delete(key);
  const key = `${message.workspaceId}:${message.sessionId}:${message.messageId}:${message.stickerFingerprint}`;
  if ((recentStickerTriggers.get(key) ?? 0) > now) return false;
  recentStickerTriggers.set(key, now + STICKER_TRIGGER_DEDUPE_MS);
  return true;
}

export interface IncomingTextMessage {
  workspaceId: string;
  sessionId: string;
  messageId?: string;
  receivedAt?: number;
  senderJid: string;
  quotedSenderJid?: string;
  quotedMessageKey?: Record<string, unknown>;
  quotedStickerFingerprint?: string;
  stickerFingerprint?: string;
  mentionedJids?: string[];
  chatJid?: string;
  text: string;
  quotedText?: string;
  media?: WhatsAppMediaPayload;
  bridgeAuthorized?: boolean;
  fromMe?: boolean;
  interactionId?: string;
  /** Native rich-menu display text used when a client omits the callback ID. */
  interactionDisplayText?: string;
}
export interface WhatsAppReply {
  text?: string;
  mentions?: string[];
  nativeFlow?: Array<{ text: string; copy?: string; id?: string; url?: string }>;
  nativeTable?: GroupControlTable;
  richMenu?: RichMenuContent;
  media?: WhatsAppMediaPayload;
  caption?: string;
}

function normalizeIdentity(value: string): string {
  const local = value.trim().toLowerCase().split("@")[0] ?? "";
  const withoutDevice = local.split(":")[0] ?? local;
  return withoutDevice.replace(/\D/g, "");
}
function identityMatches(left: string, right: string): boolean {
  return left === right || normalizeIdentity(left) === normalizeIdentity(right);
}

const SELF_EXECUTABLE_COMMANDS = new Set([
  "ping", "health", "profile", "help", "menu", "menulist",
  "gstatus", "gstatusd", "dgstatus", "gstatusx", "tag", "stag", "pstatus", "setcmd", "flushcmd",
]);

export function isSelfExecutableWhatsAppCommand(text: string, prefix = ""): boolean {
  const trimmed = text.trim();
  const body = prefix && trimmed.startsWith(prefix)
    ? trimmed.slice(prefix.length).trim()
    : trimmed.startsWith(".")
      ? trimmed.slice(1).trim()
      : trimmed;
  const command = body.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return SELF_EXECUTABLE_COMMANDS.has(command);
}

function isOwnerFor(
  message: IncomingTextMessage,
  session: ReturnType<typeof getSession>,
  nativeInteraction = false,
): boolean {
  return (
    (!nativeInteraction && message.fromMe === true) ||
    message.bridgeAuthorized === true ||
    identityMatches(message.senderJid, session.phoneNumber ?? "") ||
    session.sudoList.some((identity) =>
      identityMatches(message.senderJid, identity),
    ) ||
    getWorkspaceSudo(session.workspaceId).some((identity) =>
      identityMatches(message.senderJid, identity),
    )
  );
}

export function mergeQuotedPayload(text: string, quotedText?: string): string {
  const primary = text.trim();
  const quoted = quotedText?.trim() ?? "";
  return primary ? [primary, quoted].filter(Boolean).join("\n") : quotedText ?? "";
}

export async function routeWhatsAppText(
  message: IncomingTextMessage,
): Promise<string | WhatsAppReply | null> {
  const textCommandInput = mergeQuotedPayload(message.text, message.quotedText);
  const interactionId = message.interactionId?.trim();
  const interactionDisplayText = message.interactionDisplayText?.trim();
  const interactionValue = interactionId || interactionDisplayText;
  if (shouldProxyWhatsAppSession(message.workspaceId, message.sessionId))
    return routeViaRemoteBridge(message);
  const session = getSession(message.workspaceId, message.sessionId);
  const binding = message.stickerFingerprint
    ? getStickerCommandBinding(message.workspaceId, message.sessionId)
    : undefined;
  const stickerCommandInput = binding && stickerBindingMatches(binding, message.stickerFingerprint)
    ? buildStickerCommandInput(binding, message.quotedText, message.text)
    : undefined;
  const commandInput = stickerCommandInput || textCommandInput;
  const stickerTrigger = Boolean(stickerCommandInput);
  const interactionContext = { workspaceId: message.workspaceId, sessionId: message.sessionId, prefix: session.prefix, allowCommandText: true };
  const menuAction = interactionValue ? resolveMenuInteraction(interactionValue, interactionContext) : undefined;
  const viewAction = menuAction?.view
    ? menuAction
    : !interactionValue
      ? resolveMenuViewInteraction(commandInput.trim(), interactionContext)
      : undefined;
  const looksLikeExpiredNativeMenuId = Boolean(interactionValue && /^(?:ui:menu:|cmd:)/i.test(interactionValue) && !menuAction);
  if (looksLikeExpiredNativeMenuId) return null;
  const trimmed = menuAction?.command || (viewAction?.view ? "menu" : interactionValue || commandInput.trim());
  if (
    getEmergencyState().enabled &&
    /^(?:[^\w\s]{1,3})?(?:menu|help|m)(?:\s|$)/i.test(trimmed)
  )
    return null;
  const prefix = session.prefix;
  const selfAuthoredText = message.fromMe === true && !interactionValue && !stickerTrigger && isSelfExecutableWhatsAppCommand(textCommandInput, prefix);
  // Telegram Bridge and a message authored by this authenticated WhatsApp
  // identity are already trusted control-plane inputs. Native button clicks
  // remain separately sender-authorized below.
  if (stickerTrigger && !isOwnerFor(message, session)) return null;
  if (stickerTrigger && !acceptStickerTrigger(message)) return null;
  if (!interactionValue && !menuAction && !viewAction && !stickerTrigger && !message.bridgeAuthorized && !selfAuthoredText && prefix && !trimmed.startsWith(prefix)) return null;
  const raw = stickerTrigger
    ? stickerCommandInput as string
    : menuAction?.command || menuAction?.view || viewAction?.view
    ? trimmed
    : interactionValue
    ? trimmed
    : message.bridgeAuthorized || selfAuthoredText
    ? prefix && trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length)
      : trimmed.startsWith(".")
        ? trimmed.slice(1)
        : trimmed
    : prefix
      ? trimmed.slice(prefix.length)
      : trimmed;
  if (!raw.trim()) return null;

  const commandName = raw.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const isNativeInteraction = Boolean(interactionValue);
  const isOwner = isOwnerFor(message, session, isNativeInteraction);
  if (viewAction?.view) {
    if (!isOwner) return null;
    const payload = await buildWhatsappMenuPayload(session, isOwner, viewAction.view);
    return payload.media
      ? { media: payload.media, caption: payload.caption, richMenu: payload.richMenu }
      : { text: payload.text, richMenu: payload.richMenu };
  }
  // WhatsApp is a private command surface: public and unauthorized senders
  // receive no reply and cannot open the menu. `fromMe` is the transport-level
  // proof that this was sent by the authenticated account itself, even when
  // Baileys exposes its LID rather than its phone JID.
  if (!isOwner) {
    if (process.env.PAPPY_DEBUG_WA_COMMANDS === "1")
      console.info(
        `[pappy-omega-mini] WhatsApp command unauthorized session=${message.sessionId} sender=${message.senderJid} command=${commandName}`,
      );
    return null;
  }
  if (commandName === "help") {
    if (getEmergencyState().enabled) return null;
    return buildWhatsappHelpPayload(session, isOwnerFor(message, session));
  }
  if (commandName === "menulist") {
    if (getEmergencyState().enabled) return null;
    const mode = raw.trim().split(/\s+/)[1]?.toLowerCase() || "rich";
    if (mode === "text") return buildWhatsappTextMenuPayload(session, isOwnerFor(message, session));
    if (mode !== "rich") return { text: "Usage: .menulist rich or .menulist text" };
    const payload = await buildWhatsappMenuPayload(session, isOwnerFor(message, session), "all");
    return payload.media
      ? { media: payload.media, caption: payload.caption, richMenu: payload.richMenu }
      : { text: payload.text, richMenu: payload.richMenu };
  }
  if (commandName === "menu" || commandName === "m") {
    if (getEmergencyState().enabled) return null;
    const ttlToken = raw.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    const ttlMatch = /^(\d{1,3})(s|sec|secs|m|min|mins)?$/i.exec(ttlToken);
    const ttlValue = ttlMatch ? Number(ttlMatch[1]) * (/^m/i.test(ttlMatch[2] ?? "") ? 60 : 1) : undefined;
    const ttlSeconds = ttlValue && Number.isFinite(ttlValue) ? Math.max(5, Math.min(300, ttlValue)) : undefined;
    const payload = await buildWhatsappMenuPayload(session, isOwnerFor(message, session, isNativeInteraction), menuAction?.view || "root", { ...(ttlSeconds ? { ttlSeconds } : {}) });
    return payload.media
      ? { media: payload.media, caption: payload.caption, richMenu: payload.richMenu }
      : { text: payload.text, richMenu: payload.richMenu };
  }

  const runtime = getWorkerRuntime();
  const commandContext = {
    workspaceId: message.workspaceId,
    sessionId: message.sessionId,
    ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
    isOwner,
    senderJid: message.senderJid,
    ...(message.quotedSenderJid ? { quotedSenderJid: message.quotedSenderJid } : {}),
    ...(message.quotedMessageKey ? { quotedMessageKey: message.quotedMessageKey } : {}),
    ...(message.quotedStickerFingerprint ? { quotedStickerFingerprint: message.quotedStickerFingerprint } : {}),
    ...(message.stickerFingerprint ? { stickerFingerprint: message.stickerFingerprint } : {}),
    ...(message.quotedText ? { quotedText: message.quotedText } : {}),
    ...(message.mentionedJids?.length ? { mentionedJids: message.mentionedJids } : {}),
    ...(message.chatJid ? { chatJid: message.chatJid } : {}),
    ...(message.media ? { media: message.media } : {}),
    args: [],
    pairSession: async ({ label, phoneNumber }: { label: string; phoneNumber: string }) => {
      const paired = createSession({
        workspaceId: message.workspaceId,
        sessionName: label,
        phoneNumber,
      });
      const ownerTelegramId = getWorkspaceOwnerTelegramUserId(
        message.workspaceId,
      );
      const telegramChatId = ownerTelegramId ? Number(ownerTelegramId) : undefined;
      const code = await requestWhatsAppPairingCode(
        message.workspaceId,
        paired.sessionId,
        phoneNumber,
        undefined,
        Number.isFinite(telegramChatId) ? telegramChatId : undefined,
      );
      return {
        sessionName: paired.sessionName,
        phoneNumber: phoneNumber.replace(/\D/g, ""),
        code,
      };
    },
    ...(runtime
      ? {
          enqueueJoinJob: async ({ payload }: { payload: Record<string, unknown> }) => {
            if (session.status !== "ACTIVE")
              return `\u26d4 Join Manager not started: WhatsApp session is ${session.status.toLowerCase()}, not ACTIVE.`;
            const settings = getSessionJoinSettings(message.workspaceId, message.sessionId);
            const existing = (await runtime.listAllJobs()).find(
              (candidate) =>
                candidate.workspaceId === message.workspaceId &&
                candidate.sessionId === message.sessionId &&
                candidate.kind === "join-manager" &&
                ["QUEUED", "RUNNING", "PAUSED", "RETRYING", "CANCELLING"].includes(candidate.state),
            );
            if (existing)
              return {
                jobCode: existing.jobCode ?? existing.jobId.slice(0, 8),
                targetCount: Number(existing.payload.targetCount ?? settings.targetCount),
                delayMs: Number(existing.payload.delayMs ?? settings.delayMs),
                expectedTimeMs: Math.max(0, Number(existing.payload.targetCount ?? settings.targetCount) - 1) * Number(existing.payload.delayMs ?? settings.delayMs),
              } satisfies EnqueueJoinJobResult;
            const targetCount = Math.max(1, Math.min(10000, Number(payload.targetCount ?? settings.targetCount)));
            const delayMs = Math.max(0, Math.min(600000, Number(payload.delayMs ?? settings.delayMs)));
            const record = await runtime.enqueue({
              workspaceId: message.workspaceId,
              sessionId: message.sessionId,
              kind: "join-manager",
              payload: {
                ...payload,
                targetCount,
                delayMs,
                minDelayMs: payload.minDelayMs ?? settings.minDelayMs,
                maxDelayMs: payload.maxDelayMs ?? settings.maxDelayMs,
                retryLimit: payload.retryLimit ?? settings.retryLimit,
                retryBaseMs: payload.retryBaseMs ?? settings.retryBaseMs,
                sessionCooldownMs: payload.sessionCooldownMs ?? settings.sessionCooldownMs,
                restrictionThreshold: Math.min(5, Number(payload.restrictionThreshold ?? settings.restrictionThreshold)),
                requestMode: payload.requestMode ?? settings.mode,
                sourceBucket: "active",
              },
              idempotencyKey: `${message.workspaceId}:${message.sessionId}:join-manager:${Date.now()}:${createHash("sha1").update(JSON.stringify(payload)).digest("hex")}`,
            });
            return {
              jobCode: record.jobCode ?? record.jobId.slice(0, 8),
              targetCount,
              delayMs,
              expectedTimeMs: Math.max(0, targetCount - 1) * delayMs,
            } satisfies EnqueueJoinJobResult;
          },
          enqueueGroupControlJob: async ({
            groupJid,
            operation,
            participants,
            participantAction,
          }: {
            groupJid: string;
            operation: "approve" | "reject" | "participant";
            participants: string[];
            participantAction?: "promote" | "demote" | "remove" | "block" | "demote-remove";
          }) => {
            const payload = {
              groupJid,
              operation,
              participants: [...new Set(participants)].slice(0, 1_000),
              ...(participantAction ? { participantAction } : {}),
            };
            const payloadHash = createHash("sha256")
              .update(JSON.stringify(payload))
              .digest("hex");
            const record = await runtime.enqueue({
              workspaceId: message.workspaceId,
              sessionId: message.sessionId,
              kind: "group-control",
              payload,
              idempotencyKey: `${message.workspaceId}:${message.sessionId}:group-control:${operation}:${message.messageId ?? payloadHash}`,
              maxAttempts: 5,
            });
            return {
              jobCode: record.jobCode ?? record.jobId.slice(0, 8),
            };
          },
          enqueuePlayJob: async ({ query, mode, sourceChatJid }: { query: string; mode: "audio" | "video"; sourceChatJid: string }) => {
            const payload = { query, mode, sourceChatJid };
            const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
            const record = await runtime.enqueue({
              workspaceId: message.workspaceId,
              sessionId: message.sessionId,
              kind: "play-download",
              payload,
              idempotencyKey: `${message.workspaceId}:${message.sessionId}:play-download:${message.messageId ?? payloadHash}`,
              maxAttempts: 2,
            });
            return record.jobCode ?? record.jobId.slice(0, 8);
          },
          enqueueJob: async ({
            kind,
            payload,
          }: {
            kind: "gstatus" | "allstatus" | "allchat" | "tag";

            payload: Record<string, unknown>;
          }) => {
            const groups =
              kind === "gstatus"
                ? message.chatJid
                  ? [{ jid: message.chatJid }]
                  : []
                : [];
            const mediaReference = message.media
              ? await persistJobMedia({
                  workspaceId: message.workspaceId,
                  kind: message.media.kind,
                  bytes: message.media.bytes,
                  ...(message.media.mimeType
                    ? { mimeType: message.media.mimeType }
                    : {}),
                  ...(message.media.fileName
                    ? { fileName: message.media.fileName }
                    : {}),
                  ...(message.media.ptt !== undefined
                    ? { ptt: message.media.ptt }
                    : {}),
                })
              : undefined;
            const broadcastDelayMs = getWorkspaceDefaults(
              message.workspaceId,
            ).defaultBroadcastDelayMs;
            const panelBroadcast =
              !isWorkerProcess &&
              (kind === "allstatus" || kind === "allchat") &&
              isPanelAssignedSession(message.workspaceId, message.sessionId);
            // Never block the command acknowledgement on a full group scan.
            // Broadcast workers resolve their own inventory after the durable job
            // is created, so the command can dispatch immediately and report
            // progress truthfully while inventory is loading.
            const resolvedGroups: string[] = panelBroadcast
              ? []
              : Array.isArray(payload.groups)
                ? payload.groups.filter((value): value is string => typeof value === "string")
                : kind === "gstatus"
                  ? groups.map((group) => group.jid)
                  : [];
            const enrichedPayload = {
              ...payload,
              ...(kind === "allstatus" || kind === "allchat"
                ? {
                    delayMs:
                      typeof payload.delayMs === "number"
                        ? payload.delayMs
                        : broadcastDelayMs,
                  }
                : {}),
              ...(panelBroadcast
                ? { workerLocal: true }
                : { groups: resolvedGroups, inventoryDeferred: kind === "allstatus" || kind === "allchat" }),
              ...(mediaReference ? { media: mediaReference } : {}),
              ...(kind === "allstatus" || kind === "allchat"
                ? message.chatJid && !message.bridgeAuthorized
                  ? {
                      sourceChatJid: message.chatJid,
                      sourceSenderJid: message.senderJid,
                      sourceTransport: "whatsapp" as const,
                    }
                  : {}
                : {}),
            };
            const payloadHash = createHash("sha256")
              .update(JSON.stringify(enrichedPayload))
              .digest("hex");
            const recordPromise = runtime.enqueue({
              workspaceId: message.workspaceId,
              sessionId: message.sessionId,
              kind,
              payload: enrichedPayload,
              idempotencyKey: `${message.workspaceId}:${message.sessionId}:${kind}:${message.messageId ?? payloadHash}`,
              ...(kind === "allstatus" || kind === "allchat" ? { maxAttempts: 12 } : {}),
            });
            const record = await recordPromise;
            const totalGroups = resolvedGroups.length;
            const repeat = Math.max(
              1,
              Math.min(20, Number((payload as { count?: unknown }).count ?? 1)),
            );
            const delayMs = Number(enrichedPayload.delayMs ?? 10000);
            return {
              jobCode: record.jobCode ?? record.jobId.slice(0, 8),
              ...(totalGroups > 0 ? { totalGroups } : {}),
              ...(totalGroups > 0 ? { totalPosts: totalGroups * repeat } : {}),
              delayMs,
              ...(totalGroups > 0
                ? { expectedTimeMs: Math.max(0, totalGroups * repeat - 1) * delayMs }
                : {}),
              ...(panelBroadcast ? { workerLocal: true } : {}),
              ...(kind === "allstatus" || kind === "allchat" ? { inventoryDeferred: panelBroadcast ? false : true } : {}),

            } satisfies EnqueueJobResult;
          },
        }
      : {}),
    sendCurrentPersonalStatus: async ({ text }: { text: string }) => {
      await sendPersonalStatus(
        message.workspaceId,
        message.sessionId,
        { text, ...(message.media ? { media: message.media } : {}) },
      );
    },
    sendCurrentGroupPoll: async ({ question, options }: { question: string; options: string[] }) => {
      if (!message.chatJid || !message.chatJid.endsWith("@g.us"))
        throw new Error("This command must be used inside a WhatsApp group.");
      await sendGroupPoll(message.workspaceId, message.sessionId, message.chatJid, question, options);
    },
    sendCurrentGroupHidetag: async ({
      text,
      participantCount,
    }: {
      text: string;
      participantCount?: number;
    }) => {
      if (!message.chatJid || !message.chatJid.endsWith("@g.us"))
        throw new Error("This command must be used inside a WhatsApp group.");
      await sendGroupMentions(
        message.workspaceId,
        message.sessionId,
        message.chatJid,
        text,
        participantCount,
        message.media,
      );
    },
    sendCurrentGroupStatus: async ({
      text,
      repeat,
    }: {
      text: string;
      repeat: number;
    }) => {
      if (!message.chatJid || !message.chatJid.endsWith("@g.us"))
        throw new Error("This command must be used inside a WhatsApp group.");
      for (let index = 0; index < repeat; index += 1) {
        if (index > 0)
          await new Promise((resolve) => setTimeout(resolve, 1500));
        await sendGroupStatus(
          message.workspaceId,
          message.sessionId,
          message.chatJid,
          { text, ...(message.media ? { media: message.media } : {}) },
        );
      }
    },
    sendCurrentColorGroupStatus: async ({
      text,
      repeat,
    }: {
      text: string;
      repeat: number;
    }) => {
      if (!message.chatJid || !message.chatJid.endsWith("@g.us"))
        throw new Error("This command must be used inside a WhatsApp group.");
      for (let index = 0; index < repeat; index += 1) {
        if (index > 0)
          await new Promise((resolve) => setTimeout(resolve, 1500));
        await sendGroupColorStatus(
          message.workspaceId,
          message.sessionId,
          message.chatJid,
          { text, ...(message.media ? { media: message.media } : {}) },
        );
      }
    },
    sendCurrentText: async (text: string) => {
      if (!message.chatJid) throw new Error("The current WhatsApp chat could not be resolved.");
      if (message.chatJid.endsWith("@g.us")) {
        await sendGroupText(message.workspaceId, message.sessionId, message.chatJid, text);
      } else {
        await sendDirectText(message.workspaceId, message.sessionId, message.chatJid, text);
      }
    },
    ...(runtime
      ? {
          cancelJobs: async (
            kind: "gstatus" | "allstatus" | "allchat" | "tag" | "join-manager",
          ) => {
            const jobs = await runtime.listRecent(100);
            const active = jobs.filter(
              (job) =>
                job.workspaceId === message.workspaceId &&
                job.sessionId === message.sessionId &&
                job.kind === kind &&
                ["QUEUED", "RUNNING", "PAUSED", "RETRYING"].includes(job.state),
            );
            await Promise.all(active.map((job) => runtime.cancel(job.jobId)));
            return active.length;
          },
        }
      : {}),
  };
  const response = await executeCommand(registry, raw, commandContext);
  if (typeof response !== "string") return response;
  if (response.startsWith("Unknown command.")) return null;
  const liveCode = response.match(/Live code\s*[·:]\s*([A-Z0-9]{8})/i)?.[1];
  const pairingCode = response.match(/(?:^|\n)\s*Code\s*[·:]\s*([A-Z0-9]{8})/i)?.[1];
  const copyCode = liveCode ?? pairingCode;
  return copyCode
    ? {
        text: response,
        nativeFlow: [{
          text: pairingCode ? "📋 Copy pairing code" : "📋 Copy live code",
          copy: copyCode,
        }],
      }
    : response;
}
