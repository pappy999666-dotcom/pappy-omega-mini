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
  now = Date.now(),
): WhatsAppSession["status"] {
  if (
    session.status === "ACTIVE" &&
    (!session.lastHealthyAt || now - session.lastHealthyAt > 90_000)
  )
    return "DEGRADED";
  return session.status;
}

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
    { id: "targetgs", label: "Join target", command: "targetgs", description: "Set the number of Active links to join." },
    { id: "setprefix", label: "Set prefix", command: "setprefix", description: "Set the session command prefix." },
    { id: "pfp", label: "PFP", command: "pfp", description: "Get or update the WhatsApp profile picture." },
    { id: "setgpp", label: "Group picture", command: "setgpp", description: "Update the current group picture from media." },
    { id: "setname", label: "Name", command: "setname", description: "Update the WhatsApp display name." },
    { id: "setbio", label: "Bio", command: "setbio", description: "Update the WhatsApp bio." },
    { id: "groups", label: "Groups", command: "groups", description: "Browse the session groups." },
    { id: "creategroup", label: "Create group", command: "creategroup", description: "Create a WhatsApp group." },
    { id: "gstatus", label: "Group status", command: "gstatus", description: "Post status to the current group." },
    { id: "tag", label: "Tag", command: "tag", description: "Hidetag the current group." },
    { id: "stag", label: "Smart tag", command: "stag", description: "Immediate current-group hidetag." },
    { id: "iggc", label: "Ignore group", command: "iggc", description: "Ignore a group in broadcasts." },
    { id: "pair", label: "Pair", command: "pair", description: "Pair another WhatsApp session.", ownerOnly: true },
    { id: "previewdebug", label: "Preview debug", command: "previewdebug", description: "Inspect native link preview metadata.", ownerOnly: true },
    { id: "broadcastdelay", label: "Broadcast delay", command: "broadcastdelay", description: "Set the all-group delay.", ownerOnly: true },
    { id: "allstatus", label: "All status", command: "allstatus", description: "Post status to every group.", ownerOnly: true },
    { id: "allstatusx", label: "All status ×", command: "allstatusx", description: "Repeat status per group.", ownerOnly: true },
    { id: "gstatusx", label: "Group status ×", command: "gstatusx", description: "Repeat status in the current group.", ownerOnly: true },
    { id: "stopstatus", label: "Stop status", command: "stopstatus", description: "Stop active all-status jobs.", ownerOnly: true },
    { id: "allchat", label: "All chat", command: "allchat", description: "Mention members across groups.", ownerOnly: true },
    { id: "allchatx", label: "All chat ×", command: "allchatx", description: "Repeat hidden-member mentions.", ownerOnly: true },
    { id: "stopchat", label: "Stop chat", command: "stopchat", description: "Stop active all-chat jobs.", ownerOnly: true },
    { id: "stopstag", label: "Stop smart tag", command: "stopstag", description: "Stop active smart-tag jobs.", ownerOnly: true },
    { id: "setsudo", label: "Sudo", command: "setsudo", description: "Manage session and global sudo identities.", ownerOnly: true },
    { id: "purge", label: "Purge", command: "purge", description: "Permanently remove this session.", ownerOnly: true },
  ];

  return {
    title: `PAPPY OMEGA MINI · ${session.sessionName}`,
    subtitle: "Compact command surface",
    statusLine: `${liveStatus} · prefix ${session.prefix || "none"} · join ${session.autoJoinEnabled ? "ON" : "OFF"} · validator AUTO · links ${session.collectedLinkCount ?? 0}/${session.validatedLinkCount ?? 0}`,
    actions: actions.filter((action) => !action.ownerOnly || isOwner),
  };
}

export function renderAsciiMenu(model: SessionMenuModel): string {
  const sessionName = model.title.split("·").slice(1).join("·").trim() || "Pappy";
  const [status = "UNKNOWN", prefix = "prefix none", autoJoin = "join OFF", validator = "validator AUTO", links = "links 0/0"] = model.statusLine.split(" · ");
  const commandSet = new Set(["menu", "ping", "profile", "health", "support"]);
  const sessionSet = new Set(["autojoin", "targetgs", "setprefix", "pfp", "setgpp", "setname", "setbio", "groups", "creategroup"]);
  const localSet = new Set(["gstatus", "tag", "stag", "iggc"]);
  const ownerSet = new Set(["pair", "previewdebug", "broadcastdelay", "allstatus", "allstatusx", "gstatusx", "stopstatus", "allchat", "allchatx", "stopchat", "stopstag", "setsudo", "purge"]);
  const renderSection = (title: string, icon: string, set: Set<string>): string[] => {
    const rows = model.actions.filter((action) => set.has(action.command));
    if (!rows.length) return [];
    return [
      `⌬ ⤷ *${title}* ${icon}`,
      ...rows.map((action) => `⊹ ${action.command}`),
      "",
    ];
  };
  return [
    "✦ PAPPY OMEGA MINI",
    "‎ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    `˗ˏˋ ☏ ˎˊ˗  *Hello, ${sessionName}*  ✦`,
    "─────────────",
    `⎔ Owner   · ⇆ ${sessionName}`,
    `⎔ Status  · ⇆ ${status}`,
    `⎔ AutoJ   · ⇆ ${autoJoin.replace("join ", "")}`,
    `⎔ Prefix  · ⇆ [ ${prefix.replace("prefix ", "")} ]`,
    `⎔ Health  · ⇆ ${validator}`,
    `⎔ Links   · ⇆ ${links.replace("links ", "")}`,
    "─────────────",
    "",
    ...renderSection("COMMANDS", "⚙️", commandSet),
    ...renderSection("SESSION", "🗝", sessionSet),
    ...renderSection("LOCAL", "⎔", localSet),
    ...renderSection("OWNER / SUDO", "𓋎⚇", ownerSet),
  ].join("\n").trim();
}
