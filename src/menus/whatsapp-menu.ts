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

function elapsedSince(timestamp?: number): string {
  if (!timestamp) return "—";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function normalizedStatus(session: WhatsAppSession): string {
  if (session.status === "ACTIVE" && session.authHealth !== "INVALID")
    return "ONLINE";
  if (session.status === "RECONNECTING") return "RECOVERING";
  if (session.status === "PAIRING") return "PAIRING";
  if (session.status === "LOGGED_OUT") return "OFFLINE";
  return session.status;
}

function commandRows(commands: string[], width = 6): string[] {
  const rows: string[] = [];
  for (let index = 0; index < commands.length; index += width)
    rows.push(`│ ${commands.slice(index, index + width).join("  ")}`);
  return rows;
}

function section(title: string, commands: string[]): string[] {
  return [`├─ ${title}`, ...commandRows(commands)];
}

function compactMenu(session: WhatsAppSession, isOwner: boolean): string {
  const role = isOwner ? "OWNER / SUDO" : "AUTHORIZED USER";
  const status = normalizedStatus(session);
  const prefix = session.prefix || "none";
  const autoJoin = session.autoJoinEnabled ? "ON" : "OFF";
  const collected = session.collectedLinkCount ?? 0;
  const validated = session.validatedLinkCount ?? 0;
  const healthyFor = elapsedSince(session.connectedAt ?? session.lastHealthyAt);
  const lines = [
    "✦ PAPPY OMEGA MINI",
    `┌ ${session.sessionName} · ${status} · ${role}`,
    `│ AJ ${autoJoin} · PFX ${prefix} · HEALTH ${healthyFor} · LINKS ${collected}/${validated}`,
    ...section("COMMANDS", [".menu", ".ping", ".profile", ".health", ".support"]),
    ...section("SESSION", [
      ".autojoin",
      ".setprefix",
      ".pfp",
      ".setgpp",
      ".setname",
      ".setbio",
      ".groups",
      ".creategroup",
    ]),
    ...section("LOCAL", [
      ".gstatus <text/reply>",
      ".tag <payload>",
      ".stag <payload>",
    ]),
  ];
  if (isOwner) {
    lines.push(
      ...section("OWNER / SUDO", [
        ".pair",
        ".previewdebug",
        ".broadcastdelay",
        ".allstatus",
        ".allstatusx",
        ".gstatusx",
        ".stopstatus",
        ".allchat",
        ".allchatx",
        ".stopchat",
        ".stopstag",
        ".setsudo",
      ]),
    );
  }
  lines.push(
    `└ ${prefix === "none" ? "No prefix" : `Use ${prefix}help`} · .menu`,
  );
  return lines.join("\n");
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
