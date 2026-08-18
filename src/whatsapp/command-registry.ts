import { randomUUID } from "node:crypto";
import type { WhatsAppSession } from "../types/domain.js";
import {
  getSession,
  getWorkspaceSudo,
  updateSession,
  updateWorkspaceSudo,
} from "../core/session-registry.js";
import { buildSessionMenu, renderAsciiMenu } from "../menus/menu-model.js";
import { createSupportTicket } from "../persistence/mongo.js";
import {
  createWhatsAppGroup,
  getProfilePictureUrl,
  listGroups,
  removeProfilePicture,
  updateProfileBio,
  updateProfileName,
  updateProfilePicture,
} from "./transport-adapter.js";

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  isOwner: boolean;
  senderJid?: string;
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
      name: "support",
      aliases: ["helpdesk", "ticket"],
      description: "Create a support ticket for this WhatsApp sender.",
      run: async (ctx) => {
        const message = ctx.args.join(" ").trim();
        if (!message) return "Usage: .support <describe your issue>.";
        const now = Date.now();
        const ticketId = randomUUID();
        await createSupportTicket({
          ticketId,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          ...(ctx.senderJid ? { senderJid: ctx.senderJid } : {}),
          message: message.slice(0, 4000),
          status: "open",
          createdAt: now,
          updatedAt: now,
        });
        return `Support ticket opened: ${ticketId}. An owner can review it from the Support Inbox.`;
      },
    },
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
      description: "Get, change, or remove the session profile picture.",
      run: async (ctx) => {
        try {
          const action = (ctx.args[0] ?? "get").toLowerCase();
          if (action === "get") {
            const url = await getProfilePictureUrl(
              ctx.workspaceId,
              ctx.sessionId,
            );
            return url
              ? `Profile picture: ${url}`
              : "No profile picture is currently set.";
          }
          if (action === "remove" || action === "delete") {
            await removeProfilePicture(ctx.workspaceId, ctx.sessionId);
            return "Profile picture removed.";
          }
          if (action === "set" || action === "change") {
            const url = ctx.args[1];
            if (!url || !/^https:\/\//i.test(url))
              return "Usage: .pfp set <https image URL>";
            await updateProfilePicture(ctx.workspaceId, ctx.sessionId, url);
            return "Profile picture updated.";
          }
          return "Usage: .pfp get | .pfp set <https image URL> | .pfp remove";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
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
      name: "creategroup",
      aliases: ["newgroup", "groupcreate"],
      description: "Create a WhatsApp group with optional participant JIDs.",
      run: async (ctx) => {
        const subject = ctx.args[0];
        if (!subject) return "Usage: .creategroup <name> [participantJid ...]";
        try {
          const jid = await createWhatsAppGroup(
            ctx.workspaceId,
            ctx.sessionId,
            subject,
            ctx.args.slice(1),
          );
          return `Group created: ${subject}\\n${jid}`;
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
        const global = ctx.args[0]?.toLowerCase() === "global";
        const offset = global ? 1 : 0;
        const action = ctx.args[offset]?.toLowerCase();
        if (global && action === "list") {
          const identities = getWorkspaceSudo(ctx.workspaceId);
          return identities.length
            ? `Global sudo identities:\n${identities.join("\n")}`
            : "No global sudo identities configured.";
        }
        if (!global && action === "list")
          return session(ctx).sudoList.length
            ? `Session sudo identities:\n${session(ctx).sudoList.join("\n")}`
            : "No session sudo identities configured.";
        const identity = ctx.args[offset + 1]?.replace(
          /[^0-9A-Za-z:_.@-]/g,
          "",
        );
        if (!identity || !["add", "remove"].includes(action ?? ""))
          return "Usage: .setsudo add|remove|list <WhatsApp identity> or .setsudo global add|remove|list <WhatsApp identity>.";
        if (global) {
          const next = updateWorkspaceSudo(
            ctx.workspaceId,
            action as "add" | "remove",
            identity,
          );
          return `Global sudo ${action} complete for ${identity}.\nInherited by ${next.length} configured identity${next.length === 1 ? "" : "ies"}.`;
        }
        const current = session(ctx).sudoList;
        const next =
          action === "add"
            ? [...new Set([...current, identity])]
            : current.filter((item) => item !== identity);
        updateSession(ctx.workspaceId, ctx.sessionId, { sudoList: next });
        return `Session sudo ${action} complete for ${identity}.`;
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
