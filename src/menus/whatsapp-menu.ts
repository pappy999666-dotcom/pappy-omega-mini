import {
  getWhatsappMenuSettings,
  listMenuMedia,
  readMenuMedia,
} from "../media/menu-media-store.js";
import { buildSessionMenu, renderAsciiMenu } from "./menu-model.js";
import {
  buildMenuMediaUrl,
  buildRichMenuContent,
  textForView,
  type RichMenuContent,
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
): Promise<WhatsappMenuPayload> {
  const configuration = getWhatsappMenuSettings(session.workspaceId);
  const model = buildSessionMenu(session, isOwner);
  const fallbackText = textForView(model, view);
  const legacyText = renderAsciiMenu(model);
  let selectedMedia:
    | Awaited<ReturnType<typeof readMenuMedia>>
    | undefined;
  let image:
    | {
        url: string;
        mime_type: string;
        width: number;
        height: number;
      }
    | undefined;
  const configuredId = configuration.whatsappMenuMediaId;
  const candidateIds = [
    ...new Set(
      [
        configuredId,
        ...listMenuMedia(session.workspaceId).map((item) => item.mediaId),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const mediaId of candidateIds) {
    try {
      const candidate = await readMenuMedia(session.workspaceId, mediaId);
      if (candidate.media.kind !== "image") continue;
      selectedMedia = candidate;
      image = {
        url: buildMenuMediaUrl(session.workspaceId, candidate.media.mediaId),
        mime_type: candidate.media.mimeType,
        width: 1080,
        height: 620,
      };
      break;
    } catch (error) {
      if (mediaId === configuredId)
        console.warn(
          "[pappy-omega-mini] Configured WhatsApp menu image unavailable; checking existing menu media:",
          error instanceof Error ? error.message : String(error),
        );
    }
  }
  const richMenu = buildRichMenuContent(model, view, image);
  const caption = [configuration.whatsappMenuCaption, fallbackText]
    .filter(Boolean)
    .join("\n\n");
  if (selectedMedia) {
    return {
      text: fallbackText,
      caption,
      richMenu,
      media: {
        kind: selectedMedia.media.kind,
        bytes: selectedMedia.bytes,
        mimeType: selectedMedia.media.mimeType,
        fileName: selectedMedia.media.fileName,
      },
    };
  }
  return { text: fallbackText || legacyText, caption, richMenu };
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
  const table: GroupControlTable = {
    title: "PAPPY OMEGA MINI · HELP & USAGE",
    headers: ["Item", "Details"],
    rows: [
      ["Package", "@crysnovax/baileys"],
      ["Description", "Multi-tenant Telegram + WhatsApp command engine"],
      ["Version", "2.7.13"],
      ["Commands", `${model.actions.length} available registered commands`],
      ["Access", isOwner ? "Owner / sudo access" : "Authorized session access"],
      ["Rich / text", ".menu for RichMenu · .menulist text for classic list"],
      ["Usage", ".menu · .menulist rich|text · .help"],
      ["Health", `${session.status} · ${session.authHealth ?? "UNKNOWN"}`],
      ["Author", "Pappy Omega Mini"],
      ["Keywords", "menu, commands, sudo, moderation, anti-system, broadcast"],
    ],
    buttons: [],
    footer: "Use .menu for category navigation or .menulist text for the complete plain list.",
  };
  const text = [
    "PAPPY OMEGA MINI · HELP & USAGE",
    "",
    ".menu              RichMenu home",
    ".menulist rich     Interactive full command menu",
    ".menulist text     Classic plain command list",
    ".help              Native usage table",
  ].join("\n");
  return { text, nativeTable: table, nativeFlow: [] };
}

export { buildSessionMenu, renderAsciiMenu };
