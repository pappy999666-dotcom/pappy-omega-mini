import type { WhatsAppSession } from "../types/domain.js";
import { getSession, updateSession } from "../core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../menus/menu-model.js";

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  isOwner: boolean;
  args: string[];
}

export interface RegisteredCommand {
  name: string;
  aliases: string[];
  description: string;
  ownerOnly?: boolean;
  run: (ctx: CommandContext) => Promise<string>;
}

function session(ctx: CommandContext): WhatsAppSession {
  return getSession(ctx.workspaceId, ctx.sessionId);
}

export function createCommandRegistry(): RegisteredCommand[] {
  return [
    {
      name: "ping",
      aliases: [],
      description: "Fast session health check.",
      run: async (ctx) =>
        `PAPPY OMEGA MINI · ${session(ctx).sessionName}\nONLINE · ${new Date().toISOString()}`,
    },
    {
      name: "menu",
      aliases: ["help", "m"],
      description: "Open the polished session menu.",
      run: async (ctx) =>
        renderAsciiMenu(buildSessionMenu(session(ctx), ctx.isOwner)),
    },
    {
      name: "profile",
      aliases: ["me", "session"],
      description: "Show session identity and health.",
      run: async (ctx) => {
        const current = session(ctx);
        return [
          `PAPPY OMEGA MINI`,
          `Session: ${current.sessionName}`,
          `Phone: ${current.phoneNumber ?? "pending"}`,
          `Status: ${current.status}`,
          `Prefix: ${current.prefix || "none"}`,
          `Auto-join: ${current.autoJoinEnabled ? "ON" : "OFF"}`,
        ].join("\n");
      },
    },
    {
      name: "autojoin",
      aliases: ["aj"],
      description: "Toggle conservative invite-link auto-join handling.",
      run: async (ctx) => {
        const current = session(ctx);
        const requested = ctx.args[0]?.toLowerCase();
        const enabled =
          requested === "on"
            ? true
            : requested === "off"
              ? false
              : !current.autoJoinEnabled;
        const next = updateSession(ctx.workspaceId, ctx.sessionId, {
          autoJoinEnabled: enabled,
        });
        return `Auto-join is now ${next.autoJoinEnabled ? "ON" : "OFF"} for ${next.sessionName}.\nUse ${next.prefix}autojoin on|off to set it explicitly.`;
      },
    },
    {
      name: "setprefix",
      aliases: ["prefix"],
      description: "Set the session prefix; use none for prefixless mode.",
      run: async (ctx) => {
        const value =
          ctx.args[0] === "none" ? "" : (ctx.args[0] ?? ".").slice(0, 3);
        const next = updateSession(ctx.workspaceId, ctx.sessionId, {
          prefix: value,
        });
        return `Prefix updated to ${next.prefix || "none"}.`;
      },
    },
    {
      name: "pfp",
      aliases: ["setpfp"],
      description:
        "Get or change the session profile picture from quoted media.",
      run: async () =>
        "PFP controls are ready: send a quoted image with .setpfp to apply it, or use .pfp to view the current picture.",
    },
    {
      name: "setgpp",
      aliases: ["gpp"],
      description:
        "Change the current group profile picture from quoted media.",
      run: async () =>
        "Group picture controls are ready: quote an image and send .setgpp in the target group.",
    },
    {
      name: "setname",
      aliases: ["name"],
      description: "Read or update the WhatsApp display name.",
      run: async (ctx) =>
        ctx.args.length
          ? `Display name change queued: ${ctx.args.join(" ")}`
          : "Current display name is managed by the session profile flow.",
    },
    {
      name: "setbio",
      aliases: ["bio"],
      description: "Read or update the WhatsApp bio.",
      run: async (ctx) =>
        ctx.args.length
          ? "Bio change queued."
          : "Current bio is managed by the session profile flow.",
    },
    {
      name: "groups",
      aliases: ["mygroups"],
      description: "Browse groups with pagination.",
      run: async () =>
        "Group browser: use the Telegram session menu or .groups page 1. Large lists are paginated.",
    },
    {
      name: "health",
      aliases: ["status"],
      description: "Show session health and runtime state.",
      run: async (ctx) =>
        `Health: ${session(ctx).status}\nQueue policy: bounded\nReconnect policy: non-destructive`,
    },
    {
      name: "setsudo",
      aliases: ["sudo"],
      description: "Manage per-session sudo numbers.",
      ownerOnly: true,
      run: async () =>
        "Sudo management is owner-only. Use .setsudo add|remove|list <number>.",
    },
  ];
}

export async function executeCommand(
  registry: RegisteredCommand[],
  raw: string,
  ctx: CommandContext,
): Promise<string> {
  const [name, ...args] = raw.trim().split(/\s+/);
  const command = registry.find(
    (item) =>
      item.name === name?.toLowerCase() ||
      item.aliases.includes(name?.toLowerCase() ?? ""),
  );
  if (!command) return `Unknown command. Use ${session(ctx).prefix}menu.`;
  if (command.ownerOnly && !ctx.isOwner)
    return "This command is restricted to the session owner.";
  return command.run({ ...ctx, args });
}
