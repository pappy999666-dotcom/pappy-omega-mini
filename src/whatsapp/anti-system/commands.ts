import type { CommandContext, RegisteredCommand } from "../command-registry.js";
import {
  addWords,
  clearWords,
  ensureModule,
  getCustomMessage,
  loadGroupAntiConfig,
  removeWords,
  saveGroupAntiConfig,
  setCustomMessage,
  setPermit,
  setSilentActionMessages,
  setSpamLimit,
  updateModule,
} from "./config.js";
import { antiStatusRows } from "./engine.js";
import type { AntiAction, AntiModuleKey, GroupSecurityMode, TargetMode } from "./types.js";
import { firstVerifiedPhone, phoneJidFromIdentity, verifiedTargetPhone } from "../identity-normalization.js";
import { antiModuleLabel, buildAntiModuleResponse } from "./response-format.js";
import { commandUsageCard } from "../response-cards.js";
import { formatModerationMessage } from "../moderation-response.js";

const MODULE_LABELS: Record<AntiModuleKey, string> = {
  antilink: "AntiLink", antibot: "AntiBot", antispam: "AntiSpam", antipic: "AntiPic",
  antivid: "AntiVid", antiaud: "AntiAud", antivn: "AntiVN", antitxt: "AntiText",
  antiemoji: "AntiEmoji", antisticker: "AntiSticker", antigroupcall: "AntiGroupCall",
  antinsfw: "AntiNSFW", antigroupmention: "AntiGroupMention", antigm: "AntiGM",
  antiwords: "AntiWords", antipoll: "AntiPoll", antiforward: "AntiForward",
  antichannel: "AntiChannel", antipromote: "AntiPromote", antidemote: "AntiDemote",
  antigstatus: "AntiGStatus",
};

const MODULE_KEYS = new Set<AntiModuleKey>(Object.keys(MODULE_LABELS) as AntiModuleKey[]);

function requireGroup(ctx: CommandContext): string {
  if (!ctx.chatJid?.endsWith("@g.us")) throw new Error("This Anti System command must be used inside a WhatsApp group.");
  return ctx.chatJid;
}

function normalizeIdentity(value: string): string {
  return phoneJidFromIdentity(value) ?? "";
}

function sameIdentity(left: string, right: string): boolean {
  const leftDigits = firstVerifiedPhone(left);
  const rightDigits = firstVerifiedPhone(right);
  return Boolean(leftDigits && rightDigits && leftDigits === rightDigits);
}

async function requireGroupAdmin(ctx: CommandContext): Promise<string> {
  const groupJid = requireGroup(ctx);
  const { getGroupModerationSnapshot } = await import("../transport-adapter.js");
  const snapshot = await getGroupModerationSnapshot(ctx.workspaceId, ctx.sessionId, groupJid, { fresh: true });
  if (!snapshot.isAdmin) throw new Error("This WhatsApp identity is not an administrator in this group.");
  if (ctx.isOwner) return groupJid;
  const actor = ctx.senderJid ?? "";
  const isAdmin = snapshot.participants.some((participant) =>
    (participant.admin === "admin" || participant.admin === "superadmin") && sameIdentity(participant.jid ?? participant.id, actor));
  if (!isAdmin) throw new Error("Group administrator permission is required for Anti System settings.");
  return groupJid;
}

function targetIdentity(ctx: CommandContext): string {
  return phoneJidFromIdentity(verifiedTargetPhone(ctx.args, ctx.mentionedJids, ctx.quotedSenderJid) ?? "") ?? "";
}

function parseAction(value: string | undefined): AntiAction | undefined {
  return value === "kick" || value === "warn" || value === "delete" ? value : undefined;
}

function label(key: AntiModuleKey): string {
  return MODULE_LABELS[key];
}

function header(title: string): string {
  return `✦ PAPPY OMEGA MINI · ${title}\n─────────────────────`;
}

