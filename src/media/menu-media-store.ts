import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { env } from "../config/env.js";
import type {
  MediaKind,
  MenuMedia,
  MenuMediaSettings,
} from "../types/domain.js";

const allowedTypes: Record<MediaKind, Set<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/webm"]),
};

const settings = new Map<string, MenuMediaSettings>();
const catalog = new Map<string, MenuMedia>();

function inferKind(mimeType: string): MediaKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

export async function addMenuMedia(input: {
  workspaceId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<MenuMedia> {
  const kind = inferKind(input.mimeType);
  if (!kind || !allowedTypes[kind].has(input.mimeType)) {
    throw new Error(
      "Only JPEG, PNG, WebP, MP4, and WebM menu media are supported.",
    );
  }
  if (input.bytes.byteLength > env.MAX_MEDIA_BYTES) {
    throw new Error(
      `Media exceeds the ${Math.round(env.MAX_MEDIA_BYTES / 1024 / 1024)} MB limit.`,
    );
  }

  const mediaId = randomUUID();
  const safeName = basename(input.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const workspaceDir = join(env.MEDIA_ROOT, input.workspaceId);
  await mkdir(workspaceDir, { recursive: true });
  const filePath = join(workspaceDir, `${mediaId}-${safeName}`);
  await writeFile(filePath, input.bytes, { flag: "wx" });
  const fileStat = await stat(filePath);
  const media: MenuMedia = {
    mediaId,
    workspaceId: input.workspaceId,
    kind,
    fileName: safeName,
    mimeType: input.mimeType,
    filePath,
    bytes: fileStat.size,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  catalog.set(mediaId, media);
  return media;
}

export function listMenuMedia(workspaceId: string): MenuMedia[] {
  return [...catalog.values()]
    .filter((media) => media.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMenuMedia(workspaceId: string, mediaId: string): MenuMedia {
  const media = catalog.get(mediaId);
  if (!media || media.workspaceId !== workspaceId)
    throw new Error("Menu media not found in this workspace.");
  return media;
}

export function setWhatsappMenuMedia(
  workspaceId: string,
  mediaId: string | undefined,
  caption?: string,
): MenuMediaSettings {
  if (mediaId) getMenuMedia(workspaceId, mediaId);
  const current = settings.get(workspaceId) ?? {
    workspaceId,
    whatsappMenuCaption: "Choose a session and send a command.",
    updatedAt: 0,
  };
  const next: MenuMediaSettings = {
    ...current,
    ...(mediaId === undefined ? {} : { whatsappMenuMediaId: mediaId }),
    ...(caption === undefined
      ? {}
      : { whatsappMenuCaption: caption.slice(0, 1024) }),
    updatedAt: Date.now(),
  };
  if (mediaId === undefined) delete next.whatsappMenuMediaId;
  settings.set(workspaceId, next);
  return next;
}

export function getWhatsappMenuSettings(
  workspaceId: string,
): MenuMediaSettings {
  return (
    settings.get(workspaceId) ?? {
      workspaceId,
      whatsappMenuCaption: "Choose a session and send a command.",
      updatedAt: 0,
    }
  );
}

export async function readMenuMedia(
  workspaceId: string,
  mediaId: string,
): Promise<{ media: MenuMedia; bytes: Buffer }> {
  const media = getMenuMedia(workspaceId, mediaId);
  return { media, bytes: await readFile(media.filePath) };
}

export function fingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
