import { executeCommand, createCommandRegistry } from "./command-registry.js";
import { getSession } from "../core/session-registry.js";
import { createHash } from "node:crypto";
import { getWorkerRuntime } from "../jobs/runtime.js";
import { listGroups } from "./transport-adapter.js";

const registry = createCommandRegistry();

export interface IncomingTextMessage {
  workspaceId: string;
  sessionId: string;
  senderJid: string;
  text: string;
  quotedText?: string;
}

export async function routeWhatsAppText(
  message: IncomingTextMessage,
): Promise<string | null> {
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

  const isOwner =
    message.senderJid === session.phoneNumber ||
    session.sudoList.includes(message.senderJid);
  const runtime = getWorkerRuntime();
  const commandContext = {
    workspaceId: message.workspaceId,
    sessionId: message.sessionId,
    isOwner,
    args: [],
    ...(runtime
      ? {
          enqueueJob: async ({
            kind,
            payload,
          }: {
            kind: "allstatus" | "allchat" | "tag";
            payload: Record<string, unknown>;
          }) => {
            const groups = await listGroups(
              message.workspaceId,
              message.sessionId,
            );
            const enrichedPayload = {
              ...payload,
              groups: groups.map((group) => group.jid),
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
            return record.jobId;
          },
        }
      : {}),
    ...(runtime
      ? {
          cancelJobs: async (kind: "allstatus" | "allchat" | "tag") => {
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
  return executeCommand(registry, raw, commandContext);
}
