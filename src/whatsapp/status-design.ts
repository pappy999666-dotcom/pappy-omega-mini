export type GroupStatusDesignMode = "text" | "url";

export interface GroupStatusDesign {
  text: string;
  backgroundColor: string;
  textColor: string;
  font: number;
  mode: GroupStatusDesignMode;
  title: string;
}

// Saturated, readable colors for WhatsApp status canvases. None is black or
// transparent, and the palette is deliberately varied per group/execution.
const BACKGROUNDS = [
  "#6D5DFB",
  "#C2509E",
  "#0EA5A8",
  "#D97706",
  "#DB2777",
  "#2563EB",
  "#7C3AED",
  "#0F766E",
  "#BE185D",
  "#4F46E5",
  "#B45309",
  "#0891B2",
] as const;

// These are intentionally compact and Unicode-only. The URL remains in the
// body so the native preview resolver can still match the exact source URL.
const URL_TEMPLATES = [
  (title: string, body: string) =>
    `┈┈┈ 𓍢ִ໋✧ ${title} ✧𓍢ִ໋ ┈┈┈\n   ${body}\n┈┈┈┈┈┈┈ ₊˚⊹ ┈┈┈┈┈┈┈`,
  (title: string, body: string) =>
    `˚.✦ ── ${title} ── ✦.˚\n   ${body}\n˚.✦ ────── ⋆ ────── ✦.˚`,
  (title: string, body: string) =>
    `─── ᰔ Ɛゝ ${title} Ɛゝ ᰔ ───\n   ${body}\n───────── 𖦹 ─────────`,
  (title: string, body: string) =>
    `╭─ Ɛゝ ${title} Ϧ3 ─╮\n   ${body}\n╰─── ⋆⋅☆⋅⋆ ───╯`,
  (title: string, body: string) =>
    `┈─𓏲 ${title} 𓏲─┈\n   ${body}\n┈─┈─ ᰔ ─┈─┈`,
  (title: string, body: string) =>
    `⟡─── Ɛゝ ${title} ───⟡\n   ${body}\n⟡──────── ✧ ────────⟡`,
  (title: string, body: string) =>
    `⋆˚࿔ ${title} ࿔˚⋆\n   ${body}\n───── ⋆⋅☆⋅⋆ ─────`,
  (title: string, body: string) =>
    `.・゜-: ✧ ${title} ✧ :-゜・.\n   ${body}\n.・゜-: ─────── :-゜・.`,
  (title: string, body: string) =>
    `~〜~ ✧ ${title} ✧ ~〜~\n   ${body}\n~〜~〜~〜 𖦹 ~〜~〜~〜`,
] as const;

// Kept for direct callers that request a text design. Production d-status
// paths intentionally bypass this mode when no URL is present.
const TEXT_TEMPLATES = [
  (title: string, body: string) => `✧ ${title} ✧\n${body}`,
  (title: string, body: string) => `ᰔ ${title} ᰔ\n${body}`,
  (title: string, body: string) => `⟡ ${title} ⟡\n${body}`,
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
  return (cleaned || "WhatsApp Group").slice(0, 36);
}

function hasHttpUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function indentBody(text: string): string {
  return text.replace(/\r?\n/g, "\n   ");
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
    text: template(title, mode === "url" ? indentBody(sourceText) : sourceText || " "),
    backgroundColor,
    textColor: "#FFFFFF",
    font: value % 10,
    mode,
    title,
  };
}
