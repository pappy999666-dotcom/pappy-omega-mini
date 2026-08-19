import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";

export interface JobMediaReference {
  mediaId: string;
  workspaceId: string;
  kind: "image" | "video";
  mimeType: string;
  fileName: string;
}

export async function persistJobMedia(input: {
  workspaceId: string;
  kind: "image" | "video";
  bytes: Buffer;
  mimeType?: string;
}): Promise<JobMediaReference> {
  if (!input.bytes.length)
    throw new Error("Cannot queue an empty media payload.");
  if (input.bytes.length > env.MAX_MEDIA_BYTES)
    throw new Error("Media exceeds the configured WhatsApp payload limit.");
  const mediaId = randomUUID();
  const mimeType =
    input.mimeType ?? (input.kind === "image" ? "image/jpeg" : "video/mp4");
  const fileName = `${mediaId}.${input.kind === "image" ? "jpg" : "mp4"}`;
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
