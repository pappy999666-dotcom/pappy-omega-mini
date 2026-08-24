import type { WhatsAppSession } from "../types/domain.js";

export interface MenuAction {
  id: string;
  label: string;
  command: string;
  description: string;
  ownerOnly?: boolean;
}

export interface SessionMenuModel {
  title: string;
  subtitle: string;
  statusLine: string;
  actions: MenuAction[];
}

export function effectiveSessionStatus(
  session: WhatsAppSession,
  _now = Date.now(),
): WhatsAppSession["status"] {
  // The transport lifecycle is authoritative. A stale health timestamp is
  // informational only; it must not turn an explicitly connected session
  // into DEGRADED while the worker is still reporting ACTIVE.
  return session.status;
}

function formatHealthAge(lastHealthyAt?: number, now = Date.now()): string {
  if (!lastHealthyAt) return "—";
  const minutes = Math.max(0, Math.floor((now - lastHealthyAt) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const ANTI_MENU_COMMANDS = [
  "antistatus", "antilink", "linkpermit", "rmlinkpermit", "antilinkmsg",
  "antibot", "botpermit", "rmbotpermit", "antispam", "spamlimit", "spampermit", "rmspampermit", "antispammsg",
  "antipic", "picpermit", "rmpicpermit", "antivid", "vidpermit", "rmvidpermit", "antiaud", "audpermit", "rmaudpermit",
  "antivn", "vnpermit", "rmvnpermit", "antivnmsg", "antitxt", "antiemoji", "emojipermit", "rmemojipermit", "antiemojimsg",
  "antisticker", "sticpermit", "rmsticpermit", "antigroupcall", "antinsfw", "nsfwpermit", "rmnsfwpermit",
  "antigroupmention", "antigm", "mentionpermit", "rmmentionpermit", "gmpermit", "rmgmpermit",
  "antiwords", "antiaddword", "antirmword", "antiwordlist", "setantiwords", "rmantiwords", "clearantiwords", "antiwordsmsg",
  "antipoll", "pollpermit", "rmpollpermit", "antiforward", "fwdpermit", "rmfwdpermit", "antichannel", "chanpermit", "rmchanpermit",
  "antipromote", "antidemote", "silentactions", "antigroupmentionmsg", "antigmmsg", "antipollmsg", "antiforwardmsg", "antichannelmsg", "antigstatus", "antigstatusmsg",
] as const;

export function buildSessionMenu(
  session: WhatsAppSession,
  isOwner: boolean,
): SessionMenuModel {
  const liveStatus = effectiveSessionStatus(session);
  const actions: MenuAction[] = [
    { id: "menu", label: "Menu", command: "menu", description: "Open this menu." },
    { id: "ping", label: "Ping", command: "ping", description: "Fast session health check." },
    { id: "profile", label: "Profile", command: "profile", description: "View session identity and health." },
    { id: "health", label: "Health", command: "health", description: "View reconnect and queue health." },
    { id: "support", label: "Support", command: "support", description: "Create a support ticket." },
    { id: "autojoin", label: "Auto-join", command: "autojoin", description: "Toggle Active-bucket automatic joining." },
    { id: "join", label: "Join Manager", command: "join", description: "Start the Active-bucket Join Manager." },
    { id: "targetgs", label: "Join target", command: "targetgs", description: "Set the number of Active links to join." },
    { id: "setprefix", label: "Set prefix", command: "setprefix", description: "Set the session command prefix." },
    { id: "pfp", label: "PFP", command: "pfp", description: "Get or update the WhatsApp profile picture." },
    { id: "setgpp", label: "Group picture", command: "setgpp", description: "Update the current group picture from media." },
    { id: "setname", label: "Name", command: "setname", description: "Update the WhatsApp display name." },
    { id: "setbio", label: "Bio", command: "setbio", description: "Update the WhatsApp bio." },
    { id: "groups", label: "Groups", command: "groups", description: "Browse the session groups." },
    { id: "creategroup", label: "Create group", command: "creategroup", description: "Create a WhatsApp group." },
    { id: "pstatus", label: "Personal status", command: "pstatus", description: "Post a personal WhatsApp Status update." },
    { id: "gstatus", label: "Group status", command: "gstatus", description: "Post status to the current group." },
    { id: "dgstatus", label: "Color group status", command: "dgstatus", description: "Post a randomized color/design status to the current group." },
    { id: "tag", label: "Tag", command: "tag", description: "Hidetag the current group." },
    { id: "stag", label: "Smart tag", command: "stag", description: "Immediate current-group hidetag." },
    { id: "iggc", label: "Ignore group", command: "iggc", description: "Ignore a group in broadcasts." },
    { id: "pair", label: "Pair", command: "pair", description: "Pair another WhatsApp session.", ownerOnly: true },
    { id: "previewdebug", label: "Preview debug", command: "previewdebug", description: "Inspect native link preview metadata.", ownerOnly: true },
    { id: "broadcastdelay", label: "Broadcast delay", command: "broadcastdelay", description: "Set the all-group delay.", ownerOnly: true },
    { id: "allstatus", label: "All status", command: "allstatus", description: "Post status to every group.", ownerOnly: true },
    { id: "dallstatus", label: "Color all status", command: "dallstatus", description: "Post randomized per-group color/design statuses.", ownerOnly: true },
    { id: "allstatusx", label: "All status ×", command: "allstatusx", description: "Repeat status per group.", ownerOnly: true },
    { id: "gstatusx", label: "Group status ×", command: "gstatusx", description: "Repeat status in the current group.", ownerOnly: true },
    { id: "stopstatus", label: "Stop status", command: "stopstatus", description: "Stop active all-status jobs.", ownerOnly: true },
    { id: "allchat", label: "All chat", command: "allchat", description: "Mention members across groups.", ownerOnly: true },
    { id: "allchatx", label: "All chat ×", command: "allchatx", description: "Repeat hidden-member mentions.", ownerOnly: true },
    { id: "stopchat", label: "Stop chat", command: "stopchat", description: "Stop active all-chat jobs.", ownerOnly: true },
    { id: "stopstag", label: "Stop smart tag", command: "stopstag", description: "Stop active smart-tag jobs.", ownerOnly: true },
    { id: "setsudo", label: "Sudo", command: "setsudo", description: "Manage session and global sudo identities.", ownerOnly: true },
    { id: "pendingjoin", label: "Pending joins", command: "pendingjoin", description: "List pending group join requests.", ownerOnly: true },
    { id: "approveall", label: "Approve all", command: "approveall", description: "Approve all pending group join requests.", ownerOnly: true },
    { id: "approveamt", label: "Approve amount", command: "approveamt", description: "Approve the first N pending join requests.", ownerOnly: true },
    { id: "approvecountry", label: "Approve country", command: "approvecountry", description: "Approve pending requests by country code.", ownerOnly: true },
    { id: "rejectall", label: "Reject all", command: "rejectall", description: "Reject all pending group join requests.", ownerOnly: true },
    { id: "rejectamt", label: "Reject amount", command: "rejectamt", description: "Reject the first N pending join requests.", ownerOnly: true },
    { id: "rejectcountry", label: "Reject country", command: "rejectcountry", description: "Reject pending requests by country code.", ownerOnly: true },
    { id: "reqamt", label: "Request count", command: "reqamt", description: "Count pending requests by country code.", ownerOnly: true },
    { id: "kickall", label: "Kick all", command: "kickall", description: "Preview and queue one protected batch for eligible non-admin members.", ownerOnly: true },
    { id: "kickamt", label: "Kick amount", command: "kickamt", description: "Preview and queue one protected member-removal batch.", ownerOnly: true },
    { id: "kickcountry", label: "Kick country", command: "kickcountry", description: "Preview and queue one protected country-filtered removal batch.", ownerOnly: true },
    { id: "kick", label: "Review kick", command: "kick", description: "Review removal of one verified member." },
    { id: "promote", label: "Promote", command: "promote", description: "Review verified member promotion." },
    { id: "demote", label: "Demote", command: "demote", description: "Review verified administrator demotion." },
    { id: "dnkick", label: "Demote + kick", command: "dnkick", description: "Review sequential administrator demotion and removal." },
    { id: "block", label: "Block", command: "block", description: "Review removal and WhatsApp block." },
    { id: "unblock", label: "Unblock", command: "unblock", description: "Remove a WhatsApp block from a verified identity." },
    { id: "ban", label: "Local ban", command: "ban", description: "Locally delete future messages from a verified member." },
    { id: "unban", label: "Remove local ban", command: "unban", description: "Remove a local message restriction." },
    { id: "banlist", label: "Ban list", command: "banlist", description: "Show masked local restrictions." },
    { id: "warn", label: "Warn", command: "warn", description: "Issue a durable manual warning." },
    { id: "unwarn", label: "Reset warning", command: "unwarn", description: "Reset durable manual warnings." },
    { id: "warns", label: "Warnings", command: "warns", description: "Show a verified member warning count." },
    { id: "mute", label: "Mute group", command: "mute", description: "Switch the group to administrators-only chat mode." },
    { id: "unmute", label: "Unmute group", command: "unmute", description: "Reopen chat to all group members." },
    { id: "filter", label: "Filter preview", command: "filter", description: "Read-only verified country-prefix count." },
    { id: "filterout", label: "Filter out", command: "filterout", description: "Bounded native-confirmed removal by country prefix." },
    { id: "poll", label: "Poll", command: "poll", description: "Create a native group poll." },
    { id: "blockall", label: "Block all review", command: "blockall", description: "Bounded native confirmation for eligible non-admin members." },
    { id: "deleteall", label: "Delete recent member messages", command: "deleteall", description: "Bounded native confirmation for recent tracked messages." },
    { id: "purge", label: "Purge", command: "purge", description: "Permanently remove this session.", ownerOnly: true },
    ...ANTI_MENU_COMMANDS.map((command) => ({ id: `anti-${command}`, label: command, command, description: `Omega-V1 Anti System control: .${command}` })),
  ];

  return {
    title: `PAPPY OMEGA MINI · ${session.sessionName}`,
    subtitle: "Compact command surface",
    statusLine: `${liveStatus}|${isOwner ? "SUDO" : "USER"} · prefix ${session.prefix || "none"} · join ${session.autoJoinEnabled ? "ON" : "OFF"} · health ${formatHealthAge(session.lastHealthyAt)} · links ${session.collectedLinkCount ?? 0}/${session.validatedLinkCount ?? 0}`,
    actions: actions.filter((action) => !action.ownerOnly || isOwner),
  };
}

function toMathBold(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x41 && codePoint <= 0x5a)
      return String.fromCodePoint(0x1d5d4 + codePoint - 0x41);
    if (codePoint >= 0x61 && codePoint <= 0x7a)
      return String.fromCodePoint(0x1d5ee + codePoint - 0x61);
    return character;
  }).join("");
}

