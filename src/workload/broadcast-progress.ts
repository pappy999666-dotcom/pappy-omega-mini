import { Redis } from "ioredis";
import { env } from "../config/env.js";
import type { WorkloadBroadcastProgress } from "./types.js";

const PREFIX = "pappy-omega-mini:broadcast-progress:";
const TTL_SECONDS = 60 * 60 * 24 * 30;
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

function key(workspaceId: string, jobId: string): string {
  return `${PREFIX}${workspaceId}:${jobId}`;
}

export async function saveBroadcastProgress(
  progress: WorkloadBroadcastProgress & { workspaceId: string },
): Promise<void> {
  await redis.set(key(progress.workspaceId, progress.jobId), JSON.stringify(progress), "EX", TTL_SECONDS);
}

export async function getBroadcastProgress(
  workspaceId: string,
  jobId: string,
): Promise<(WorkloadBroadcastProgress & { workspaceId: string }) | undefined> {
  const raw = await redis.get(key(workspaceId, jobId));
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as WorkloadBroadcastProgress & { workspaceId: string };
    return value && value.workspaceId === workspaceId && value.jobId === jobId ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function requestBroadcastCancellation(
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await redis.set(`${key(workspaceId, jobId)}:cancel`, "1", "EX", TTL_SECONDS);
}

export async function isBroadcastCancellationRequested(
  workspaceId: string,
  jobId: string,
): Promise<boolean> {
  return (await redis.get(`${key(workspaceId, jobId)}:cancel`)) === "1";
}

export async function clearBroadcastCancellation(
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await redis.del(`${key(workspaceId, jobId)}:cancel`);
}
