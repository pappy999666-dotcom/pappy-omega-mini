import { createHmac } from "node:crypto";
import { env } from "../config/env.js";
import type { MenuAction, SessionMenuModel } from "./menu-model.js";

function configuredPublicOrigin(): string {
  const candidate = process.env.PAPPY_MENU_MEDIA_BASE_URL?.trim() || env.WORKLOAD_CONTROL_URL?.trim() || env.OPTIONAL_DOMAIN?.trim();
  if (!candidate) return "https://pappy-omega-mini-v1.duckdns.org";
  return /^https?:\/\//i.test(candidate) ? candidate.replace(/\/$/, "") : `https://${candidate.replace(/\/$/, "")}`;
}

const PUBLIC_MEDIA_ORIGIN = configuredPublicOrigin();
export const MENU_MEDIA_TTL = 24 * 60 * 60;
export const MENU_INTERACTION_TTL_SECONDS = 60;
export const TELEGRAM_HOME_URL = "https://t.me/pappy_b2_bot";

export interface RichMenuImage {
  url: string;
  mime_type: string;
  width: number;
  height: number;
  /** Render the image inside the Gen4 response body instead of as a detached preview. */
  inline?: boolean;
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
  expiresAt?: number;
}

export interface MenuInteractionContext {
  workspaceId: string;
  sessionId: string;
  prefix?: string;
  /** Only native interaction payloads may use a bare command-label fallback. */
  allowCommandText?: boolean;
}

interface MenuTokenBinding {
  workspaceId: string;
  sessionId: string;
  expiresAt: number;
}

const menuTokens = new Map<string, MenuTokenBinding>();
const menuSessions = new Map<string, number>();
const MAX_MENU_TOKENS = 2048;

function menuSessionKey(context: MenuInteractionContext): string {
  return `${context.workspaceId}\u0000${context.sessionId}`;
}

function pruneMenuTokens(now = Date.now()): void {
  for (const [nonce, binding] of menuTokens) {
    if (binding.expiresAt <= now) menuTokens.delete(nonce);
  }
  for (const [key, expiresAt] of menuSessions) {
    if (expiresAt <= now) menuSessions.delete(key);
  }
  while (menuTokens.size > MAX_MENU_TOKENS) {
    const oldest = menuTokens.keys().next().value;
    if (typeof oldest !== "string") break;
    menuTokens.delete(oldest);
  }
}

function registerMenuToken(nonce: string, options?: RichMenuBuildOptions): number {
  const now = Date.now();
  pruneMenuTokens(now);
  const requested = options?.expiresAt ?? now + Math.max(5, Math.min(300, options?.ttlSeconds ?? MENU_INTERACTION_TTL_SECONDS)) * 1000;
  const expiresAt = Math.max(now + 1_000, requested);
  if (options?.workspaceId && options.sessionId) {
    menuTokens.set(nonce, { workspaceId: options.workspaceId, sessionId: options.sessionId, expiresAt });
    menuSessions.set(`${options.workspaceId}\u0000${options.sessionId}`, expiresAt);
  }
  return expiresAt;
}

function activeMenuSession(context: MenuInteractionContext): number | undefined {
  pruneMenuTokens();
  const expiresAt = menuSessions.get(menuSessionKey(context));
  return expiresAt && expiresAt > Date.now() ? expiresAt : undefined;
}

