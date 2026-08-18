import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../config/env.js";

export interface WorkspaceSettings {
  workspaceId: string;
  defaultPrefix: string;
  defaultAutoJoinEnabled: boolean;
  defaultJoinDelayMs: number;
  defaultJoinTargetCount: number;
  defaultJoinBatchCycles: number;
  defaultJoinMaxConcurrency: number;
  defaultJoinRetryLimit: number;
  timezone: string;
  updatedAt: number;
}

const settingsPath = join(env.SESSION_ROOT, "..", "workspace-settings.json");
const settings = new Map<string, WorkspaceSettings>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(
      readFileSync(settingsPath, "utf8"),
    ) as WorkspaceSettings[];
    for (const item of parsed) settings.set(item.workspaceId, item);
  } catch {
    // First boot or unreadable legacy store: use safe defaults and repair on write.
  }
}

export function getWorkspaceSettings(workspaceId: string): WorkspaceSettings {
  ensureLoaded();
  const existing = settings.get(workspaceId);
  if (existing)
    return {
      ...existing,
      defaultJoinTargetCount: existing.defaultJoinTargetCount ?? 100,
      defaultJoinBatchCycles: existing.defaultJoinBatchCycles ?? 1,
      defaultJoinMaxConcurrency: existing.defaultJoinMaxConcurrency ?? 2,
      defaultJoinRetryLimit: existing.defaultJoinRetryLimit ?? 2,
    };
  const created: WorkspaceSettings = {
    workspaceId,
    defaultPrefix: ".",
    defaultAutoJoinEnabled: false,
    defaultJoinDelayMs: 5000,
    defaultJoinTargetCount: 100,
    defaultJoinBatchCycles: 1,
    defaultJoinMaxConcurrency: 2,
    defaultJoinRetryLimit: 2,
    timezone: "UTC",
    updatedAt: Date.now(),
  };
  settings.set(workspaceId, created);
  persist();
  return { ...created };
}

export function updateWorkspaceSettings(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceSettings, "workspaceId" | "updatedAt">>,
): WorkspaceSettings {
  const current = getWorkspaceSettings(workspaceId);
  const next: WorkspaceSettings = {
    ...current,
    ...patch,
    workspaceId,
    defaultPrefix: String(patch.defaultPrefix ?? current.defaultPrefix).slice(
      0,
      3,
    ),
    defaultJoinDelayMs: Math.max(
      0,
      Math.min(
        600000,
        Number(patch.defaultJoinDelayMs ?? current.defaultJoinDelayMs),
      ),
    ),
    defaultJoinTargetCount: Math.max(
      1,
      Math.min(
        10000,
        Number(
          patch.defaultJoinTargetCount ?? current.defaultJoinTargetCount ?? 100,
        ),
      ),
    ),
    defaultJoinBatchCycles: Math.max(
      1,
      Math.min(
        20,
        Number(
          patch.defaultJoinBatchCycles ?? current.defaultJoinBatchCycles ?? 1,
        ),
      ),
    ),
    defaultJoinMaxConcurrency: Math.max(
      1,
      Math.min(
        10,
        Number(
          patch.defaultJoinMaxConcurrency ??
            current.defaultJoinMaxConcurrency ??
            2,
        ),
      ),
    ),
    defaultJoinRetryLimit: Math.max(
      0,
      Math.min(
        5,
        Number(
          patch.defaultJoinRetryLimit ?? current.defaultJoinRetryLimit ?? 2,
        ),
      ),
    ),
    updatedAt: Date.now(),
  };
  settings.set(workspaceId, next);
  persist();
  return { ...next };
}

function persist(): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify([...settings.values()], null, 2), {
    mode: 0o600,
  });
}
