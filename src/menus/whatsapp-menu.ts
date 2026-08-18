import {
  getWhatsappMenuSettings,
  readMenuMedia,
} from "../media/menu-media-store.js";
import { buildSessionMenu, renderAsciiMenu } from "./menu-model.js";
import type { WhatsAppSession } from "../types/domain.js";

export interface WhatsappMenuPayload {
  text: string;
  media?: {
    kind: "image" | "video";
    bytes: Buffer;
    mimeType: string;
    fileName: string;
  };
  caption: string;
}

export async function buildWhatsappMenuPayload(
  session: WhatsAppSession,
  isOwner: boolean,
): Promise<WhatsappMenuPayload> {
  const model = buildSessionMenu(session, isOwner);
  const configuration = getWhatsappMenuSettings(session.workspaceId);
  const text = renderAsciiMenu(model);
  if (!configuration.whatsappMenuMediaId) {
    return { text, caption: configuration.whatsappMenuCaption };
  }

  const { media, bytes } = await readMenuMedia(
    session.workspaceId,
    configuration.whatsappMenuMediaId,
  );
  return {
    text,
    caption: `${configuration.whatsappMenuCaption}\n\n${text}`,
    media: {
      kind: media.kind,
      bytes,
      mimeType: media.mimeType,
      fileName: media.fileName,
    },
  };
}
