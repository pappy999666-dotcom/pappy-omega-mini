import { createHash } from "node:crypto";
import { downloadMediaMessage } from "@crysnovax/baileys/lib/Utils/messages.js";
import type {
  WhatsAppMediaKind,
  WhatsAppMediaPayload,
} from "./media-payload.js";

export interface MessageEnvelope {
  key?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/**
 * Build the actual message key required by Baileys when downloading quoted
 * media. The outer command key identifies the command message, not the
 * quoted sticker; using it can return an empty/invalid payload.
 */
export function buildQuotedMessageEnvelope(
  envelope: MessageEnvelope,
  quotedMessage: Record<string, unknown> | undefined,
  contextInfo: Record<string, unknown> | undefined,
): MessageEnvelope | undefined {
  const remoteJid = typeof envelope.key?.remoteJid === "string"
    ? envelope.key.remoteJid
    : undefined;
  const stanzaId = typeof contextInfo?.stanzaId === "string"
    ? contextInfo.stanzaId
    : undefined;
  if (!remoteJid || !stanzaId || !quotedMessage) return undefined;
  const participant = typeof contextInfo?.participant === "string"
    ? contextInfo.participant
    : undefined;
  const fromMe = typeof contextInfo?.fromMe === "boolean"
    ? contextInfo.fromMe
    : undefined;
  return {
    key: {
      remoteJid,
      id: stanzaId,
      ...(participant ? { participant } : {}),
      ...(fromMe !== undefined ? { fromMe } : {}),
    },
    message: quotedMessage,
  };
}

export type WhatsAppInteractionKind = "native-flow" | "list" | "buttons" | "template";

export interface WhatsAppInteraction {
  kind: WhatsAppInteractionKind;
  id: string | null;
  displayText: string;
}

const MEDIA_KINDS: WhatsAppMediaKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "sticker",
];

export function extractWhatsAppInteraction(
  message: Record<string, unknown> | undefined,
): WhatsAppInteraction | undefined {
  const content = normalizedContent(message);
  if (!content) return undefined;
  const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
  const parseParams = (value: unknown): Record<string, unknown> | undefined => {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value !== "string" || !value) return undefined;
    try {
      const first: unknown = JSON.parse(value);
      if (typeof first === "string") {
        try {
          const second: unknown = JSON.parse(first);
          return second && typeof second === "object" ? second as Record<string, unknown> : undefined;
        } catch { return undefined; }
      }
      return first && typeof first === "object" ? first as Record<string, unknown> : undefined;
    } catch { return undefined; }
  };
  const interactive = isRecord(content.interactiveResponseMessage) ? content.interactiveResponseMessage : undefined;
  const native = interactive && isRecord(interactive.nativeFlowResponseMessage) ? interactive.nativeFlowResponseMessage : undefined;
  if (native) {
    const params = parseParams(native.paramsJson ?? native.buttonParamsJson ?? native.params);
    const id = stringValue(params?.id) || stringValue(native.id) || stringValue(native.buttonId);
    const displayText = stringValue(params?.display_text) || stringValue(interactive?.body && isRecord(interactive.body) ? interactive.body.text : "");
    if (id || displayText) return { kind: "native-flow", id: id || null, displayText };
  }
  const listReply = isRecord(content.listResponseMessage) && isRecord(content.listResponseMessage.singleSelectReply)
    ? content.listResponseMessage.singleSelectReply : undefined;
  if (listReply) {
    const id = stringValue(listReply.selectedRowId);
    const displayText = stringValue(listReply.selectedDisplayText);
    if (id || displayText) return { kind: "list", id: id || null, displayText };
  }
  const buttonsReply = isRecord(content.buttonsResponseMessage) ? content.buttonsResponseMessage : undefined;
  if (buttonsReply) {
    const id = stringValue(buttonsReply.selectedButtonId) || stringValue(buttonsReply.selectedId) || stringValue(buttonsReply.buttonId);
    const displayText = stringValue(buttonsReply.selectedDisplayText) || stringValue(buttonsReply.displayText) || stringValue(buttonsReply.text);
    if (id || displayText) return { kind: "buttons", id: id || null, displayText };
  }
  const templateReply = isRecord(content.templateButtonReplyMessage) ? content.templateButtonReplyMessage : undefined;
  if (templateReply) {
    const id = stringValue(templateReply.selectedId) || stringValue(templateReply.selectedButtonId) || stringValue(templateReply.buttonId);
    const displayText = stringValue(templateReply.selectedDisplayText) || stringValue(templateReply.displayText) || stringValue(templateReply.text);
    if (id || displayText) return { kind: "template", id: id || null, displayText };
  }
  return undefined;
}

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

export function extractMessageContextInfo(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const content = normalizedContent(message);
  if (!content) return undefined;
  const candidates = [
    content.extendedTextMessage,
    content.imageMessage,
    content.videoMessage,
    content.audioMessage,
    content.documentMessage,
    content.stickerMessage,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && isRecord(candidate.contextInfo)) return candidate.contextInfo;
  }
  return undefined;
}

export function extractQuotedMessage(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const contextInfo = extractMessageContextInfo(message);
  const quoted = isRecord(contextInfo) ? contextInfo.quotedMessage : undefined;
  return isRecord(quoted) ? quoted : undefined;
}

export function extractQuotedText(
  quoted: Record<string, unknown> | undefined,
): string | undefined {
  const text = extractMessageText(quoted);
  return text || undefined;
}

/**
 * Returns a stable, non-reversible identity for a sticker message. The raw
 * Baileys media metadata is never exposed outside this module or persisted.
 */
export function extractStickerFingerprint(
  message: Record<string, unknown> | undefined,
): string | undefined {
  const content = normalizedContent(message);
  const sticker = content?.stickerMessage;
  if (!isRecord(sticker)) return undefined;
  const metadata = [
    "fileSha256",
    "fileEncSha256",
    "mediaKey",
    "directPath",
  ].reduce<Record<string, string>>((result, key) => {
    const value = sticker[key];
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
    else if (Buffer.isBuffer(value) && value.length) result[key] = value.toString("base64");
    else if (value instanceof Uint8Array && value.length) result[key] = Buffer.from(value).toString("base64");
    return result;
  }, {});
  const keys = Object.keys(metadata).sort();
  if (!keys.length) return undefined;
  const canonical = keys.map((key) => `${key}:${metadata[key]}`).join("|");
  return `sticker:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
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
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw new Error("WhatsApp returned an empty media payload for the quoted message.");
    const mediaBody = content?.[media.messageKey];
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

type MediaReference = { kind: WhatsAppMediaKind; messageKey: string };

function findMedia(
  message: Record<string, unknown> | undefined,
): MediaReference | undefined {
  for (const kind of MEDIA_KINDS) {
    const messageKey = `${kind}Message`;
    if (isRecord(message?.[messageKey])) return { kind, messageKey };
  }
  const document = message?.documentMessage;
  if (isRecord(document)) {
    const mimeType = typeof document.mimetype === "string" ? document.mimetype.toLowerCase() : "";
    if (mimeType.startsWith("audio/")) return { kind: "audio", messageKey: "documentMessage" };
    if (mimeType.startsWith("video/")) return { kind: "video", messageKey: "documentMessage" };
    if (mimeType.startsWith("image/")) return { kind: "image", messageKey: "documentMessage" };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
