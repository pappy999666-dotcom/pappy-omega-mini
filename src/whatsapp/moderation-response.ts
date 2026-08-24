import { phoneJidFromIdentity } from "./identity-normalization.js";

export interface ModerationReply {
  text: string;
  mentions?: string[];
}

export function realMention(phone: string | undefined): string {
  return phone ? `@${phone}` : "Verified member unavailable";
}

export function withMentions(text: string, phones: string[] = []): ModerationReply {
  const mentions = [...new Set(phones.map((phone) => phoneJidFromIdentity(phone)).filter((jid): jid is string => Boolean(jid)))];
  return mentions.length ? { text, mentions } : { text };
}

function clean(value: string, limit = 240): string {
  return (value || "—").replace(/[\r\n]/gu, " ").slice(0, limit);
}

export function buildModerationWarningResponse(input: {
  title?: string;
  targetPhone: string;
  groupName: string;
  warningCount: number;
  warningThreshold: number;
  action: string;
  note: string;
}): ModerationReply {
  const text = [
    "ㅤ   ⚫︎  𝗦𝗬𝗦𝗧𝗘𝗠 𝗪𝗔𝗥𝗡𝗜𝗡𝗚  ⚫︎",
    "",
    `˗ˏˋ ⚠️ ˎˊ˗  *${(input.title ?? "MANUAL WARNING DETECTED").toUpperCase()}*  ✦`,
    "─────────────",
    `⎔ Target   · ⇆ ${realMention(input.targetPhone)}`,
    `⎔ Group    · ⇆ ${clean(input.groupName, 120)}`,
    `⎔ Action   · ⇆ ${clean(input.action, 80)}`,
    `⎔ Warnings · ⇆ ${input.warningCount} / ${input.warningThreshold}`,
    "─────────────",
    `» *Note:* ${clean(input.note)}`,
  ].join("\n");
  return withMentions(text, [input.targetPhone]);
}

export function buildModerationActionResponse(input: {
  title: string;
  action: string;
  groupName: string;
  targetPhone?: string;
  note: string;
}): ModerationReply {
  const text = [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ⎔ ˎˊ˗  *${input.title.toUpperCase()}*  ✦`,
    "─────────────",
    ...(input.targetPhone ? [`⎔ Target      · ⇆ ${realMention(input.targetPhone)}`] : []),
    `⎔ Action      · ⇆ ${clean(input.action, 100)}`,
    `⎔ Scope       · ⇆ ${clean(input.groupName, 120)}`,
    "─────────────",
    `» *Note:* ${clean(input.note)}`,
  ].join("\n");
  return withMentions(text, input.targetPhone ? [input.targetPhone] : []);
}

export function buildModerationReviewResponse(input: { action: string; selected: number; scope: string; phones?: string[] }): ModerationReply {
  const phones = [...new Set(input.phones ?? [])].filter(Boolean);
  const shownPhones = phones.slice(0, 20);
  const targetText = shownPhones.length
    ? shownPhones.map((phone) => realMention(phone)).join(", ") + (phones.length > shownPhones.length ? ` · +${phones.length - shownPhones.length} more` : "")
    : "Verified members";
  const text = [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ⎔ ˎˊ˗  *${input.action.toUpperCase()} REVIEW*  ✦`,
    "─────────────",
    `⎔ Targets     · ⇆ ${targetText}`,
    `⎔ Selected    · ⇆ ${input.selected}`,
    `⎔ Scope       · ⇆ ${clean(input.scope, 120)}`,
    "⎔ Status      · ⇆ Awaiting confirmation",
    "─────────────",
    "» *Note:* No action is queued until Confirm is tapped. This review expires in 90 seconds.",
  ].join("\n");
  return withMentions(text, shownPhones);
}

export function buildModerationJobResponse(input: { action: string; selected: number; jobId: string; phones?: string[] }): ModerationReply {
  const text = [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ ⚙︎ ˎˊ˗  *MEMBER BATCH JOB*  ✦",
    "─────────────",
    `⎔ Action    · ⇆ ${input.action.toUpperCase()}`,
    `⎔ Selected  · ⇆ ${input.selected}`,
    `⎔ Job ID    · ⇆ ${clean(input.jobId, 80)}`,
    "─────────────",
    "» *Progress:* Open Telegram Live Show for detailed results.",
  ].join("\n");
  return withMentions(text, input.phones ?? []);
}

export function formatModerationMessage(title: string, rows: Array<[string, string]>): string {
  const normalized = rows.map(([label, value]) => `⎔ ${label.padEnd(12, " ")} · ⇆ ${clean(value, 180)}`);
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ⎔ ˎˊ˗  *${title.toUpperCase()}*  ✦`,
    "─────────────",
    ...normalized,
    "─────────────",
    "» *Note:* This action is scoped to the current WhatsApp group.",
  ].join("\n");
}
