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
    {
      id: "profile",
      label: "Profile",
      command: "profile",
      description: "View session identity and health.",
    },
    {
      id: "pfp",
      label: "PFP",
      command: "pfp",
      description: "Get, change, or remove the WhatsApp profile picture.",
    },
    {
      id: "creategroup",
      label: "Create Group",
      command: "creategroup",
      description: "Create a WhatsApp group with optional members.",
    },
    {
      id: "name",
      label: "Name",
      command: "setname",
      description: "Read or update the WhatsApp display name.",
    },
    {
      id: "bio",
      label: "Bio",
      command: "setbio",
      description: "Read or update the WhatsApp bio.",
    },
    {
      id: "groups",
      label: "Groups",
      command: "groups",
      description: "Browse groups with pagination.",
    },
    {
      id: "bridge",
      label: "Session Bridge",
      command: "bridge",
      description: "Bind bridge traffic to this WhatsApp session only.",
    },
    {
      id: "gpp",
      label: "Group Picture",
      command: "setgpp",
      description: "Change the current group picture from quoted media.",
    },
    {
      id: "autojoin",
      label: `Auto-join: ${session.autoJoinEnabled ? "ON" : "OFF"}`,
      command: "autojoin",
      description: "Toggle conservative invite-link auto-join handling.",
    },
    {
      id: "join",
      label: "Join Manager",
      command: "join",
      description: "Start, pause, or stop bounded join jobs.",
    },
    {
      id: "sudo",
      label: "Sudo",
      command: "setsudo",
      description: "Manage per-session sudo numbers.",
      ownerOnly: true,
    },
    {
      id: "prefix",
      label: "Prefix",
      command: "setprefix",
      description: "Set the session command prefix.",
    },
    {
      id: "health",
      label: "Session Health",
      command: "health",
      description: "View reconnect and queue health.",
    },
    {
      id: "purge",
      label: "Purge Session",
      command: "purge",
      description:
        "Stop this session and permanently remove its encrypted auth state.",
    },
  ];

  return {
    title: `PAPPY OMEGA MINI · ${session.sessionName}`,
    subtitle: "One command surface, two polished interfaces.",
    statusLine: `${liveStatus} · prefix ${session.prefix || "none"} · auto-join ${session.autoJoinEnabled ? "ON" : "OFF"}`,
    actions: actions.filter((action) => !action.ownerOnly || isOwner),
  };
}

export function renderAsciiMenu(model: SessionMenuModel): string {
  const width = Math.max(42, Math.min(68, model.title.length + 8));
  const line = "═".repeat(width);
  const pad = (value: string) => `║ ${value.padEnd(width - 3, " ")}║`;
  const rows = model.actions.map((action, index) => {
    const shortcut = `${index + 1}`.padStart(2, "0");
    return pad(
      `${shortcut}  ${action.command.padEnd(10, " ")}  ${action.label}`,
    );
  });

  return [
    `╔${line}╗`,
    pad("✦  PAPPY OMEGA MINI"),
    pad(model.title),
    pad(model.subtitle),
    `╠${line}╣`,
    pad(model.statusLine),
    `╠${line}╣`,
    ...rows,
    `╚${line}╝`,
  ].join("\n");
}