export async function antiStatus(ctx: CommandContext): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const rows = antiStatusRows(ctx.workspaceId, ctx.sessionId, groupJid);
  const enabled = rows.filter((row) => row.enabled).length;
  const lines = rows.map((row) => {
    const state = row.enabled ? `Enabled [ ${row.action} ]` : "Disabled [ off ]";
    const capability = row.capability === "supported" ? "Native" : row.capability === "local-only" ? "Local-only" : "Unavailable";
    return `⎔ ${antiModuleLabel(row.key).padEnd(18, " ")} · ⇆ ${state} · ${capability}`;
  });
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ 🛡️ ˎˊ˗  *ANTI SYSTEM STATUS*  ✦",
    "─────────────",
    `⎔ Enabled     · ⇆ ${enabled} / ${rows.length} modules`,
    "⎔ Scope       · ⇆ This group only",
    "⎔ Access      · ⇆ Local-only",
    "─────────────",
    ...lines,
    "─────────────",
    "» *Note:* Unavailable signals are reported honestly and never approximated.",
  ].join("\n");
}

export async function configureAnti(ctx: CommandContext, key: AntiModuleKey): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const args = ctx.args.map((value) => value.toLowerCase());
  if (key === "antipromote" || key === "antidemote") return configureSecurity(ctx, key, args, groupJid);
  const action = parseAction(args[0]);
  if (args[0] === "off") {
    const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
    ensureModule(config, key).enabled = false;
    saveGroupAntiConfig(config);
    return buildAntiModuleResponse({ key, enabled: false, capability: "local-only", note: "Module is disabled for this group.", configStyle: true });
  }
  if (!action) return buildAntiModuleResponse({ key, enabled: false, capability: "local-only", note: "Choose one of the supported protection actions below.", configStyle: true });
  const threshold = action === "warn" ? Number(args[1] ?? 3) : 3;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) return buildAntiModuleResponse({ key, enabled: false, capability: "local-only", note: "Warn threshold must be an integer from 1 to 100.", configStyle: true });
  const updated = updateModule(ctx.workspaceId, ctx.sessionId, groupJid, key, { enabled: true, action, warnThreshold: threshold });
  const module = updated[key] as { capability?: string; capabilityReason?: string } | undefined;
  return buildAntiModuleResponse({
    key,
    enabled: true,
    action,
    capability: module?.capability ?? "local-only",
    note: action === "warn" ? `Reaching ${threshold} warnings will trigger an automatic kick.` : module?.capabilityReason ?? "Available for this group.",
    configStyle: true,
  });
}

async function configureSecurity(ctx: CommandContext, key: "antipromote" | "antidemote", args: string[], groupJid: string): Promise<string> {
  const first = args[0] ?? "";
  if (first === "off") {
    updateModule(ctx.workspaceId, ctx.sessionId, groupJid, key, { enabled: false });
    return buildAntiModuleResponse({ key, enabled: false, action: "off", capability: "local-only", note: "Module is disabled for this group.", configStyle: true });
  }
  if (first === "protected" || first === "admins") {
    updateModule(ctx.workspaceId, ctx.sessionId, groupJid, key, { targetMode: first as TargetMode });
    return buildAntiModuleResponse({ key, enabled: true, action: `target ${first}`, capability: "local-only", note: `Protected target mode: ${first}.`, configStyle: true });
  }
  const modes = new Set<GroupSecurityMode>(["restore", "restorewarn", "restorekick", "restoreban", "revert", "warn", "kick", "ban", "knp", "kwp", "dnp", "dwp", "jw", "wnp", "d/p", "d/d", "p/p", "p/k"]);
  const mode = first.match(/^restorewarn:\d+$/)?.[0] ?? first;
  if (!modes.has(mode as GroupSecurityMode)) return buildAntiModuleResponse({ key, enabled: false, capability: "local-only", note: "Choose one of the supported participant-event security modes below.", configStyle: true });
  updateModule(ctx.workspaceId, ctx.sessionId, groupJid, key, { enabled: true, mode: mode as GroupSecurityMode, targetMode: "admins", action: "kick" });
  return buildAntiModuleResponse({ key, enabled: true, action: `mode ${mode}`, capability: "local-only", note: "Participant-event enforcement is isolated to this group.", configStyle: true });
}

