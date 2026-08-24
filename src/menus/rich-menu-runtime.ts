import { createHmac } from "node:crypto";
import { env } from "../config/env.js";
import type { MenuAction, SessionMenuModel } from "./menu-model.js";

const PUBLIC_MEDIA_ORIGIN =
  process.env.PAPPY_MENU_MEDIA_BASE_URL?.trim() ||
  "https://pappy-omega-mini-v1.duckdns.org";
export const MENU_MEDIA_TTL = 24 * 60 * 60;
export const TELEGRAM_HOME_URL = "https://t.me/pappy_b2_bot";

export interface RichMenuImage {
  url: string;
  mime_type: string;
  width: number;
  height: number;
}

export interface RichMenuButton {
  id: string;
  text: string;
  toast?: string;
}

export interface RichMenuCard {
  title: string;
  toast?: string;
  buttons: RichMenuButton[];
}

export interface RichMenuContent {
  header: {
    title: string;
    disclaimer: boolean;
    disclaimerText: string;
    image?: RichMenuImage;
  };
  body: {
    cards: RichMenuCard[];
    carousel: boolean;
  };
  footer: {
    text: string;
    url: string;
  };
}

export interface MenuInteraction {
  view?: string;
  command?: string;
}

interface MenuGroup {
  key: string;
  title: string;
  commands: string[];
}

const GROUPS: MenuGroup[] = [
  { key: "core", title: "CORE & SESSION STATUS", commands: ["menu", "menulist", "ping", "profile", "health", "support", "previewdebug"] },
  { key: "session", title: "SESSION & JOIN TOOLS", commands: ["autojoin", "join", "targetgs", "setprefix", "pair"] },
  { key: "identity", title: "MEDIA & IDENTITY", commands: ["pfp", "setgpp", "setname", "setbio"] },
  { key: "groups", title: "GROUPS & LOCAL CONTROL", commands: ["groups", "creategroup", "iggc", "poll"] },
  { key: "moderation", title: "GROUP MODERATION", commands: ["kick", "promote", "demote", "dnkick", "block", "unblock", "ban", "unban", "banlist", "warn", "unwarn", "warns", "mute", "unmute", "filter", "filterout", "blockall", "deleteall"] },
  { key: "broadcast", title: "BROADCAST & STATUS", commands: ["broadcastdelay", "allstatus", "dallstatus", "allstatusx", "gstatusx", "stopstatus", "allchat", "allchatx", "stopchat", "pstatus", "dgstatus", "gstatus", "tag", "stag", "stopstag"] },
  { key: "approvals", title: "JOIN APPROVALS & BATCH ACTIONS", commands: ["pendingjoin", "approve", "reject", "approveall", "rejectall", "approveamt", "rejectamt", "approvecountry", "rejectcountry", "reqamt", "kickall", "kickamt", "kickcountry"] },
  { key: "antisystem", title: "ANTI-SYSTEM", commands: [
    "antistatus", "spamlimit", "antiwords", "antiaddword", "antirmword", "antiwordlist", "setantiwords", "rmantiwords", "clearantiwords", "silentactions",
    "antilink", "antibot", "antispam", "antipic", "antivid", "antiaud", "antivn", "antitxt", "antiemoji", "antisticker", "antigroupcall", "antinsfw", "antigroupmention", "antigm", "antipoll", "antiforward", "antichannel", "antipromote", "antidemote", "antigstatus",
    "linkpermit", "rmlinkpermit", "botpermit", "rmbotpermit", "spampermit", "rmspampermit", "picpermit", "rmpicpermit", "vidpermit", "rmvidpermit", "audpermit", "rmaudpermit", "vnpermit", "rmvnpermit", "emojipermit", "rmemojipermit", "sticpermit", "rmsticpermit", "nsfwpermit", "rmnsfwpermit", "mentionpermit", "rmmentionpermit", "gmpermit", "rmgmpermit", "pollpermit", "rmpollpermit", "fwdpermit", "rmfwdpermit", "chanpermit", "rmchanpermit",
    "antilinkmsg", "antispammsg", "antivnmsg", "antitxtmsg", "antiemojimsg", "antiwordsmsg", "antigroupmentionmsg", "antigmmsg", "antipollmsg", "antiforwardmsg", "antichannelmsg", "antigstatusmsg",
  ] },
  { key: "tools", title: "ACCESS & TOOLS", commands: ["setsudo", "rmsudo", "purge"] },
];

