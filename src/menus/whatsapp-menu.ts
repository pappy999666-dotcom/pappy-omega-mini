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
  const configuration = getWhatsappMenuSettings(session.workspaceId);
  const text = renderAsciiMenu(buildSessionMenu(session, isOwner));
  if (!configuration.whatsappMenuMediaId) {
    return { text, caption: configuration.whatsappMenuCaption };
  }

  try {
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
  } catch (error) {
    // The workspace-wide menu must never become silent because a media file is
    // temporarily unavailable. Keep the selected setting and return the full
    // text menu; the next request retries the attachment automatically.
    console.warn(
      "[pappy-omega-mini] WhatsApp menu media unavailable; using text fallback:",
      error instanceof Error ? error.message : String(error),
    );
    return { text, caption: `${configuration.whatsappMenuCaption}\n\n${text}` };
  }
}

export { buildSessionMenu, renderAsciiMenu };
