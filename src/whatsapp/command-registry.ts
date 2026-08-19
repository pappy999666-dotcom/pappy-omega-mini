import { randomUUID } from "node:crypto";
import type { WhatsAppSession } from "../types/domain.js";
import {
  getSession,
  getWorkspaceSudo,
  updateSession,
  updateWorkspaceSudo,
} from "../core/session-registry.js";
import {
  buildSessionMenu,
  effectiveSessionStatus,
  renderAsciiMenu,
} from "../menus/menu-model.js";
import { createSupportTicket } from "../persistence/mongo.js";
import {
  createWhatsAppGroup,
  getProfilePictureUrl,
  listGroups,
  removeProfilePicture,
  updateProfileBio,
  updateProfileName,
  updateProfilePicture,
  updateGroupProfilePicture,
  updateGroupDescription,
  getGroupInviteCode,
} from "./transport-adapter.js";

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  isOwner: boolean;
  senderJid?: string;
  chatJid?: string;
  media?: { kind: "image" | "video"; bytes: Buffer; mimeType?: string };
  args: string[];
  enqueueJob?: (input: {
    kind: "gstatus" | "allstatus" | "allchat" | "tag";
    payload: Record<string, unknown>;
  }) => Promise<string>;
  cancelJobs?: (
    kind: "gstatus" | "allstatus" | "allchat" | "tag",
  ) => Promise<number>;
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
      name: "pair",
      aliases: [],
      description: "Start pairing from the Telegram control plane.",
      ownerOnly: true,
      run: async () =>
        "Pairing is controlled by Telegram for workspace ownership and safety. Open Telegram → Pair to create or attach a WhatsApp session.",
    },
    {
      name: "ping",
      aliases: [],
      description: "Fast session health check.",
      run: async (ctx) =>
        `PAPPY OMEGA MINI · ${session(ctx).sessionName}\n${effectiveSessionStatus(session(ctx))} · ${new Date().toISOString()}`,
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
          `Status: ${effectiveSessionStatus(current)}`,
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
      aliases: ["setpfp", "getpfp", "removepfp"],
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
            if (ctx.media?.kind === "image") {
              await updateProfilePicture(
                ctx.workspaceId,
                ctx.sessionId,
                ctx.media.bytes,
              );
              return "Profile picture updated in HD from the original replied image; no bot-side crop was applied.";
            }
            const url = ctx.args[1];
            if (!url || !/^https:\/\//i.test(url))
              return "Reply to an image or use .pfp set <https image URL>.";
            await updateProfilePicture(ctx.workspaceId, ctx.sessionId, url);
            return "Profile picture updated in HD.";
          }
          return "Usage: .pfp get | reply to an image with .setpfp | .pfp remove";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "setgpp",
      aliases: ["gpp"],
      description:
        "Change a WhatsApp group profile picture from an HTTPS image URL.",
      run: async (ctx) => {
        const jid =
          ctx.args[0] ||
          (ctx.chatJid?.endsWith("@g.us") ? ctx.chatJid : undefined);
        const url = ctx.args[1];
        if (!jid || (!ctx.media && (!url || !/^https:\/\//i.test(url))))
          return "Reply to an image inside the target group, or use .setgpp <groupJid> <https image URL>.";
        try {
          await updateGroupProfilePicture(
            ctx.workspaceId,
            ctx.sessionId,
            jid,
            ctx.media?.kind === "image" ? ctx.media.bytes : (url as string),
          );
          return `Group profile picture updated in HD for ${jid}; no bot-side crop was applied.`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
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
        const raw = ctx.args.join(" ").trim();
        if (!raw)
          return "Usage: .creategroup <name> [| description] [| participant numbers]";
        const parts = raw.split("|").map((part) => part.trim());
        const subject = parts[0] ?? "";
        const description = parts[1] ?? "";
        const participants = (parts[2] ?? "")
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (!subject)
          return "Usage: .creategroup <name> [| description] [| participant numbers]";
        try {
          const jid = await createWhatsAppGroup(
            ctx.workspaceId,
            ctx.sessionId,
            subject,
            participants,
          );
          if (description)
            await updateGroupDescription(
              ctx.workspaceId,
              ctx.sessionId,
              jid,
              description,
            );
          if (ctx.media?.kind === "image")
            await updateGroupProfilePicture(
              ctx.workspaceId,
              ctx.sessionId,
              jid,
              ctx.media.bytes,
            );
          const invite = await getGroupInviteCode(
            ctx.workspaceId,
            ctx.sessionId,
            jid,
          ).catch(() => undefined);
          return `Group created: ${subject}\\nJID: ${jid}${description ? "\\nDescription initialized." : ""}${invite ? `\\nInvite: https://chat.whatsapp.com/${invite}` : ""}`;
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
      aliases: ["allstatusx"],
      description: "Queue bounded delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const repeat = /^\d+$/.test(ctx.args[0] ?? "")
          ? Math.max(1, Math.min(20, Number(ctx.args.shift())))
          : 1;
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .allstatus [repeat] <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat },
        });
        return `All-status job queued: ${jobId}`;
      },
    },
    {
      name: "gstatus",
      aliases: ["gstatusx"],
      description: "Queue status delivery for the current WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        const repeat =
          ctx.args[0] && /^\d+$/.test(ctx.args[0])
            ? Number(ctx.args.shift())
            : 1;
        const count = Math.max(1, Math.min(20, repeat));
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .gstatus [count] <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "gstatus",
          payload: { text, groups: [ctx.chatJid], count },
        });
        return `Group-status job queued: ${jobId}`;
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
      aliases: ["allchatx"],
      description: "Queue bounded delivery to all eligible group chats.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const repeat = /^\d+$/.test(ctx.args[0] ?? "")
          ? Math.max(1, Math.min(20, Number(ctx.args.shift())))
          : 1;
        const text = ctx.args.join(" ").trim();
        if (!text) return "Usage: .allchat [repeat] <text>.";
        const jobId = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text, count: repeat },
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
      run: async (ctx) => {
        const current = session(ctx);
        const inbound = current.lastMessageReceivedAt;
        const outbound = current.lastOutboundMessageAt;
        return `Health: ${effectiveSessionStatus(current)}\nAuth: ${current.authHealth ?? "UNKNOWN"}\nLast inbound: ${inbound ? new Date(inbound).toISOString() : "none"}\nLast outbound: ${outbound ? new Date(outbound).toISOString() : "none"}\nQueue policy: bounded\nReconnect policy: non-destructive`;
      },
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
  const invokedName = name?.toLowerCase() ?? "";
  const command = registry.find(
    (item) => item.name === invokedName || item.aliases.includes(invokedName),
  );
  if (!command) return `Unknown command. Use ${session(ctx).prefix}menu.`;
  if (command.ownerOnly && !ctx.isOwner)
    return "This command is restricted to the session owner.";
  const normalizedArgs =
    command.name === "pfp" && invokedName === "setpfp"
      ? ["set", ...args]
      : command.name === "pfp" && invokedName === "getpfp"
        ? ["get", ...args]
        : command.name === "pfp" && invokedName === "removepfp"
          ? ["remove", ...args]
          : args;
  return command.run({ ...ctx, args: normalizedArgs });
}