export const CATEGORY_LABELS: Record<string, string> = {
  root: "MENU HOME", all: "FULL COMMAND MENU", core: "CORE & SESSION STATUS", session: "SESSION & JOIN TOOLS",
  identity: "MEDIA & IDENTITY", groups: "GROUPS & LOCAL CONTROL", moderation: "GROUP MODERATION",
  broadcast: "BROADCAST & STATUS", approvals: "JOIN APPROVALS & BATCH ACTIONS", antisystem: "ANTI-SYSTEM COMMANDS", tools: "ACCESS & TOOLS",
};

const NAVIGATION: Array<[string, string]> = [
  ["root", "Home"], ["all", "Full menu"], ["antisystem", "Anti-system"], ["broadcast", "Broadcast"], ["session", "Session"],
  ["groups", "Groups"], ["identity", "Media & identity"], ["moderation", "Moderation"], ["approvals", "Approvals"], ["tools", "Help & tools"],
];
const DISPLAY_ACTIONS = new Map<string, MenuInteraction>(NAVIGATION.flatMap(([view, text]) => [
  [text.toLowerCase(), { view }],
  [`open ${text.toLowerCase()}`, { view }],
]));

function safeSegment(value: string): string {
  return encodeURIComponent(String(value).replace(/[^a-zA-Z0-9._:-]/g, ""));
}

function mediaSignature(workspaceId: string, mediaId: string, expires: number): string {
  return createHmac("sha256", env.ENCRYPTION_SECRET || "pappy-omega-mini-menu")
    .update(`${workspaceId}:${mediaId}:${expires}`)
    .digest("hex");
}

export function buildMenuMediaUrl(workspaceId: string, mediaId: string): string {
  const expires = Math.floor(Date.now() / 1000) + MENU_MEDIA_TTL;
  return `${PUBLIC_MEDIA_ORIGIN}/workload/menu-media/${safeSegment(workspaceId)}/${safeSegment(mediaId)}?exp=${expires}&sig=${mediaSignature(workspaceId, mediaId, expires)}`;
}

function interactionNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function uiId(view: string, nonce: string): string {
  return `ui:menu:${view}:${nonce}`;
}

function button(id: string, text: string, toast = ""): RichMenuButton {
  return { id, text, toast };
}

function commandButton(command: string, nonce: string): RichMenuButton {
  return button(`cmd:${command}:${nonce}`, `.${command}`, `Run .${command}`);
}

function navigationCards(nonce: string): RichMenuCard[] {
  const split = Math.ceil(NAVIGATION.length / 2);
  return [
    { title: "NAVIGATION", toast: "These controls stay available on every screen", buttons: NAVIGATION.slice(0, split).map(([view, text]) => button(uiId(view, nonce), text, `Open ${text}`)) },
    { title: "MORE CATEGORIES", toast: "Return here at any time", buttons: NAVIGATION.slice(split).map(([view, text]) => button(uiId(view, nonce), text, `Open ${text}`)) },
  ];
}