export async function antiPermit(ctx: CommandContext, key: AntiModuleKey, enabled: boolean): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const identity = targetIdentity(ctx);
  if (!identity) return commandUsageCard({ title: "Permit Command", command: `.${key}permit`, commandSyntax: `.${key}permit add|remove <target>`, acceptedTargets: ["Tag / Mention · Real WhatsApp mention", "Reply · Reply to a verified phone identity", "Phone · Explicit international number"], note: "LID-only identities are not accepted." });
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  ensureModule(config, key);
  setPermit(config, key, identity, enabled);
  return buildAntiModuleResponse({ key, enabled: true, action: enabled ? "permit added" : "permit removed", capability: "local-only", note: `${enabled ? "Permit added" : "Permit removed"} for the verified target in this group.` });
}

export async function antiMessage(ctx: CommandContext, key: AntiModuleKey): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const message = (ctx.rawPayload ?? ctx.args.join(" ")).trim() || (ctx.quotedText ?? "").trim();
  if (!message) return commandUsageCard({ title: `${label(key)} Message`, command: `.${key}msg`, commandSyntax: `.${key}msg <text>`, howToUse: ["Send text after the command.", "Or reply to a message to save its text."], note: "The custom response is scoped to this group." });
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  ensureModule(config, key);
  setCustomMessage(config, key, message.slice(0, 500));
  return formatModerationMessage(`${label(key)} MESSAGE SAVED`, [["Scope", "This group only"], ["Variables", "@mention, &gcname, &desc"]]);
}

export async function antiSpamLimit(ctx: CommandContext): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const limit = Number(ctx.args[0]);
  const seconds = Number(ctx.args[1]);
  if (!Number.isInteger(limit) || !Number.isInteger(seconds) || limit < 1 || seconds < 1) return commandUsageCard({ title: "AntiSpam Limit", command: ".spamlimit", commandSyntax: ".spamlimit <messages> <seconds>", examples: [".spamlimit 5 10"], note: "Set the message count and time window for this group." });
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  setSpamLimit(config, limit, seconds);
  return formatModerationMessage("ANTISPAM LIMIT", [["Window", `${limit} messages in ${seconds} seconds`], ["Scope", "This group only"]]);
}

export async function antiWords(ctx: CommandContext): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  const action = (ctx.args[0] ?? "").toLowerCase();
  if (action === "off") {
    ensureModule(config, "antiwords").enabled = false;
    saveGroupAntiConfig(config);
    return buildAntiModuleResponse({ key: "antiwords", enabled: false, capability: "local-only", note: "Module is disabled for this group.", configStyle: true });
  }
  const parsed = parseAction(action);
  if (!parsed) return commandUsageCard({ title: "AntiWords", command: ".antiwords", commandSyntax: ".antiwords <kick|warn N|delete|off> [words]", howToUse: ["Enclose blocked words in brackets, for example [scam, free money].", "Management: .antiaddword, .antirmword, .antiwordlist, .setantiwords, .rmantiwords, .clearantiwords."], note: "Configuration is scoped to this group." });
  const threshold = parsed === "warn" ? Number(ctx.args[1] ?? 3) : 3;
  const wordsText = parsed === "warn" ? ctx.args.slice(2).join(" ") : ctx.args.slice(1).join(" ");
  if (!wordsText.startsWith("[") || !wordsText.endsWith("]")) return commandUsageCard({ title: "AntiWords", command: ".antiwords", commandSyntax: ".antiwords <kick|warn N|delete|off> [words]", examples: [".antiwords delete [scam, free money]"], note: "Words must be enclosed in brackets." });
  const words = wordsText.slice(1, -1).split(",").map((word) => word.trim()).filter(Boolean);
  const module = ensureModule(config, "antiwords");
  if (!("words" in module)) (module as typeof module & { words: string[] }).words = [];
  const wordsModule = module as typeof module & { words: string[] };
  wordsModule.enabled = true; wordsModule.action = parsed; wordsModule.warnThreshold = Number.isInteger(threshold) && threshold > 0 ? threshold : 3; wordsModule.words = [...new Set(words.map((word) => word.toLocaleLowerCase()))];
  saveGroupAntiConfig(config);
  return buildAntiModuleResponse({ key: "antiwords", enabled: true, action: parsed === "warn" ? `warn ${wordsModule.warnThreshold}` : parsed, capability: "local-only", note: `${wordsModule.words.length} blocked word(s) configured for this group.` , configStyle: true });
}

