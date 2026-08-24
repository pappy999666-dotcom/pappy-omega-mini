const CRESTS = [
  "⚫︎", "◈", "⟡", "⌬", "⎔", "✦", "⟐", "◇", "◆", "❖",
  "☍", "⊙", "◌", "◍", "▣", "▢", "⬡", "⬢", "⧫", "⟢",
] as const;

const MOTIFS = [
  "⚙︎", "⚡︎", "𓋎", "⎔", "⌁", "✦", "◈", "⟡", "⧉", "⌬",
  "☍", "⟐", "◇", "◆", "❖", "◌", "◍", "▣", "⬡", "⎈",
  "⌘", "⟁", "⊹", "⟢", "✧",
] as const;

const DIVIDERS = [
  "─────────────", "━━━━━━━━━━━━━", "┄┄┄┄┄┄┄┄┄┄┄┄┄", "╴╴╴╴╴╴╴╴╴╴╴╴╴",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌", "┈┈┈┈┈┈┈┈┈┈┈┈┈", "═════════════", "﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏",
  "╍╍╍╍╍╍╍╍╍╍╍╍╍", "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
] as const;

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

export interface ResponseDesign {
  crest: string;
  motif: string;
  divider: string;
  index: number;
}

export const RESPONSE_DESIGN_COUNT = CRESTS.length * MOTIFS.length;

export function responseDesign(seed: string): ResponseDesign {
  const value = hash(seed);
  const index = value % RESPONSE_DESIGN_COUNT;
  return {
    crest: CRESTS[index % CRESTS.length] ?? "⚫︎",
    motif: MOTIFS[Math.floor(index / CRESTS.length) % MOTIFS.length] ?? "⚙︎",
    divider: DIVIDERS[Math.floor(value / RESPONSE_DESIGN_COUNT) % DIVIDERS.length] ?? DIVIDERS[0],
    index,
  };
}

export function pappyHeader(seed: string, title: string): string[] {
  const design = responseDesign(seed);
  return [
    `ㅤ   ${design.crest}  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ${design.crest}`,
    "",
    `˗ˏˋ ${design.motif} ˎˊ˗  *${title.toUpperCase()}*  ✦`,
    design.divider,
  ];
}

export function designedDivider(seed: string): string {
  return responseDesign(seed).divider;
}
