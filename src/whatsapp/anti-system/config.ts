import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "../../config/env.js";
import type {
  AntiAction,
  AntiCapability,
  AntiModuleConfig,
  AntiModuleKey,
  AntiSpamConfig,
  AntiStore,
  AntiWordsConfig,
  GroupAntiConfig,
  GroupSecurityMode,
  SecurityModuleConfig,
  TargetMode,
} from "./types.js";

const MODULE_KEYS: AntiModuleKey[] = [
  "antilink", "antibot", "antispam", "antipic", "antivid", "antiaud", "antivn",
  "antitxt", "antiemoji", "antisticker", "antigroupcall", "antinsfw",
  "antigroupmention", "antigm", "antiwords", "antipoll", "antiforward",
  "antichannel", "antipromote", "antidemote", "antigstatus",
];

const CAPABILITIES: Record<AntiModuleKey, { capability: AntiCapability; reason?: string }> = {
  antilink: { capability: "supported" },
  antibot: { capability: "local-only", reason: "Conservative raw message-key/client metadata heuristic; uncertain messages are ignored." },
  antispam: { capability: "supported" },
  antipic: { capability: "supported" },
  antivid: { capability: "supported" },
  antiaud: { capability: "supported" },
  antivn: { capability: "supported" },
  antitxt: { capability: "supported" },
  antiemoji: { capability: "supported" },
  antisticker: { capability: "supported" },
  antigroupcall: { capability: "unavailable", reason: "The current Mini socket adapter does not forward group-call events." },
  antinsfw: { capability: "unavailable", reason: "No NSFW provider is configured for Mini." },
  antigroupmention: { capability: "local-only", reason: "Available only when raw groupMentions metadata is present." },
  antigm: { capability: "local-only", reason: "Available only when a raw WhatsApp Status group-mention wrapper is present." },
  antiwords: { capability: "supported" },
  antipoll: { capability: "local-only", reason: "Available only for local raw poll messages; panel workers do not forward poll metadata." },
  antiforward: { capability: "local-only", reason: "Available only when raw forwarding context is retained." },
  antichannel: { capability: "local-only", reason: "Available only when raw newsletter/channel metadata is retained." },
  antipromote: { capability: "local-only", reason: "Local participant-update events are supported; panel workers must forward the raw event to enforce remotely." },
  antidemote: { capability: "local-only", reason: "Local participant-update events are supported; panel workers must forward the raw event to enforce remotely." },
  antigstatus: { capability: "local-only", reason: "Available only when raw group-status metadata is retained." },
};

const ACTION_DEFAULTS: Partial<Record<AntiModuleKey, AntiAction>> = {
  antispam: "kick",
  antipromote: "kick",
  antidemote: "kick",
};

const SECURITY_DEFAULT_MODE: GroupSecurityMode = "restorekick";

function defaultModule(key: AntiModuleKey): AntiModuleConfig {
  const capability = CAPABILITIES[key];
  return {
    enabled: false,
    action: ACTION_DEFAULTS[key] ?? "delete",
    warnThreshold: 3,
    permitList: [],
    capability: capability.capability,
    ...(capability.reason ? { capabilityReason: capability.reason } : {}),
  };
}

function defaultSecurityModule(key: "antipromote" | "antidemote"): SecurityModuleConfig {
  return {
    ...defaultModule(key),
    mode: SECURITY_DEFAULT_MODE,
    targetMode: key === "antidemote" ? "admins" : "admins",
  };
}

export function defaultGroupAntiConfig(workspaceId: string, sessionId: string, groupJid: string): GroupAntiConfig {
  return {
    schemaVersion: 1,
    workspaceId,
    sessionId,
    groupJid,
    silentActionMessages: false,
    messages: {},
    updatedAt: Date.now(),
  };
}

function configRoot(workspaceId: string, sessionId: string): string {
  return resolve(env.SESSION_ROOT, workspaceId, sessionId);
}

function configPath(workspaceId: string, sessionId: string): string {
  return join(configRoot(workspaceId, sessionId), "anti-groups.json");
}

function readStore(workspaceId: string, sessionId: string): AntiStore {
  const p = configPath(workspaceId, sessionId);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as AntiStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(workspaceId: string, sessionId: string, store: AntiStore): void {
  const p = configPath(workspaceId, sessionId);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, p);
}

export function loadGroupAntiConfig(workspaceId: string, sessionId: string, groupJid: string): GroupAntiConfig {
  const store = readStore(workspaceId, sessionId);
  const existing = store[groupJid];
  if (!existing) return defaultGroupAntiConfig(workspaceId, sessionId, groupJid);
  return {
    ...defaultGroupAntiConfig(workspaceId, sessionId, groupJid),
    ...existing,
    workspaceId,
    sessionId,
    groupJid,
    messages: { ...(existing.messages ?? {}) },
  };
}

export function saveGroupAntiConfig(config: GroupAntiConfig): void {
  const store = readStore(config.workspaceId, config.sessionId);
  store[config.groupJid] = { ...config, schemaVersion: 1, updatedAt: Date.now() };
  writeStore(config.workspaceId, config.sessionId, store);
}

