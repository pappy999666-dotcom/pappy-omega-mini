import {
  executeCommand,
  createCommandRegistry,
  type EnqueueJobResult,
} from "./command-registry.js";
import {
  createSession,
  getSession,
  getWorkspaceDefaults,
  getWorkspaceOwnerTelegramUserId,
  getWorkspaceSudo,
} from "../core/session-registry.js";
import { createHash } from "node:crypto";
import { persistJobMedia } from "./job-media-store.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import { getWorkerRuntime } from "../jobs/runtime.js";
import { requestWhatsAppPairingCode } from "./session-manager.js";
import {
  listGroups,
  sendGroupMentions,
  sendGroupStatus,
} from "./transport-adapter.js";
import { buildWhatsappMenuPayload } from "../menus/whatsapp-menu.js";

const registry = createCommandRegistry();

export interface IncomingTextMessage {
  workspaceId: string;
  sessionId: string;
  senderJid: string;
  chatJid?: string;
  text: string;
  quotedText?: string;
  media?: WhatsAppMediaPayload;
  bridgeAuthorized?: boolean;
  fromMe?: boolean;
}
export interface WhatsAppReply {
  text?: string;
  media?: {
    kind: "image" | "video";
    bytes: Buffer;
    mimeType: string;
    fileName: string;
  };
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
function isOwnerFor(
  message: IncomingTextMessage,
  session: ReturnType<typeof getSession>,
): boolean {
  return (
    message.fromMe === true ||
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
  const session = getSession(message.workspaceId, message.sessionId);
  const commandInput = mergeQuotedPayload(message.text, message.quotedText);
  const trimmed = commandInput.trim();
  const prefix = session.prefix;
  if (prefix && !trimmed.startsWith(prefix)) return null;
  const raw = prefix ? trimmed.slice(prefix.length) : trimmed;
  if (!raw.trim()) return null;

  const commandName = raw.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const isOwner = isOwnerFor(message, session);
  // WhatsApp is a private command surface: public and unauthorized senders
  // receive no reply and cannot open the menu. `fromMe` is the transport-level
  // proof that this was sent by the authenticated account itself, even when
  // Baileys exposes its LID rather than its phone JID.
  if (!isOwner) {
    console.info(
      `[pappy-omega-mini] WhatsApp command unauthorized session=${message.sessionId} sender=${message.senderJid} command=${commandName}`,
    );
    return null;
  }
  if (commandName === "menu" || commandName === "help" || commandName === "m") {
    const payload = await buildWhatsappMenuPayload(
      session,
      isOwnerFor(message, session),
    );
    return payload.media
      ? { media: payload.media, caption: payload.caption }
      : { text: payload.text };
  }

  const runtime = getWorkerRuntime();
  const commandContext = {
    workspaceId: message.workspaceId,
    sessionId: message.sessionId,
    isOwner,
    senderJid: message.senderJid,
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
              groups: payload.groups ?? groups.map((group) => group.jid),
              ...(kind === "allstatus" || kind === "allchat"
                ? message.chatJid
                  ? { originJid: message.chatJid }
                  : {}
                : {}),
              ...(mediaReference ? { media: mediaReference } : {}),
            };
            const payloadHash = createHash("sha256")
              .update(JSON.stringify(enrichedPayload))
              .digest("hex");
            const record = await runtime.enqueue({
              workspaceId: message.workspaceId,
              sessionId: message.sessionId,
              kind,
              payload: enrichedPayload,
              idempotencyKey: `${message.workspaceId}:${message.sessionId}:${kind}:${payloadHash}`,
            });
            const totalGroups = groups.length;
            const repeat = Math.max(
              1,
              Math.min(20, Number((payload as { count?: unknown }).count ?? 1)),
            );
            const delayMs = Number(enrichedPayload.delayMs ?? 20000);
            return {
              jobCode: record.jobCode ?? record.jobId.slice(0, 8),
              ...(totalGroups > 0 ? { totalGroups } : {}),
              ...(totalGroups > 0 ? { totalPosts: totalGroups * repeat } : {}),
              delayMs,
              ...(totalGroups > 0
                ? { expectedTimeMs: Math.max(0, totalGroups * repeat - 1) * delayMs }
                : {}),
            } satisfies EnqueueJobResult;
          },
        }
      : {}),
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
    ...(runtime
      ? {
          cancelJobs: async (
            kind: "gstatus" | "allstatus" | "allchat" | "tag",
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
  return response.startsWith("Unknown command.") ? null : response;
}
