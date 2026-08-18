import type { WhatsAppSession } from "../types/domain.js";
import { getSession, updateSession } from "../core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../menus/menu-model.js";
import {
  listGroups,
  updateProfileBio,
  updateProfileName,
} from "./transport-adapter.js";

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  isOwner: boolean;
  args: string[];
  enqueueJob?: (input: {
    kind: "allstatus" | "allchat" | "tag";
    payload: Record<string, unknown>;
  }) => Promise<string>;
  cancelJobs?: (kind: "allstatus" | "allchat" | "tag") => Promise<number>;
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
        "Unsupported capability: profilePicture. The installed Baileys transport does not expose a safe profile-picture operation.",
    },
    {
      name: "setgpp",
      aliases: ["gpp"],
      description:
        "Change the current group profile picture from quoted media.",
      run: async () =>
        "Unsupported capability: groupProfilePicture. The installed Baileys transport does not expose a safe group-picture operation.",
    },
    {
      name: "setname",
      aliases: ["name"],
      description: "Read or update the WhatsApp display name.",
      run: async (ctx) => {
        if (!ctx.args.length) return "Usage: .setname <new display name>.";
        try {
          await updateProfileName(
            ctx.workspaceId,
            ctx.sessionId,
            ctx.args.join(" "),
          );
          return `Display name updated to: ${ctx.args.join(" ")}`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "setbio",
      aliases: ["bio"],
      description: "Read or update the WhatsApp bio.",
      run: async (ctx) => {
        if (!ctx.args.length) return "Usage: .setbio <new bio>.";
        try {
          await updateProfileBio(
            ctx.workspaceId,
            ctx.sessionId,
            ctx.args.join(" "),
          );
          return "Bio updated successfully.";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "groups",
      aliases: ["mygroups"],
      description: "Browse groups with pagination.",
      run: async (ctx) => {
        try {
          const groups = await listGroups(ctx.workspaceId, ctx.sessionId);
          if (!groups.length) return "No WhatsApp groups were returned.";
          return groups
            .slice(0, 40)
            .map(
              (group, index) =>
                `${index + 1}. ${group.subject} · ${group.participantCount} members\n${group.jid}`,
            )
            .join("\n");
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "allstatus",
      aliases: [],
      description: "Queue bounded delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .allstatus <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text },
        });
        return `All-status job queued: ${jobId}`;
      },
    },
    {
      name: "stopstatus",
      aliases: [],
      description: "Cancel active all-status work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("allstatus")} all-status job(s).`
          : "Queue runtime is unavailable.",
    },
    {
      name: "allchat",
      aliases: [],
      description: "Queue bounded delivery to all eligible group chats.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .allchat <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text },
        });
        return `All-chat job queued: ${jobId}`;
      },
    },
    {
      name: "stopchat",
      aliases: [],
      description: "Cancel active all-chat work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("allchat")} all-chat job(s).`
          : "Queue runtime is unavailable.",
    },
    {
      name: "tag",
      aliases: [],
      description: "Queue safe WhatsApp mention entities in each group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const count = /^\d+$/.test(ctx.args[0] ?? "")
          ? Number(ctx.args.shift())
          : undefined;
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .tag [count] <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "tag",
          payload: { text, ...(count ? { count } : {}) },
        });
        return `Tag job queued: ${jobId}`;
      },
    },
    {
      name: "stoptag",
      aliases: [],
      description: "Cancel active tag work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("tag")} tag job(s).`
          : "Queue runtime is unavailable.",
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
      run: async (ctx) => {
        const action = ctx.args[0]?.toLowerCase();
        if (action === "list")
          return session(ctx).sudoList.length
            ? `Sudo identities:\n${session(ctx).sudoList.join("\n")}`
            : "No sudo identities configured.";
        const identity = ctx.args[1]?.replace(/[^0-9:@.-]/g, "");
        if (!identity || !["add", "remove"].includes(action ?? ""))
          return "Usage: .setsudo add|remove|list <WhatsApp identity>.";
        const current = session(ctx).sudoList;
        const next =
          action === "add"
            ? [...new Set([...current, identity])]
            : current.filter((item) => item !== identity);
        updateSession(ctx.workspaceId, ctx.sessionId, { sudoList: next });
        return `Sudo ${action} complete for ${identity}.`;
      },
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
