import { pappyHeader } from "./response-designs.js";

function clean(value: string, limit = 240): string {
  return (value || "—").replace(/[\r\n]/gu, " ").slice(0, limit);
}

export interface CommandUsageCardInput {
  title: string;
  command: string;
  commandSyntax?: string;
  acceptedTargets?: string[];
  examples?: string[];
  howToUse?: string[];
  note?: string;
}

export function commandUsageCard(input: CommandUsageCardInput): string {
  const lines = [
    ...pappyHeader(input.command, input.title),
    `⎔ Command · ⇆ ${input.commandSyntax ?? input.command}`,
    "─────────────",
  ];
  if (input.acceptedTargets?.length) {
    lines.push("» *Accepted Targets:*");
    lines.push(...input.acceptedTargets.map((line) => `◈ ${line}`));
    lines.push("");
  }
  if (input.examples?.length) {
    lines.push("» *Examples:*");
    lines.push(...input.examples.map((line) => `» ${line}`));
    lines.push("");
  }
  if (input.howToUse?.length) {
    lines.push("» *How to use:*");
    lines.push(...input.howToUse.map((line) => `· ${line}`));
    lines.push("");
  }
  if (input.note) lines.push(`» *Note:* ${clean(input.note)}`);
  if (!input.note && !input.acceptedTargets?.length && !input.examples?.length && !input.howToUse?.length)
    lines.push("» *Note:* Use the command syntax above and provide verified, supported input.");
  return lines.join("\n").replace(/\n+$/u, "");
}

function applySessionPrefix(value: string, prefix: string): string {
  return value.replace(/(^|[\s·])\.([a-z][a-z0-9]*)/giu, (_match, boundary: string, name: string) => `${boundary}${prefix}${name}`);
}

export function sessionCommandUsageCard(prefix: string, input: CommandUsageCardInput): string {
  const transform = (value: string): string => applySessionPrefix(value, prefix);
  return commandUsageCard({
    ...input,
    command: transform(input.command),
    ...(input.commandSyntax ? { commandSyntax: transform(input.commandSyntax) } : {}),
    ...(input.acceptedTargets ? { acceptedTargets: input.acceptedTargets.map(transform) } : {}),
    ...(input.examples ? { examples: input.examples.map(transform) } : {}),
    ...(input.howToUse ? { howToUse: input.howToUse.map(transform) } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
}

export function banUsageCard(prefix = "."): string {
  return sessionCommandUsageCard(prefix, {
    title: "Ban Command",
    command: ".ban",
    commandSyntax: ".ban <target>",
    acceptedTargets: [
      "Phone Number  · .ban +2348012345678",
      "Tag / Mention · .ban @2348012345678",
      "Reply         · Reply to user's message with .ban",
    ],
    note: "LID-only targets are rejected. Target must have a valid phone identity.",
  });
}

export function pairingHelpCard(prefix = "."): string {
  return sessionCommandUsageCard(prefix, {
    title: "Pairing Help",
    command: ".pair",
    commandSyntax: ".pair <label> <number>",
    examples: ["*Example:* .pair support 2348012345678"],
    note: "Use full international format without the + symbol.",
  });
}

export function sessionPairingCard(input: { session: string; phone: string; code: string }): string {
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ 🗝 ˎˊ˗  *SESSION PAIRING*  ✦",
    "─────────────",
    `⎔ Session · ⇆ ${clean(input.session, 80)}`,
    `⎔ Phone   · ⇆ ${clean(input.phone, 30)}`,
    `⎔ Code    · ⇆ ${clean(input.code, 80)}`,
    "─────────────",
    `» *Instructions:* Open WhatsApp → Linked Devices → Link a Device → Link with phone number, then enter code *${clean(input.code, 80)}*.`,
    "",
    "ℹ️ _Session chained to workspace and source Telegram owner._",
  ].join("\n");
}
