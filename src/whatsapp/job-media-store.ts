import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";
import type { WhatsAppMediaKind } from "./media-payload.js";

export interface JobMediaReference {
  mediaId: string;
  workspaceId: string;
  kind: WhatsAppMediaKind;
  mimeType: string;
  fileName: string;
}

export async function persistJobMedia(input: {
  workspaceId: string;
  kind: WhatsAppMediaKind;
  bytes: Buffer;
  mimeType?: string;
  fileName?: string;
}): Promise<JobMediaReference> {
  if (!input.bytes.length)
    throw new Error("Cannot queue an empty media payload.");
  if (input.bytes.length > env.MAX_MEDIA_BYTES)
    throw new Error("Media exceeds the configured WhatsApp payload limit.");
  const mediaId = randomUUID();
  const mimeType = input.mimeType ?? defaultMimeType(input.kind);
  const extension =
    input.fileName
      ?.split(".")
      .pop()
      ?.replace(/[^a-zA-Z0-9]/g, "") || defaultExtension(input.kind);
  const fileName = `${mediaId}.${extension}`;
  const directory = join(env.MEDIA_ROOT, input.workspaceId, "job-payloads");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), input.bytes, { flag: "wx" });
  return {
    mediaId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    mimeType,
    fileName,
  };
}

export async function readJobMedia(
  reference: JobMediaReference,
): Promise<Buffer> {
  const safeName = reference.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safeName !== reference.fileName || !reference.mediaId)
    throw new Error("Invalid queued media reference.");
  return readFile(
    join(env.MEDIA_ROOT, reference.workspaceId, "job-payloads", safeName),
  );
}

function defaultMimeType(kind: WhatsAppMediaKind): string {
  switch (kind) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mp4";
    case "document":
      return "application/octet-stream";
    case "sticker":
      return "image/webp";
  }
}

function defaultExtension(kind: WhatsAppMediaKind): string {
  switch (kind) {
    case "image":
      return "jpg";
    case "video":
      return "mp4";
    case "audio":
      return "m4a";
    case "document":
      return "bin";
    case "sticker":
      return "webp";
  }
}

export async function removeJobMedia(
  reference: JobMediaReference,
): Promise<void> {
  await rm(
    join(
      env.MEDIA_ROOT,
      reference.workspaceId,
      "job-payloads",
      reference.fileName,
    ),
    { force: true },
  );
}
