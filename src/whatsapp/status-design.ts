export interface GroupStatusDesign {
  text: string;
  backgroundColor: string;
  textColor: string;
  font: number;
}

const BACKGROUNDS = [
  "#075E54",
  "#128C7E",
  "#1F6FEB",
  "#6F42C1",
  "#B83280",
  "#C2410C",
  "#166534",
  "#0F766E",
  "#374151",
] as const;

const TEMPLATES = [
  (name: string, text: string) => `✦ ${name}\n\n${text}\n\n— PAPPY OMEGA MINI`,
  (name: string, text: string) => `╭─ ${name} ─╮\n│ ${text}\n╰────────╯`,
  (name: string, text: string) => `┏━ ${name} ━┓\n${text}\n┗━━━━━━━━┛`,
  (name: string, text: string) => `⌁ ${name}\n──────────\n${text}`,
  (name: string, text: string) => `${name}\n\n${text}\n\n◈ OMEGA STATUS`,
] as const;

function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function createGroupStatusDesign(input: {
  groupName: string;
  text: string;
  seed: string;
}): GroupStatusDesign {
  const value = hash(`${input.seed}:${input.groupName}:${input.text}`);
  const template = TEMPLATES[value % TEMPLATES.length] ?? TEMPLATES[0];
  const backgroundColor = BACKGROUNDS[(value >>> 8) % BACKGROUNDS.length] ?? BACKGROUNDS[0];
  const font = value % 10;
  return {
    text: template(input.groupName.trim() || "WhatsApp Group", input.text),
    backgroundColor,
    textColor: "#FFFFFF",
    font,
  };
}
