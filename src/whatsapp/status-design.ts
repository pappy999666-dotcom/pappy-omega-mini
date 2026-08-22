export type GroupStatusDesignMode = "text" | "url";

export interface GroupStatusDesign {
  text: string;
  backgroundColor: string;
  textColor: string;
  font: number;
  mode: GroupStatusDesignMode;
  title: string;
}

// Baileys accepts #RRGGBB and converts it to an opaque ARGB value. Keep this
// palette intentionally bright and never use #000000/#0000: some WhatsApp
// clients otherwise fall back to a black story canvas.
const BACKGROUNDS = [
  "#2563EB",
  "#7C3AED",
  "#C026D3",
  "#DB2777",
  "#EA580C",
  "#D97706",
  "#16A34A",
  "#0D9488",
  "#0891B2",
  "#4F46E5",
] as const;

const TEXT_TEMPLATES = [
  (title: string, body: string) =>
    `╭────────────────────────────╮\n\n        ✦ ${title} ✦\n\n              ◈\n\n${body}\n\n╰────────────────────────────╯`,
  (title: string, body: string) =>
    `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n\n          ♡ ${title} ♡\n\n          ── ✧ ──\n\n${body}\n\n┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`,
  (title: string, body: string) =>
    `╔════════════════════════════╗\n║                            ║\n║        ${title}        ║\n║                            ║\n║          ${body}          ║\n║                            ║\n╚════════════════════════════╝`,
  (title: string, body: string) =>
    `⌜────────────────────────────⌝\n\n          ${title}\n\n       ⟡  ${body}  ⟡\n\n⌞────────────────────────────⌟`,
] as const;

const URL_TEMPLATES = [
  (title: string, body: string) =>
    `╭────────────── ✦ ──────────────╮\n\n            ♡ ${title} ♡\n\n              ── ◈ ──\n\n${body}\n\n╰────────────── ✦ ──────────────╯`,
  (title: string, body: string) =>
    `┏━━━━━━━━━━━━━━ ✧ ━━━━━━━━━━━━━━┓\n\n             ${title}\n\n        ── 𝗟𝗜𝗡𝗞 𝗗𝗥𝗢𝗣 ──\n\n${body}\n\n┗━━━━━━━━━━━━━━ ✧ ━━━━━━━━━━━━━━┛`,
  (title: string, body: string) =>
    `╔═══════════════╗\n║   ♡ ${title} ♡   ║\n╚═══════════════╝\n\n          ${body}\n\n        ⟡ OPEN THE LINK ⟡`,
] as const;

function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function cleanTitle(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "WhatsApp Group").slice(0, 42);
}

function hasHttpUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

export function createGroupStatusDesign(input: {
  groupName: string;
  text: string;
  seed: string;
  title?: string;
  mode?: GroupStatusDesignMode;
}): GroupStatusDesign {
  const sourceText = input.text.trim();
  const mode = input.mode ?? (hasHttpUrl(sourceText) ? "url" : "text");
  const title = cleanTitle(input.title ?? input.groupName);
  const value = hash(`${input.seed}:${input.groupName}:${title}:${sourceText}:${mode}`);
  const templates = mode === "url" ? URL_TEMPLATES : TEXT_TEMPLATES;
  const template = templates[value % templates.length] ?? templates[0];
  const backgroundColor = BACKGROUNDS[(value >>> 8) % BACKGROUNDS.length] ?? BACKGROUNDS[0];
  return {
    text: template(title, sourceText || " "),
    backgroundColor,
    textColor: "#FFFFFF",
    font: value % 10,
    mode,
    title,
  };
}