export async function antiWordManagement(ctx: CommandContext, operation: "add" | "remove" | "list" | "set" | "rmset" | "clear"): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  const input = (ctx.rawPayload ?? ctx.args.join(" ")).trim();
  if (operation === "list") {
    const words = config.antiwords?.words ?? [];
    return formatModerationMessage("ANTIWORDS LIST", [["Blocked", words.length ? words.map((word, index) => `${index + 1}. ${word}`).join(", ") : "No blocked words configured."]]);
  }
  if (operation === "clear") return formatModerationMessage("ANTIWORDS CLEAR", [["Removed", `${clearWords(config)} blocked word(s)`]]);
  if (!input) return commandUsageCard({ title: "AntiWords Management", command: `.${operation === "remove" ? "antirmword" : operation === "set" ? "setantiwords" : "antiaddword"}`, commandSyntax: `.${operation === "remove" ? "antirmword" : operation === "set" ? "setantiwords" : "antiaddword"} <word[,word...]>`, note: "Provide one word or a comma-separated list." });
  const words = input.split(",").map((word) => word.trim()).filter(Boolean);
  const changed = operation === "add" || operation === "set" ? addWords(config, words, operation === "set") : removeWords(config, words);
  return formatModerationMessage("ANTIWORDS UPDATED", [["Action", operation], ["Changed", String(changed.length)], ["Words", changed.join(", ") || "No changes."]]);
}

export async function antiSilent(ctx: CommandContext): Promise<string> {
  const groupJid = await requireGroupAdmin(ctx);
  const mode = (ctx.args[0] ?? "status").toLowerCase();
  const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
  if (!["on", "off", "status"].includes(mode)) return commandUsageCard({ title: "Silent Actions", command: ".silentactions", commandSyntax: ".silentactions <on|off|status>", note: "Choose whether enforcement notices are visible while enforcement remains active." });
  if (mode === "status") return formatModerationMessage("SILENT ACTIONS", [["Notices", config.silentActionMessages ? "Silent" : "Visible"], ["Enforcement", "Remains active"]]);
  setSilentActionMessages(config, mode === "on");
  return formatModerationMessage("SILENT ACTIONS", [["Notices", mode === "on" ? "Silent" : "Visible"], ["Enforcement", "Remains active"]]);
}

function moduleCommand(key: AntiModuleKey, aliases: string[] = []): RegisteredCommand {
  return { name: key, aliases, description: `${label(key)} group control.`, run: (ctx) => configureAnti(ctx, key) };
}