function activeMenuToken(nonce: string, context: MenuInteractionContext): number | undefined {
  pruneMenuTokens();
  const binding = menuTokens.get(nonce);
  if (!binding || binding.workspaceId !== context.workspaceId || binding.sessionId !== context.sessionId || binding.expiresAt <= Date.now()) return undefined;
  return binding.expiresAt;
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
  { key: "moderation", title: "GROUP MODERATION", commands: ["kick", "promote", "demote", "dnkick", "block", "unblock", "ban", "unban", "banlist", "warn", "unwarn", "warns", "mute", "unmute", "filter", "filterout", "blockall", "dlt", "deleteall"] },
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

export interface RichMenuBuildOptions {
  workspaceId?: string;
  sessionId?: string;
  ttlSeconds?: number;
  expiresAt?: number;
}

function uiId(view: string, nonce: string): string {
  return `ui:menu:${view}:${nonce}`;
}

function button(id: string, text: string, toast = ""): RichMenuButton {
  return { id, text, toast };
}

function commandButton(command: string, nonce: string, prefix: string): RichMenuButton {
  const commandText = `${prefix}${command}`;
  return button(`cmd:${command}:${nonce}`, commandText, `Run ${commandText}`);
}

function navigationCards(nonce: string, prefix: string): RichMenuCard[] {
  const split = Math.ceil(NAVIGATION.length / 2);
  return [
    { title: "NAVIGATION", toast: "These controls stay available on every screen", buttons: NAVIGATION.slice(0, split).map(([view, text]) => button(uiId(view, nonce), `${prefix}open ${view}`, `Open ${text}`)) },
    { title: "MORE CATEGORIES", toast: "Return here at any time", buttons: NAVIGATION.slice(split).map(([view, text]) => button(uiId(view, nonce), `${prefix}open ${view}`, `Open ${text}`)) },
  ];
}

function rootCards(nonce: string, prefix: string): RichMenuCard[] {
  return [
    { title: "FULL MENU", toast: "All registered WhatsApp commands", buttons: [button(uiId("all", nonce), `${prefix}open all`, "Every available command")] },
    { title: "ANTI-SYSTEM", toast: "Protection, permits, and custom notices", buttons: [button(uiId("antisystem", nonce), `${prefix}open antisystem`, "Open Anti-system commands")] },
    { title: "BROADCAST & STATUS", toast: "Broadcast, status, chat, and tagging", buttons: [button(uiId("broadcast", nonce), `${prefix}open broadcast`, "Open Broadcast and Status")] },
    { title: "SESSION & GROUPS", toast: "Session, identity, group, and join tools", buttons: [button(uiId("session", nonce), `${prefix}open session`), button(uiId("groups", nonce), `${prefix}open groups`)] },
    { title: "MODERATION & APPROVALS", toast: "Protected moderation and join approvals", buttons: [button(uiId("moderation", nonce), `${prefix}open moderation`), button(uiId("approvals", nonce), `${prefix}open approvals`)] },
    { title: "MEDIA, IDENTITY & HELP", toast: "Identity, diagnostics, and access", buttons: [button(uiId("identity", nonce), `${prefix}open identity`), button(uiId("tools", nonce), `${prefix}open tools`)] },
  ];
}

function groupCards(keys: string[], actions: Set<string>, nonce: string, prefix: string): RichMenuCard[] {
  const selected = new Set(keys);
  return GROUPS.filter((group) => selected.has(group.key)).map((group) => ({
    title: group.title,
    toast: `Registered commands in ${group.title.toLowerCase()}`,
    buttons: group.commands.filter((command) => actions.has(command)).map((command) => commandButton(command, nonce, prefix)),
  })).filter((card) => card.buttons.length);
}

function cardsForView(view: string, actions: Set<string>, nonce = "preview", prefix = ""): RichMenuCard[] {
  if (view === "root") return rootCards(nonce, prefix);
  if (view === "all") return [...navigationCards(nonce, prefix), ...GROUPS.flatMap((group) => groupCards([group.key], actions, nonce, prefix))];
  const map: Record<string, string[]> = { core: ["core"], session: ["session"], identity: ["identity"], groups: ["groups"], moderation: ["moderation"], broadcast: ["broadcast"], approvals: ["approvals"], antisystem: ["antisystem"], tools: ["tools"], media: ["identity", "broadcast"] };
  return [...navigationCards(nonce, prefix), ...groupCards(map[view] || ["core"], actions, nonce, prefix)];
}

export function textForView(model: SessionMenuModel, view: string): string {
  const title = CATEGORY_LABELS[view] || CATEGORY_LABELS.root;
  const prefix = model.prefix || "";
  const menuCommand = `${prefix}menu`;
  const body = view === "root"
    ? "Full menu · Anti-system · Broadcast · Session · Groups · Moderation · Approvals · Media · Help"
    : cardsForView(view, new Set(model.actions.map((item) => item.command)), "preview", prefix).flatMap((card) => [card.title, ...card.buttons.map((item) => item.text)]).join("\n");
  return [`PAPPY OMEGA MINI · ${title}`, model.statusLine, "", body, "", prefix ? `Tap a category or command. Send ${menuCommand} for a fresh set of buttons.` : "Tap a category or command. Use the buttons for a fresh set of controls."].join("\n");
}

export function buildRichMenuContent(model: SessionMenuModel, view = "root", image?: RichMenuImage, options?: RichMenuBuildOptions): RichMenuContent {
  const actions = new Set(model.actions.map((item: MenuAction) => item.command));
  const nonce = interactionNonce();
  const expiresAt = registerMenuToken(nonce, options);
  const lifetimeSeconds = Math.max(5, Math.ceil((expiresAt - Date.now()) / 1000));
  return {
    header: { title: `PAPPY OMEGA MINI · ${CATEGORY_LABELS[view] || CATEGORY_LABELS.root}`, disclaimer: true, disclaimerText: `Choose a section below to explore the available controls. Buttons expire after ${lifetimeSeconds}s.`, ...(image?.url ? { image } : {}) },
    body: { cards: cardsForView(view, actions, nonce, model.prefix || ""), carousel: false },
    footer: { text: "Back to Pappy Omega Mini on Telegram", url: TELEGRAM_HOME_URL },
  };
}

export function resolveMenuViewInteraction(value?: string, context?: MenuInteractionContext): MenuInteraction | undefined {
  const interaction = resolveMenuInteraction(value, context);
  return interaction?.view ? interaction : undefined;
}

export function resolveMenuInteraction(value?: string, context?: MenuInteractionContext): MenuInteraction | undefined {
  const key = String(value || "").trim();
  if (!key) return undefined;
  const parts = key.split(":");
  const view = parts[2];
  if (parts[0] === "ui" && parts[1] === "menu" && view && CATEGORY_LABELS[view]) {
    const nonce = parts[3];
    const expiresAt = context && nonce ? activeMenuToken(nonce, context) : undefined;
    if (context && !expiresAt) return undefined;
    return { view, ...(expiresAt ? { expiresAt } : {}) };
  }
  const command = parts[1];
  if (parts[0] === "cmd" && command && /^[a-z0-9][a-z0-9_-]{0,48}$/i.test(command)) {
    const nonce = parts[2];
    const expiresAt = context && nonce ? activeMenuToken(nonce, context) : undefined;
    if (context && !expiresAt) return undefined;
    return { command: command.toLowerCase(), ...(expiresAt ? { expiresAt } : {}) };
  }
  const prefix = context?.prefix?.trim() ?? "";
  const commandText = prefix && key.startsWith(prefix)
    ? key.slice(prefix.length).trim()
    : context?.allowCommandText && /^[a-z0-9][a-z0-9_-]{0,48}(?:\s+[a-z0-9][a-z0-9_-]{0,48})?$/i.test(key)
      ? key
      : !context && key.startsWith(".")
        ? key.slice(1).trim()
        : "";
  const openMatch = /^open\s+([a-z0-9][a-z0-9_-]{0,48})$/i.exec(commandText);
  if (openMatch?.[1]) {
    const target = openMatch[1].toLowerCase();
    const expiresAt = context ? activeMenuSession(context) : undefined;
    if (context && !expiresAt) return undefined;
    if (CATEGORY_LABELS[target]) return { view: target, ...(expiresAt ? { expiresAt } : {}) };
    return { command: target, ...(expiresAt ? { expiresAt } : {}) };
  }
  if (commandText && /^[a-z0-9][a-z0-9_-]{0,48}$/i.test(commandText)) {
    const expiresAt = context ? activeMenuSession(context) : undefined;
    if (context && !expiresAt) return undefined;
    return { command: commandText.toLowerCase(), ...(expiresAt ? { expiresAt } : {}) };
  }
  if (context && (DISPLAY_ACTIONS.has(key.toLowerCase()) || key.startsWith("Open ")) && !activeMenuSession(context)) return undefined;
  return DISPLAY_ACTIONS.get(key.toLowerCase());
}

export { GROUPS };
