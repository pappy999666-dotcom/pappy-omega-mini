import { firstVerifiedPhone, phoneJidFromIdentity } from "../identity-normalization.js";
import type { AntiModuleKey } from "./types.js";

const MODULE_LABELS: Record<AntiModuleKey, string> = {
  antilink: "AntiLink", antibot: "AntiBot", antispam: "AntiSpam", antipic: "AntiPic",
  antivid: "AntiVid", antiaud: "AntiAud", antivn: "AntiVN", antitxt: "AntiText",
  antiemoji: "AntiEmoji", antisticker: "AntiSticker", antigroupcall: "AntiGroupCall",
  antinsfw: "AntiNSFW", antigroupmention: "AntiGroupMention", antigm: "AntiGM",
  antiwords: "AntiWords", antipoll: "AntiPoll", antiforward: "AntiForward",
  antichannel: "AntiChannel", antipromote: "AntiPromote", antidemote: "AntiDemote",
  antigstatus: "AntiGStatus",
};

export function antiModuleLabel(key: AntiModuleKey): string {
  return MODULE_LABELS[key] ?? `Anti${key.slice(3)}`;
}

function clean(value: string, limit = 120): string {
  return (value || "—").replace(/[\r\n]/gu, " ").slice(0, limit);
}

function actionLabel(action: string): string {
  if (action === "warn") return "Violation Logged";
  if (action === "kick") return "Member Removed";
  if (action === "block") return "Member Blocked";
  if (action === "restore") return "Change Reverted";
  return "Message Deleted";
}

export function buildAntiViolationResponse(input: {
  key: AntiModuleKey;
  action: string;
  senderJid: string;
  groupName: string;
  warningCount?: number;
  warnThreshold?: number;
  note?: string;
}): { text: string; mentions?: string[] } {
  const phone = firstVerifiedPhone(input.senderJid);
  const mention = phone ? `@${phone}` : "Verified member unavailable";
  const mentionJid = phoneJidFromIdentity(phone);
  const warningValue = input.warningCount === undefined
    ? "—"
    : `${input.warningCount} / ${input.warnThreshold ?? 3}`;
  const note = input.note ?? (input.warningCount !== undefined
    ? `Reaching ${input.warnThreshold ?? 3} warnings will trigger an automatic kick.`
    : "This action was isolated to this group.");
  const text = [
    "ㅤ   ⚫︎  𝗦𝗬𝗦𝗧𝗘𝗠 𝗪𝗔𝗥𝗡𝗜𝗡𝗚  ⚫︎",
    "",
    `˗ˏˋ ⚠️ ˎˊ˗  *${input.key === "antigstatus" ? "ANTIGROUPSTATUS" : antiModuleLabel(input.key).toUpperCase()} DETECTED*  ✦`,
    "─────────────",
    `⎔ Target   · ⇆ ${mention}`,
    `⎔ Group    · ⇆ ${clean(input.groupName)}`,
    `⎔ Action   · ⇆ ${actionLabel(input.action)}`,
    `⎔ Warnings · ⇆ ${warningValue}`,
    "─────────────",
    `» *Note:* ${clean(note, 240)}`,
  ].join("\n");
  return mentionJid ? { text, mentions: [mentionJid] } : { text };
}

export function buildAntiSecurityResponse(input: {
  key: "antipromote" | "antidemote";
  action: string;
  actorJid?: string;
  groupName: string;
  warningCount?: number;
  warnThreshold?: number;
  note?: string;
}): { text: string; mentions?: string[] } {
  return buildAntiViolationResponse({
    key: input.key,
    action: input.action,
    senderJid: input.actorJid ?? "",
    groupName: input.groupName,
    ...(input.warningCount !== undefined ? { warningCount: input.warningCount } : {}),
    ...(input.warnThreshold !== undefined ? { warnThreshold: input.warnThreshold } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
}

function defaultUsage(key: AntiModuleKey): string[] {
  const command = `.${key}`;
  if (key === "antipromote" || key === "antidemote") return [
    `${command} restorekick  (Restores the admin change and removes the actor)`,
    `${command} warn 3        (Warns before escalation)`,
    `${command} off           (Disables protection)`,
  ];
  if (key === "antiwords") return [
    `${command} delete [word]  (Removes matching messages)`,
    `${command} warn 3 [word]  (Warns and escalates at 3)`,
    `${command} kick [word]    (Removes the sender)`,
    `${command} off            (Disables protection)`,
  ];
  return [
    `${command} delete  (Removes matching messages)`,
    `${command} warn 3  (Warns and escalates at 3)`,
    `${command} kick    (Removes the sender)`,
    `${command} off     (Disables protection)`,
  ];
}

export function buildAntiModuleResponse(input: {
  key: AntiModuleKey;
  enabled: boolean;
  action?: string;
  capability?: string;
  note?: string;
  usage?: string[];
  configStyle?: boolean;
}): string {
  const name = antiModuleLabel(input.key).toUpperCase();
  const status = input.enabled ? `Enabled [ ${input.action ?? "delete"} ]` : "Disabled [ off ]";
  const rawCapability = input.capability ?? "local-only";
  const capability = rawCapability === "supported" ? "Native" : rawCapability === "local-only" ? "Local-only" : rawCapability === "unavailable" ? "Unavailable" : clean(rawCapability);
  const note = clean(input.note ?? (input.enabled ? "Available for this group." : "Module is disabled for this group."), 240);
  const usage = input.usage ?? defaultUsage(input.key);
  if (input.configStyle) {
    return [
      `⌬ ⤷ *${name} CONFIG* ⚙︎`,
      "",
      "─────────────",
      `⎔ Mode        · ⇆ ${status}`,
      "⎔ Scope       · ⇆ This group only",
      `⎔ Access      · ⇆ ${capability}`,
      "─────────────",
      "» *How to use:*",
      ...usage.map((line) => `· ${line}`),
      `» *Note:* ${note}`,
    ].join("\n");
  }
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ⎔ ˎˊ˗  *${name} MODULE*  ✦`,
    "─────────────",
    `⎔ Status      · ⇆ ${status}`,
    "⎔ Scope       · ⇆ This group only",
    `⎔ Capability  · ⇆ ${capability}`,
    "─────────────",
    `» *Note:* ${note}`,
  ].join("\n");
}