export function createAntiCommandEntries(): RegisteredCommand[] {
  const entries: RegisteredCommand[] = [
    { name: "antistatus", aliases: [], description: "Show all Anti System module status for this group.", run: antiStatus },
    { name: "spamlimit", aliases: [], description: "Set AntiSpam messages and seconds window.", run: antiSpamLimit },
    { name: "antiwords", aliases: [], description: "Configure AntiWords and its bracketed list.", run: antiWords },
    { name: "antiaddword", aliases: [], description: "Add a blocked AntiWords phrase.", run: (ctx) => antiWordManagement(ctx, "add") },
    { name: "antirmword", aliases: [], description: "Remove a blocked AntiWords phrase.", run: (ctx) => antiWordManagement(ctx, "remove") },
    { name: "antiwordlist", aliases: [], description: "List blocked AntiWords phrases.", run: (ctx) => antiWordManagement(ctx, "list") },
    { name: "setantiwords", aliases: [], description: "Append comma-separated AntiWords phrases.", run: (ctx) => antiWordManagement(ctx, "set") },
    { name: "rmantiwords", aliases: [], description: "Remove comma-separated AntiWords phrases.", run: (ctx) => antiWordManagement(ctx, "rmset") },
    { name: "clearantiwords", aliases: [], description: "Clear all AntiWords phrases.", run: (ctx) => antiWordManagement(ctx, "clear") },
    { name: "silentactions", aliases: [], description: "Hide or show Anti System notices.", run: antiSilent },
  ];

  const configKeys: AntiModuleKey[] = ["antilink", "antibot", "antispam", "antipic", "antivid", "antiaud", "antivn", "antitxt", "antiemoji", "antisticker", "antigroupcall", "antinsfw", "antigroupmention", "antigm", "antipoll", "antiforward", "antichannel", "antipromote", "antidemote", "antigstatus"];
  for (const key of configKeys) entries.push(moduleCommand(key, key === "antitxt" ? ["antitext"] : []));

  const permits: Array<[string, string, AntiModuleKey, boolean]> = [
    ["linkpermit", "rmlinkpermit", "antilink", true], ["botpermit", "rmbotpermit", "antibot", true], ["spampermit", "rmspampermit", "antispam", true],
    ["picpermit", "rmpicpermit", "antipic", true], ["vidpermit", "rmvidpermit", "antivid", true], ["audpermit", "rmaudpermit", "antiaud", true],
    ["vnpermit", "rmvnpermit", "antivn", true], ["emojipermit", "rmemojipermit", "antiemoji", true], ["sticpermit", "rmsticpermit", "antisticker", true],
    ["nsfwpermit", "rmnsfwpermit", "antinsfw", true], ["mentionpermit", "rmmentionpermit", "antigroupmention", true], ["gmpermit", "rmgmpermit", "antigroupmention", true],
    ["pollpermit", "rmpollpermit", "antipoll", true], ["fwdpermit", "rmfwdpermit", "antiforward", true], ["chanpermit", "rmchanpermit", "antichannel", true],
  ];
  for (const [addName, removeName, key] of permits) {
    entries.push({ name: addName, aliases: [], description: `Permit a member for ${label(key)}.`, run: (ctx) => antiPermit(ctx, key, true) });
    entries.push({ name: removeName, aliases: [], description: `Remove a ${label(key)} permit.`, run: (ctx) => antiPermit(ctx, key, false) });
  }

  const messageKeys: AntiModuleKey[] = ["antilink", "antispam", "antivn", "antitxt", "antiemoji", "antiwords", "antigroupmention", "antigm", "antipoll", "antiforward", "antichannel", "antigstatus"];
  for (const key of messageKeys) entries.push({ name: `${key}msg`, aliases: [], description: `Set a custom ${label(key)} response.`, run: (ctx) => antiMessage(ctx, key) });
  return entries;
}

export function antiModuleKey(value: string): AntiModuleKey | undefined {
  return MODULE_KEYS.has(value as AntiModuleKey) ? value as AntiModuleKey : undefined;
}

export function antiCustomMessagePreview(ctx: CommandContext, key: AntiModuleKey): Promise<string> {
  return (async () => {
    const groupJid = await requireGroupAdmin(ctx);
    const config = loadGroupAntiConfig(ctx.workspaceId, ctx.sessionId, groupJid);
    return `${header(`${label(key)} MESSAGE`)}\n${getCustomMessage(config, key) ?? "No custom message configured."}`;
  })();
}
