import {
  addMenuMedia,
  getMenuMedia,
  getWhatsappMenuSettings,
  listMenuMedia,
  setWhatsappMenuMedia,
} from "../media/menu-media-store.js";

export async function uploadWhatsappMenuMedia(input: {
  workspaceId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}) {
  return addMenuMedia(input);
}

export function getAdminMediaOverview(workspaceId: string): string {
  const items = listMenuMedia(workspaceId);
  const selected = getWhatsappMenuSettings(workspaceId).whatsappMenuMediaId;
  if (!items.length)
    return "MEDIA LIBRARY\n\nNo menu media uploaded yet. Use Add Image or Add Video.";
  return [
    "MEDIA LIBRARY",
    "",
    ...items.map(
      (item, index) =>
        `${index + 1}. ${item.kind.toUpperCase()} · ${item.fileName} · ${Math.ceil(item.bytes / 1024)} KB${item.mediaId === selected ? " · ACTIVE WHATSAPP MENU" : ""}`,
    ),
    "",
    "Select a media ID to attach it to the WhatsApp menu.",
  ].join("\n");
}

export function selectWhatsappMenuMedia(
  workspaceId: string,
  mediaId: string,
  caption?: string,
): string {
  const media = getMenuMedia(workspaceId, mediaId);
  setWhatsappMenuMedia(workspaceId, media.mediaId, caption);
  return `${media.kind === "image" ? "Image" : "Video"} ${media.fileName} is now attached to the WhatsApp menu.`;
}

export function clearWhatsappMenuMedia(workspaceId: string): string {
  setWhatsappMenuMedia(workspaceId, null);
  return "WhatsApp menu media cleared. The menu will render in text mode.";
}

export function updateWhatsappMenuCaption(
  workspaceId: string,
  caption: string,
): string {
  setWhatsappMenuMedia(
    workspaceId,
    getWhatsappMenuSettings(workspaceId).whatsappMenuMediaId,
    caption,
  );
  return "WhatsApp menu caption updated.";
}
