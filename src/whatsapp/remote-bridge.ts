import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_MAX_CLOCK_SKEW_MS = 60_000;
const MAX_BRIDGE_MEDIA_BYTES = Math.min(env.MAX_MEDIA_BYTES, 8 * 1024 * 1024);
const seenBridgeRequests = new Map<string, number>();

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
  if (media.bytes.byteLength > MAX_BRIDGE_MEDIA_BYTES)
    throw new Error("Media exceeds the internal bridge payload limit.");
  return {
    kind: media.kind,
    bytes: media.bytes.toString("base64"),
    ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
    ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
    ...(media.caption !== undefined ? { caption: media.caption } : {}),
    ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
    ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
    ...(media.waveform !== undefined ? { waveform: media.waveform } : {}),
    ...(media.stickerPackName !== undefined ? { stickerPackName: media.stickerPackName } : {}),
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
    ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
    ...(media.waveform !== undefined ? { waveform: media.waveform } : {}),
    ...(media.stickerPackName !== undefined ? { stickerPackName: media.stickerPackName } : {}),
  };
}

function bridgeSecret(): string {
  return env.BRIDGE_HMAC_SECRET ?? env.ENCRYPTION_SECRET ?? "pappy-omega-mini-development-bridge";
}

function bridgeSignature(input: {
  requestId: string;
  responseKey: string;
  issuedAt: number;
  message: SerializedMessage;
}): string {
  return createHmac("sha256", bridgeSecret())
    .update(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, ...input }))
    .digest("hex");
}

function validBridgeSignature(
  request: { requestId: string; responseKey: string; issuedAt: number; message: SerializedMessage; signature?: string },
): boolean {
  if (!request.responseKey.startsWith(RESPONSE_PREFIX)) return false;
  if (!Number.isSafeInteger(request.issuedAt) || Math.abs(Date.now() - request.issuedAt) > BRIDGE_MAX_CLOCK_SKEW_MS)
    return false;
  if (!request.signature || !/^[a-f0-9]{64}$/iu.test(request.signature)) return false;
  const expected = Buffer.from(
    bridgeSignature({
      requestId: request.requestId,
      responseKey: request.responseKey,
      issuedAt: request.issuedAt,
      message: request.message,
    }),
    "hex",
  );
  const actual = Buffer.from(request.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function acceptBridgeRequest(requestId: string): boolean {
  const now = Date.now();
  for (const [id, expiresAt] of seenBridgeRequests) if (expiresAt <= now) seenBridgeRequests.delete(id);
  if (seenBridgeRequests.has(requestId)) return false;
  seenBridgeRequests.set(requestId, now + BRIDGE_MAX_CLOCK_SKEW_MS);
  return true;
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
  if (media && media.bytes.byteLength > MAX_BRIDGE_MEDIA_BYTES)
    throw new Error("Media exceeds the internal bridge payload limit.");
  return media
    ? {
        ...rest,
        media: {
          kind: media.kind,
          bytes: media.bytes.toString("base64"),
          ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
          ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
          ...(media.caption !== undefined ? { caption: media.caption } : {}),
          ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
          ...(media.stickerPackName !== undefined ? { stickerPackName: media.stickerPackName } : {}),
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
          ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
          ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
          ...(media.caption !== undefined ? { caption: media.caption } : {}),
          ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
          ...(media.stickerPackName !== undefined ? { stickerPackName: media.stickerPackName } : {}),
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

export type RemoteBridgeSerializedMessage = SerializedMessage;

/** Secret-safe seams for deterministic protocol tests; no secret is exposed. */
export function signRemoteBridgeRequestForTests(input: {
  requestId: string;
  responseKey: string;
  issuedAt: number;
  message: SerializedMessage;
}): string {
  return bridgeSignature(input);
}

export function validateRemoteBridgeRequestForTests(request: {
  requestId: string;
  responseKey: string;
  issuedAt: number;
  message: SerializedMessage;
  signature?: string;
}): boolean {
  return validBridgeSignature(request);
}

export function acceptRemoteBridgeRequestForTests(requestId: string): boolean {
  return acceptBridgeRequest(requestId);
}

export function resetRemoteBridgeReplayForTests(): void {
  seenBridgeRequests.clear();
}

export function remoteBridgeResponsePrefixForTests(): string {
  return RESPONSE_PREFIX;
}

export async function routeViaRemoteBridge(
  message: IncomingTextMessage,
): Promise<BridgeResult> {
  publisher ??= redisConnection();
  const requestId = randomUUID();
  const responseKey = `${RESPONSE_PREFIX}${requestId}`;
  const issuedAt = Date.now();
  const serializedMessage = serializeMessage(message);
  await publisher.publish(
    REQUEST_CHANNEL,
    JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      requestId,
      responseKey,
      issuedAt,
      message: serializedMessage,
      signature: bridgeSignature({ requestId, responseKey, issuedAt, message: serializedMessage }),
    }),
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
      let request: { v?: number; requestId: string; responseKey: string; issuedAt: number; message: SerializedMessage; signature?: string };
      try {
        request = JSON.parse(raw) as typeof request;
        if (request.v !== BRIDGE_PROTOCOL_VERSION || !request?.requestId || !request.responseKey || !request.message?.sessionId) return;
        if (!validBridgeSignature(request) || !acceptBridgeRequest(request.requestId)) return;
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