function rootCards(nonce: string): RichMenuCard[] {
  return [
    { title: "FULL MENU", toast: "All registered WhatsApp commands", buttons: [button(uiId("all", nonce), "Open full menu", "Every available command")] },
    { title: "ANTI-SYSTEM", toast: "Protection, permits, and custom notices", buttons: [button(uiId("antisystem", nonce), "Anti-system", "Open Anti-system commands")] },
    { title: "BROADCAST & STATUS", toast: "Broadcast, status, chat, and tagging", buttons: [button(uiId("broadcast", nonce), "Broadcast", "Open Broadcast and Status")] },
    { title: "SESSION & GROUPS", toast: "Session, identity, group, and join tools", buttons: [button(uiId("session", nonce), "Session"), button(uiId("groups", nonce), "Groups")] },
    { title: "MODERATION & APPROVALS", toast: "Protected moderation and join approvals", buttons: [button(uiId("moderation", nonce), "Moderation"), button(uiId("approvals", nonce), "Approvals")] },
    { title: "MEDIA, IDENTITY & HELP", toast: "Identity, diagnostics, and access", buttons: [button(uiId("identity", nonce), "Media & identity"), button(uiId("tools", nonce), "Help & tools")] },
  ];
}

function groupCards(keys: string[], actions: Set<string>, nonce: string): RichMenuCard[] {
  const selected = new Set(keys);
  return GROUPS.filter((group) => selected.has(group.key)).map((group) => ({
    title: group.title,
    toast: `Registered commands in ${group.title.toLowerCase()}`,
    buttons: group.commands.filter((command) => actions.has(command)).map((command) => commandButton(command, nonce)),
  })).filter((card) => card.buttons.length);
}

function cardsForView(view: string, actions: Set<string>, nonce = "preview"): RichMenuCard[] {
  if (view === "root") return rootCards(nonce);
  if (view === "all") return [...navigationCards(nonce), ...GROUPS.flatMap((group) => groupCards([group.key], actions, nonce))];
  const map: Record<string, string[]> = { core: ["core"], session: ["session"], identity: ["identity"], groups: ["groups"], moderation: ["moderation"], broadcast: ["broadcast"], approvals: ["approvals"], antisystem: ["antisystem"], tools: ["tools"], media: ["identity", "broadcast"] };
  return [...navigationCards(nonce), ...groupCards(map[view] || ["core"], actions, nonce)];
}

export function textForView(model: SessionMenuModel, view: string): string {
  const title = CATEGORY_LABELS[view] || CATEGORY_LABELS.root;
  const body = view === "root"
    ? "Full menu · Anti-system · Broadcast · Session · Groups · Moderation · Approvals · Media · Help"
    : cardsForView(view, new Set(model.actions.map((item) => item.command))).flatMap((card) => [card.title, ...card.buttons.map((item) => item.text)]).join("\n");
  return [`PAPPY OMEGA MINI · ${title}`, model.statusLine, "", body, "", "Tap a category or command. Send .menu for a fresh set of buttons."].join("\n");
}

export function buildRichMenuContent(model: SessionMenuModel, view = "root", image?: RichMenuImage): RichMenuContent {
  const actions = new Set(model.actions.map((item: MenuAction) => item.command));
  const nonce = interactionNonce();
  return {
    header: { title: `PAPPY OMEGA MINI · ${CATEGORY_LABELS[view] || CATEGORY_LABELS.root}`, disclaimer: true, disclaimerText: "Private control surface · owner actions are filtered by session permissions", ...(image?.url ? { image } : {}) },
    body: { cards: cardsForView(view, actions, nonce), carousel: false },
    footer: { text: "Back to Pappy Omega Mini on Telegram", url: TELEGRAM_HOME_URL },
  };
}

export function resolveMenuInteraction(value?: string): MenuInteraction | undefined {
  const key = String(value || "").trim();
  if (!key) return undefined;
  const parts = key.split(":");
  const view = parts[2];
  if (parts[0] === "ui" && parts[1] === "menu" && view && CATEGORY_LABELS[view])
    return { view };
  const command = parts[1];
  if (parts[0] === "cmd" && command && /^[a-z0-9][a-z0-9_-]{0,48}$/i.test(command))
    return { command: command.toLowerCase() };
  return DISPLAY_ACTIONS.get(key.toLowerCase());
}

export { GROUPS };
