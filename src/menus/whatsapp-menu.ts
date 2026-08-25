import {
  getMenuMedia,
  readMenuMedia,
  getWhatsappMenuSettings,
  listMenuMedia,
} from "../media/menu-media-store.js";
import { buildSessionMenu, renderAsciiMenu } from "./menu-model.js";
import {
  buildMenuMediaUrl,
  buildRichMenuContent,
  textForView,
  type RichMenuContent,
  type RichMenuBuildOptions,
} from "./rich-menu-runtime.js";
import type { WhatsAppSession } from "../types/domain.js";
import type { GroupControlTable } from "../whatsapp/group-control-confirmation.js";

export interface WhatsappMenuPayload {
  text: string;
  media?: {
    kind: "image" | "video";
    bytes: Buffer;
    mimeType: string;
    fileName: string;
  };
  caption: string;
  richMenu: RichMenuContent;
}

export async function buildWhatsappMenuPayload(
  session: WhatsAppSession,
  isOwner: boolean,
  view = "root",
  menuOptions?: RichMenuBuildOptions,
): Promise<WhatsappMenuPayload> {
  const configuration = getWhatsappMenuSettings(session.workspaceId);
  const model = buildSessionMenu(session, isOwner);
  const fallbackText = textForView(model, view);
  const legacyText = renderAsciiMenu(model);
  const displayText = view === "root" || view === "all" ? legacyText : fallbackText;
  let image:
    | {
        url: string;
        mime_type: string;
        width: number;
        height: number;
        inline?: boolean;
      }
    | undefined;
  let media: WhatsappMenuPayload["media"];
  const configuredId = configuration.whatsappMenuMediaId;
  // An explicit clear means text mode. Never auto-select another uploaded
  // image after the administrator removes the active selection.
  const candidateIds = configuredId ? [configuredId] : [];
  for (const mediaId of candidateIds) {
    try {
      const candidate = getMenuMedia(session.workspaceId, mediaId);
      if (candidate.kind !== "image") continue;
      // The catalog is already hydrated and the signed endpoint validates the file
      // when WhatsApp fetches it. Avoid blocking every menu render on a filesystem
      // stat so the rich-menu envelope can be relayed immediately.
      image = {
        url: buildMenuMediaUrl(session.workspaceId, candidate.mediaId),
        mime_type: candidate.mimeType,
        width: 1080,
        height: 620,
        inline: true,
      };
      if (view === "root") {
        try {
          const loaded = await readMenuMedia(session.workspaceId, candidate.mediaId);
          media = { kind: "image", bytes: loaded.bytes, mimeType: loaded.media.mimeType, fileName: loaded.media.fileName };
        } catch (error) {
          console.warn("[pappy-omega-mini] Selected WhatsApp menu image could not be read for media fallback:", error instanceof Error ? error.message : String(error));
        }
      }
      break;
    } catch (error) {
      if (mediaId === configuredId)
        console.warn(
          "[pappy-omega-mini] Configured WhatsApp menu image unavailable; checking existing menu media:",
          error instanceof Error ? error.message : String(error),
        );
    }
  }
  const richMenu = buildRichMenuContent(model, view, image, {
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    ...menuOptions,
  });
  const caption = [configuration.whatsappMenuCaption, displayText]
    .filter(Boolean)
    .join("\n\n");
  // The native RichMenu encoder fetches the signed URL itself. Do not attach a
  // duplicate base64 copy of the image to the control-plane response.
  return { text: displayText || legacyText, ...(media ? { media } : {}), caption, richMenu };
}

export function buildWhatsappTextMenuPayload(
  session: WhatsAppSession,
  isOwner: boolean,
): { text: string } {
  return { text: renderAsciiMenu(buildSessionMenu(session, isOwner)) };
}

export function buildWhatsappHelpPayload(
  session: WhatsAppSession,
  isOwner: boolean,
): { text: string; nativeTable: GroupControlTable; nativeFlow: [] } {
  const model = buildSessionMenu(session, isOwner);
  const prefix = model.prefix || "";
  const command = (name: string) => `${prefix}${name}`;
  const table: GroupControlTable = {
    title: "PAPPY OMEGA MINI · HELP & USAGE",
    headers: ["Item", "Details"],
    rows: [
      ["Package", "@crysnovax/baileys"],
      ["Description", "Multi-tenant Telegram + WhatsApp command engine"],
      ["Version", "2.7.13"],
      ["Commands", `${model.actions.length} available registered commands`],
      ["Access", isOwner ? "Owner / sudo access" : "Authorized session access"],
      ["Rich / text", `${command("menu")} for RichMenu · ${command("menulist")} text for classic list`],
      ["Usage", `${command("menu")} · ${command("menulist")} rich|text · ${command("help")}`],
      ["Health", `${session.status} · ${session.authHealth ?? "UNKNOWN"}`],
      ["Author", "Pappy Omega Mini"],
      ["Keywords", "menu, commands, sudo, moderation, anti-system, broadcast"],
    ],
    buttons: [],
    footer: `Use ${command("menu")} for category navigation or ${command("menulist")} text for the complete plain list.`,
  };
  const text = [
    "PAPPY OMEGA MINI · HELP & USAGE",
    "",
    `${command("menu")}              RichMenu home`,
    `${command("menulist")} rich     Interactive full command menu`,
    `${command("menulist")} text     Classic plain command list`,
    `${command("help")}              Native usage table`,
  ].join("\n");
  return { text, nativeTable: table, nativeFlow: [] };
}

export { buildSessionMenu, renderAsciiMenu };
