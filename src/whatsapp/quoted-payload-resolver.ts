import { downloadMediaMessage } from "@crysnovax/baileys/lib/Utils/messages.js";
import type {
  WhatsAppMediaKind,
  WhatsAppMediaPayload,
} from "./media-payload.js";

export interface MessageEnvelope {
  key?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

const MEDIA_KINDS: WhatsAppMediaKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "sticker",
];

export function extractMessageText(
  message: Record<string, unknown> | undefined,
): string {
  const content = normalizedContent(message);
  const conversation = content?.conversation;
  if (typeof conversation === "string") return conversation;
  const extended = content?.extendedTextMessage;
  if (isRecord(extended) && typeof extended.text === "string")
    return extended.text;
  for (const kind of MEDIA_KINDS) {
    const media = content?.[`${kind}Message`];
    if (isRecord(media) && typeof media.caption === "string")
      return media.caption;
  }
  return "";
}

export function extractQuotedMessage(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const content = normalizedContent(message);
  const extended = content?.extendedTextMessage;
  const contextInfo = isRecord(extended) ? extended.contextInfo : undefined;
  const quoted = isRecord(contextInfo) ? contextInfo.quotedMessage : undefined;
  return isRecord(quoted) ? quoted : undefined;
}

export function extractQuotedText(
  quoted: Record<string, unknown> | undefined,
): string | undefined {
  const text = extractMessageText(quoted);
  return text || undefined;
}

export async function resolveMediaPayload(
  envelope: MessageEnvelope,
  socket: unknown,
): Promise<WhatsAppMediaPayload | undefined> {
  const content = normalizedContent(envelope.message);
  const media = findMedia(content);
  if (!media) return undefined;
  try {
    const downloadEnvelope =
      content && content !== envelope.message
        ? { ...envelope, message: content }
        : envelope;
    const bytes = await downloadMediaMessage(
      downloadEnvelope as never,
      "buffer",
      {},
      socket as never,
    );
    if (!Buffer.isBuffer(bytes)) return undefined;
    const mediaBody = content?.[`${media.kind}Message`];
    const body = isRecord(mediaBody) ? mediaBody : {};
    const caption = typeof body.caption === "string" ? body.caption : undefined;
    const mimeType =
      typeof body.mimetype === "string" ? body.mimetype : undefined;
    const fileName =
      typeof body.fileName === "string" ? body.fileName : undefined;
    const ptt = typeof body.ptt === "boolean" ? body.ptt : undefined;
    return {
      kind: media.kind,
      bytes,
      ...(mimeType ? { mimeType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(caption ? { caption } : {}),
      ...(ptt !== undefined ? { ptt } : {}),
    };
  } catch (error) {
    console.warn(
      `[pappy-omega-mini] inbound media download failed kind=${media.kind} message=${String(envelope.key?.id ?? "unknown")}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function normalizedContent(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!message) return undefined;
  let current = message;
  for (let index = 0; index < 5; index += 1) {
    const wrapperKey = [
      "associatedChildMessage",
      "botForwardedMessage",
      "botInvokeMessage",
      "botTaskMessage",
      "documentWithCaptionMessage",
      "editedMessage",
      "ephemeralMessage",
      "groupStatusMessage",
      "groupStatusMessageV2",
      "statusMentionMessage",
      "viewOnceMessage",
      "viewOnceMessageV2",
      "viewOnceMessageV2Extension",
    ].find((key) => isRecord(current?.[key]));
    if (!wrapperKey) break;
    const wrapper = current[wrapperKey];
    if (!isRecord(wrapper)) break;
    current = isRecord(wrapper.message) ? wrapper.message : wrapper;
  }
  return current;
}

function findMedia(
  message: Record<string, unknown> | undefined,
): { kind: WhatsAppMediaKind } | undefined {
  for (const kind of MEDIA_KINDS) {
    if (isRecord(message?.[`${kind}Message`])) return { kind };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
