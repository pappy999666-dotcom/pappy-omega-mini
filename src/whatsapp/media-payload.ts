export type WhatsAppMediaKind =
  "image" | "video" | "audio" | "document" | "sticker";

export interface WhatsAppMediaPayload {
  kind: WhatsAppMediaKind;
  bytes: Buffer;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  ptt?: boolean;
  stickerPackName?: string;
}
