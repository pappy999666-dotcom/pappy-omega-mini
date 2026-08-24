import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { env } from "../config/env.js";
import type {
  MediaKind,
  MenuMedia,
  MenuMediaSettings,
} from "../types/domain.js";
import { loadMenuMedia, persistMenuMedia } from "../persistence/mongo.js";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings,
} from "../core/workspace-settings.js";

const allowedTypes: Record<MediaKind, Set<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/webm"]),
};

const catalog = new Map<string, MenuMedia>();

const defaultMenuCaption = "Choose a session and send a command.";
const selectionPath = join(env.SESSION_ROOT, "..", "menu-media-selection.json");
const durableSelections = new Map<string, string>();
let selectionsLoaded = false;

function ensureSelectionsLoaded(): void {
  if (selectionsLoaded) return;
  selectionsLoaded = true;
  try {
    const parsed: unknown = JSON.parse(readFileSync(selectionPath, "utf8"));
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (item && typeof item === "object" && "workspaceId" in item && "mediaId" in item && typeof item.workspaceId === "string" && typeof item.mediaId === "string" && item.workspaceId && item.mediaId)
        durableSelections.set(item.workspaceId, item.mediaId);
    }
  } catch {
    // Missing or temporarily unreadable selection state is safe; settings remain the fallback.
  }
}

function persistSelections(): void {
  mkdirSync(dirname(selectionPath), { recursive: true });
  writeFileSync(selectionPath, JSON.stringify([...durableSelections].map(([workspaceId, mediaId]) => ({ workspaceId, mediaId })), null, 2), { mode: 0o600 });
}

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
  try {
    if (process.env.VITEST !== "true" && env.NODE_ENV !== "test") {
      await persistMenuMedia(media);
    }
  } catch (error) {
    // The file remains usable during a transient Mongo outage; startup hydration
    // will reconcile durable metadata once the database is healthy again.
    console.warn("[menu-media] durable catalog write deferred", error);
  }
  return media;
}

export async function hydrateMenuMedia(): Promise<void> {
  const media = await loadMenuMedia();
  for (const item of media) catalog.set(item.mediaId, item);
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
  mediaId: string | null | undefined,
  caption?: string,
): MenuMediaSettings {
  ensureSelectionsLoaded();
  if (typeof mediaId === "string" && mediaId) getMenuMedia(workspaceId, mediaId);
  const current = getWhatsappMenuSettings(workspaceId);
  const nextCaption =
    caption === undefined ? current.whatsappMenuCaption : caption.slice(0, 1024);
  const selectionPatch = mediaId === null
    ? { whatsappMenuMediaId: undefined }
    : mediaId === undefined
      ? {}
      : { whatsappMenuMediaId: mediaId };
  if (mediaId === null) durableSelections.delete(workspaceId);
  else if (typeof mediaId === "string" && mediaId) durableSelections.set(workspaceId, mediaId);
  persistSelections();
  const nextWorkspace = updateWorkspaceSettings(workspaceId, {
    ...selectionPatch,
    whatsappMenuCaption: nextCaption,
  });
  return {
    workspaceId,
    ...(nextWorkspace.whatsappMenuMediaId
      ? { whatsappMenuMediaId: nextWorkspace.whatsappMenuMediaId }
      : {}),
    whatsappMenuCaption:
      nextWorkspace.whatsappMenuCaption ?? defaultMenuCaption,
    updatedAt: nextWorkspace.updatedAt,
  };
}

export function getWhatsappMenuSettings(
  workspaceId: string,
): MenuMediaSettings {
  ensureSelectionsLoaded();
  const current = getWorkspaceSettings(workspaceId);
  const mediaId = current.whatsappMenuMediaId || durableSelections.get(workspaceId);
  if (current.whatsappMenuMediaId && durableSelections.get(workspaceId) !== current.whatsappMenuMediaId) {
    durableSelections.set(workspaceId, current.whatsappMenuMediaId);
    persistSelections();
  }
  return {
    workspaceId,
    ...(mediaId ? { whatsappMenuMediaId: mediaId } : {}),
    whatsappMenuCaption: current.whatsappMenuCaption ?? defaultMenuCaption,
    updatedAt: current.updatedAt,
  };
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
