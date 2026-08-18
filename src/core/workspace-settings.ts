import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../config/env.js";

export interface WorkspaceSettings {
  workspaceId: string;
  defaultPrefix: string;
  defaultAutoJoinEnabled: boolean;
  defaultJoinDelayMs: number;
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
  if (existing) return { ...existing };
  const created: WorkspaceSettings = {
    workspaceId,
    defaultPrefix: ".",
    defaultAutoJoinEnabled: false,
    defaultJoinDelayMs: 5000,
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