export function renderAsciiMenu(model: SessionMenuModel): string {
  const sessionName = model.title.split("·").slice(1).join("·").trim() || "Pappy";
  const [rawStatus = "UNKNOWN|USER", rawPrefix = "prefix none", rawAutoJoin = "join OFF", rawHealth = "health —", rawLinks = "links 0/0"] = model.statusLine.split(" · ");
  const [statusValue = "UNKNOWN", role = "USER"] = rawStatus.split("|");
  const status = statusValue === "ACTIVE" ? `ONLINE [${role}]` : statusValue;
  const prefix = rawPrefix.replace("prefix ", "");
  const autoJoin = rawAutoJoin.replace("join ", "");
  const links = rawLinks.replace("links ", "");
  const health = rawHealth.replace("health ", "");
  const commandSet = new Set(["menu", "ping", "profile", "health", "support"]);
  const sessionSet = new Set(["autojoin", "join", "targetgs", "setprefix", "pfp", "setgpp", "setname", "setbio", "groups", "creategroup"]);
  const localSet = new Set(["pstatus", "gstatus", "dgstatus", "tag", "stag"]);
  const ownerSet = new Set(["pair", "previewdebug", "broadcastdelay", "allstatus", "dallstatus", "allstatusx", "gstatusx", "stopstatus", "allchat", "allchatx", "stopchat", "stopstag", "iggc", "setsudo", "pendingjoin", "approveall", "approveamt", "approvecountry", "rejectall", "rejectamt", "rejectcountry", "reqamt", "kickall", "kickamt", "kickcountry"]);
  const moderationSet = new Set(["kick", "promote", "demote", "dnkick", "block", "unblock", "ban", "unban", "banlist", "warn", "unwarn", "warns", "mute", "unmute", "filter", "filterout", "poll", "blockall", "deleteall"]);
  const antiSet = new Set<string>(ANTI_MENU_COMMANDS);
  const commandIndent = "︎ ".repeat(15);
  const renderSection = (title: string, icon: string, set: Set<string>): string[] => {
    const commands = model.actions
      .filter((action) => set.has(action.command))
      .map((action) => action.command);
    if (!commands.length) return [];
    return [
      `⌬ ⤷ *${title}* ${icon}`,
      ...commands.map((command) => `${commandIndent}⊹ .${command}`),
      "",
    ];
  };
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ☏ ˎˊ˗  *Hello, ${toMathBold(sessionName)}*  ✦`,
    "─────────────",
    `⎔ Owner   · ⇆ ${toMathBold(sessionName)}`,
    `⎔ Status  · ⇆ ${status}`,
    `⎔ AutoJ   · ⇆ ${autoJoin}`,
    `⎔ Prefix  · ⇆ [ ${prefix} ]`,
    `⎔ Health  · ⇆ ${health}`,
    `⎔ Links   · ⇆ ${links}`,
    "─────────────",
    "",
    ...renderSection("COMMANDS", "⚙️", commandSet),
    ...renderSection("SESSION", "🗝", sessionSet),
    ...renderSection("LOCAL", "⎔", localSet),
    ...renderSection("OWNER / SUDO", "𓋎⚇", ownerSet),
    ...renderSection("MODERATION", "🛡", moderationSet),
    ...renderSection("🛡 ANTI SYSTEM", "🛡", antiSet),
  ].join("\n").trim();
}
