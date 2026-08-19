import { executeCommand, createCommandRegistry } from "./command-registry.js";
import { getSession, getWorkspaceSudo } from "../core/session-registry.js";
import { createHash } from "node:crypto";
import { getWorkerRuntime } from "../jobs/runtime.js";
import {
  listGroups,
  sendGroupHidetag,
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
  media?: { kind: "image" | "video"; bytes: Buffer; mimeType?: string };
  bridgeAuthorized?: boolean;
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

export async function routeWhatsAppText(
  message: IncomingTextMessage,
): Promise<string | WhatsAppReply | null> {
  const session = getSession(message.workspaceId, message.sessionId);
  const source =
    message.quotedText && !message.text.trim()
      ? message.quotedText
      : message.text;
  const trimmed = source.trim();
  const prefix = session.prefix;
  if (prefix && !trimmed.startsWith(prefix)) return null;
  const raw = prefix ? trimmed.slice(prefix.length) : trimmed;
  if (!raw.trim()) return null;

  const commandName = raw.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const isOwner = isOwnerFor(message, session);
  // WhatsApp is a private command surface: public and unauthorized senders
  // receive no reply and cannot open the menu.
  if (!isOwner) return null;
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
                : await listGroups(message.workspaceId, message.sessionId);
            const enrichedPayload = {
              ...payload,
              groups: payload.groups ?? groups.map((group) => group.jid),
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
            if (kind === "allstatus")
              await runtime.waitForStarted(record.jobId);
            return record.jobCode ?? record.jobId;
          },
        }
      : {}),
    sendCurrentGroupHidetag: async (text: string) => {
      if (!message.chatJid || !message.chatJid.endsWith("@g.us"))
        throw new Error("This command must be used inside a WhatsApp group.");
      await sendGroupHidetag(
        message.workspaceId,
        message.sessionId,
        message.chatJid,
        text,
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
          { text },
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
