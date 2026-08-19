import {
  getWhatsappMenuSettings,
  readMenuMedia,
} from "../media/menu-media-store.js";
import type { WhatsAppSession } from "../types/domain.js";
import { createCommandRegistry } from "../whatsapp/command-registry.js";

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
  const ownerLine = isOwner ? "OWNER" : "USER";
  const commands = createCommandRegistry()
    .filter((command) => !command.ownerOnly || isOwner)
    .flatMap((command) => {
      if (command.name === "allstatus") return [".allstatus", ".allstatusx"];
      if (command.name === "allchat") return [".allchat", ".allchatx"];
      if (command.name === "gstatus") return [".gstatus", ".gstatusx"];
      if (command.name === "pfp") return [".pfp", ".setpfp", ".getpfp"];
      return [`.${command.name}`];
    });
  const commandLines: string[] = [];
  for (let index = 0; index < commands.length; index += 3)
    commandLines.push(commands.slice(index, index + 3).join("  "));
  return [
    "✦ PAPPY OMEGA MINI",
    `${session.sessionName} · ${session.status} · ${ownerLine}`,
    `Auto-join ${session.autoJoinEnabled ? "ON" : "OFF"}`,
    "",
    "COMMANDS",
    ...commandLines,
    "",
    `Prefix ${session.prefix || "none"} · Use ${session.prefix || "."}help`,
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