export function getModuleConfig(workspaceId: string, sessionId: string, groupJid: string, key: AntiModuleKey): AntiModuleConfig | undefined {
  return loadGroupAntiConfig(workspaceId, sessionId, groupJid)[key] as AntiModuleConfig | undefined;
}

export function ensureModule(config: GroupAntiConfig, key: AntiModuleKey): AntiModuleConfig {
  const existing = config[key] as AntiModuleConfig | undefined;
  if (existing) return existing;
  const created = key === "antipromote" || key === "antidemote"
    ? defaultSecurityModule(key)
    : key === "antispam"
      ? { ...defaultModule(key), messageLimit: 10, windowSeconds: 5 }
      : key === "antiwords"
        ? { ...defaultModule(key), words: [] }
        : defaultModule(key);
  (config as unknown as Record<string, unknown>)[key] = created;
  return created;
}

export function allModuleKeys(): AntiModuleKey[] {
  return [...MODULE_KEYS];
}

export function moduleCapability(key: AntiModuleKey): { capability: AntiCapability; reason?: string } {
  return { ...CAPABILITIES[key] };
}

export function updateModule(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  key: AntiModuleKey,
  patch: Partial<AntiModuleConfig> & Partial<AntiSpamConfig> & Partial<AntiWordsConfig> & Partial<SecurityModuleConfig>,
): GroupAntiConfig {
  const config = loadGroupAntiConfig(workspaceId, sessionId, groupJid);
  const module = ensureModule(config, key);
  Object.assign(module, patch);
  saveGroupAntiConfig(config);
  return config;
}

export function setPermit(config: GroupAntiConfig, key: AntiModuleKey, number: string, enabled: boolean): void {
  const module = ensureModule(config, key);
  const next = new Set(module.permitList ?? []);
  if (enabled) next.add(number); else next.delete(number);
  module.permitList = [...next];
  saveGroupAntiConfig(config);
}

export function setCustomMessage(config: GroupAntiConfig, key: string, message: string): void {
  config.messages[key] = message;
  const module = config[key as AntiModuleKey] as AntiModuleConfig | undefined;
  if (module) module.customMessage = message;
  saveGroupAntiConfig(config);
}

export function setSpamLimit(config: GroupAntiConfig, messageLimit: number, windowSeconds: number): void {
  const module = ensureModule(config, "antispam") as AntiSpamConfig;
  module.messageLimit = Math.max(1, Math.min(1000, Math.floor(messageLimit)));
  module.windowSeconds = Math.max(1, Math.min(3600, Math.floor(windowSeconds)));
  saveGroupAntiConfig(config);
}

export function addWords(config: GroupAntiConfig, words: string[], enable = false): string[] {
  const module = ensureModule(config, "antiwords") as AntiWordsConfig;
  const current = new Set(module.words ?? []);
  const added: string[] = [];
  for (const raw of words) {
    const word = raw.trim().toLocaleLowerCase();
    if (word && !current.has(word)) { current.add(word); added.push(word); }
  }
  module.words = [...current];
  if (enable) module.enabled = true;
  saveGroupAntiConfig(config);
  return added;
}

export function removeWords(config: GroupAntiConfig, words: string[]): string[] {
  const module = ensureModule(config, "antiwords") as AntiWordsConfig;
  const current = new Set(module.words ?? []);
  const removed = words.map((word) => word.trim().toLocaleLowerCase()).filter((word) => word && current.delete(word));
  module.words = [...current];
  saveGroupAntiConfig(config);
  return removed;
}

export function clearWords(config: GroupAntiConfig): number {
  const module = ensureModule(config, "antiwords") as AntiWordsConfig;
  const count = module.words.length;
  module.words = [];
  saveGroupAntiConfig(config);
  return count;
}

export function setSilentActionMessages(config: GroupAntiConfig, enabled: boolean): void {
  config.silentActionMessages = enabled;
  saveGroupAntiConfig(config);
}

export function getCustomMessage(config: GroupAntiConfig, key: string): string | undefined {
  return config.messages[key] ?? (config[key as AntiModuleKey] as AntiModuleConfig | undefined)?.customMessage;
}

const warnCounts = new Map<string, number>();
const spamWindows = new Map<string, number[]>();

export function incrementWarn(workspaceId: string, sessionId: string, groupJid: string, sender: string, module: string): number {
  const key = `${workspaceId}:${sessionId}:${groupJid}:${sender}:${module}`;
  const count = (warnCounts.get(key) ?? 0) + 1;
  warnCounts.set(key, count);
  return count;
}

export function resetWarn(workspaceId: string, sessionId: string, groupJid: string, sender: string, module: string): void {
  warnCounts.delete(`${workspaceId}:${sessionId}:${groupJid}:${sender}:${module}`);
}

export function recordSpam(workspaceId: string, sessionId: string, groupJid: string, sender: string, windowSeconds: number): number {
  const key = `${workspaceId}:${sessionId}:${groupJid}:${sender}`;
  const cutoff = Date.now() - windowSeconds * 1000;
  const values = (spamWindows.get(key) ?? []).filter((value) => value > cutoff);
  values.push(Date.now());
  spamWindows.set(key, values);
  return values.length;
}

export function resetSpam(workspaceId: string, sessionId: string, groupJid: string, sender: string): void {
  spamWindows.delete(`${workspaceId}:${sessionId}:${groupJid}:${sender}`);
}
