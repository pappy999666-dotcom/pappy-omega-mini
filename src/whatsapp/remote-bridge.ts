import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { env, isWorkerProcess, workerSessionIds } from "../config/env.js";
import { getSession } from "../core/session-registry.js";
import { attachRedisErrorHandler } from "../core/redis-events.js";
import type { IncomingTextMessage, WhatsAppReply } from "./message-router.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";

const REQUEST_CHANNEL = "pappy-omega-mini:bridge-rpc:requests";
const RESPONSE_PREFIX = "pappy-omega-mini:bridge-rpc:response:";
const RESPONSE_TTL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 35_000;

type BridgeResult = string | WhatsAppReply | null;
type BridgeHandler = (message: IncomingTextMessage) => Promise<BridgeResult>;
type SerializedMedia = Omit<WhatsAppMediaPayload, "bytes"> & { bytes: string };
type SerializedMessage = Omit<IncomingTextMessage, "media"> & { media?: SerializedMedia };
type SerializedReplyMedia = Omit<NonNullable<WhatsAppReply["media"]>, "bytes"> & { bytes: string };
type SerializedReply = Omit<WhatsAppReply, "media"> & { media?: SerializedReplyMedia };

let publisher: Redis | undefined;
let subscriber: Redis | undefined;
let responderStarted = false;

function redisConnection(): Redis {
  return attachRedisErrorHandler(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    "remote-bridge",
  );
}

function serializeMedia(media: WhatsAppMediaPayload): SerializedMedia {
  return {
    kind: media.kind,
    bytes: media.bytes.toString("base64"),
    ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
    ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
    ...(media.caption !== undefined ? { caption: media.caption } : {}),
    ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
  };
}

function deserializeMedia(media: SerializedMedia): WhatsAppMediaPayload {
  return {
    kind: media.kind,
    bytes: Buffer.from(media.bytes, "base64"),
    ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
    ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
    ...(media.caption !== undefined ? { caption: media.caption } : {}),
    ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
  };
}

function serializeMessage(message: IncomingTextMessage): SerializedMessage {
  const { media, ...rest } = message;
  return media ? { ...rest, media: serializeMedia(media) } : rest;
}

function deserializeMessage(message: SerializedMessage): IncomingTextMessage {
  const { media, ...rest } = message;
  return media ? { ...rest, media: deserializeMedia(media) } : rest;
}

function serializeReply(reply: BridgeResult): SerializedReply | string | null {
  if (!reply || typeof reply === "string") return reply;
  const { media, ...rest } = reply;
  return media
    ? {
        ...rest,
        media: {
          kind: media.kind,
          bytes: media.bytes.toString("base64"),
          mimeType: media.mimeType,
          fileName: media.fileName,
        },
      }
    : rest;
}

function deserializeReply(reply: SerializedReply | string | null): BridgeResult {
  if (!reply || typeof reply === "string") return reply;
  const { media, ...rest } = reply;
  return media
    ? {
        ...rest,
        media: {
          kind: media.kind,
          bytes: Buffer.from(media.bytes, "base64"),
          mimeType: media.mimeType,
          fileName: media.fileName,
        },
      }
    : rest;
}

export function shouldProxyWhatsAppSession(
  workspaceId: string,
  sessionId: string,
): boolean {
  if (isWorkerProcess || !sessionId || !workerSessionIds.has(sessionId)) return false;
  try {
    // External panel assignments are handled by the control-plane workload
    // router. They must not be sent through the internal worker bridge, or
    // allstatus/allchat will fall back to bridge.command inventory RPCs.
    return !Boolean(getSession(workspaceId, sessionId).workloadWorkerId);
  } catch {
    // Preserve the old internal-worker behavior if the session registry has
    // not hydrated yet; a missing session cannot be safely treated as panel-owned.
    return true;
  }
}

export async function routeViaRemoteBridge(
  message: IncomingTextMessage,
): Promise<BridgeResult> {
  publisher ??= redisConnection();
  const requestId = randomUUID();
  const responseKey = `${RESPONSE_PREFIX}${requestId}`;
  await publisher.publish(
    REQUEST_CHANNEL,
    JSON.stringify({ requestId, responseKey, message: serializeMessage(message) }),
  );
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await publisher.get(responseKey);
    if (response) {
      await publisher.unlink(responseKey).catch(() => undefined);
      const parsed = JSON.parse(response) as {
        ok: boolean;
        result?: SerializedReply | string | null;
        error?: string;
      };
      if (!parsed.ok) throw new Error(parsed.error ?? "Worker bridge command failed.");
      return deserializeReply(parsed.result ?? null);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker bridge timed out for session ${message.sessionId}.`);
}

export async function startRemoteBridgeResponder(
  handler: BridgeHandler,
): Promise<void> {
  if (!isWorkerProcess || responderStarted) return;
  responderStarted = true;
  publisher ??= redisConnection();
  subscriber = redisConnection();
  await subscriber.subscribe(REQUEST_CHANNEL);
  subscriber.on("message", (_channel, raw) => {
    void (async () => {
      let request: { requestId: string; responseKey: string; message: SerializedMessage };
      try {
        request = JSON.parse(raw) as typeof request;
        if (!request?.requestId || !request.responseKey || !request.message?.sessionId) return;
        if (!workerSessionIds.has(request.message.sessionId)) return;
        const result = await handler(deserializeMessage(request.message));
        await publisher?.set(
          request.responseKey,
          JSON.stringify({ ok: true, result: serializeReply(result) }),
          "PX",
          RESPONSE_TTL_MS,
        );
      } catch (error) {
        try {
          const request = JSON.parse(raw) as { responseKey?: string };
          if (request.responseKey)
            await publisher?.set(
              request.responseKey,
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
              "PX",
              RESPONSE_TTL_MS,
            );
        } catch {
          // Malformed bridge requests are ignored and never crash the worker.
        }
      }
    })();
  });
}

export async function stopRemoteBridgeResponder(): Promise<void> {
  responderStarted = false;
  await subscriber?.quit().catch(() => undefined);
  subscriber = undefined;
  await publisher?.quit().catch(() => undefined);
  publisher = undefined;
}
