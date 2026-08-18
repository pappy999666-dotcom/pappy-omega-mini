import {
  getWhatsappMenuSettings,
  readMenuMedia,
} from "../media/menu-media-store.js";
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

function compactMenu(session: WhatsAppSession, isOwner: boolean): string {
  const ownerLine = isOwner ? "Owner mode: enabled" : "User mode: enabled";
  return [
    "✦ PAPPY OMEGA MINI",
    `Session: ${session.sessionName} · ${session.status}`,
    `${ownerLine} · Auto-join: ${session.autoJoinEnabled ? "ON" : "OFF"}`,
    "",
    "COMMANDS",
    ".profile  .pfp  .groups",
    ".creategroup  .setgpp",
    ".autojoin on|off  .health",
    ".setprefix  .menu  .ping",
    ...(isOwner ? [".setsudo add|remove|list", ".allstatusx <text>"] : []),
    "",
    `Prefix: ${session.prefix || "none"} · Reply .help for details`,
  ].join("\n");
}

export async function buildWhatsappMenuPayload(
  session: WhatsAppSession,
  isOwner: boolean,
): Promise<WhatsappMenuPayload> {
  const configuration = getWhatsappMenuSettings(session.workspaceId);
  const text = compactMenu(session, isOwner);
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

export { compactMenu };
