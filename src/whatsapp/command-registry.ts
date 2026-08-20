import { randomUUID } from "node:crypto";
import type { WhatsAppSession } from "../types/domain.js";
import {
  getSession,
  getSessionJoinSettings,
  getWorkspaceDefaults,
  getWorkspaceSudo,
  updateSession,
  updateSessionJoinSettings,
  updateWorkspaceDefaults,
  updateWorkspaceSudo,
} from "../core/session-registry.js";
import {
  buildSessionMenu,
  effectiveSessionStatus,
  renderAsciiMenu,
} from "../menus/menu-model.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import {
  getPreviewDebugSnapshot,
  prepareCanonicalPreviewContent,
} from "./baileys-native-preview.js";
import { createSupportTicket } from "../persistence/mongo.js";
import { canonicalizeHttpUrl } from "../links/url-canonicalization.js";
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

export interface EnqueueJobResult {
  jobCode: string;
  totalGroups?: number;
  totalPosts?: number;
  delayMs?: number;
  expectedTimeMs?: number;
}

export interface EnqueueJoinJobResult {
  jobCode: string;
  targetCount: number;
  delayMs: number;
  expectedTimeMs: number;
}

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  isOwner: boolean;
  senderJid?: string;
  quotedSenderJid?: string;
  mentionedJids?: string[];
  chatJid?: string;
  media?: WhatsAppMediaPayload;
  args: string[];
  invokedName?: string;
  rawPayload?: string;
  pairSession?: (input: {
    label: string;
    phoneNumber: string;
  }) => Promise<{ sessionName: string; phoneNumber: string; code: string }>;
  enqueueJob?: (input: {
    kind: "gstatus" | "allstatus" | "allchat" | "tag";
    payload: Record<string, unknown>;
  }) => Promise<string | EnqueueJobResult>;
  enqueueJoinJob?: (input: {
    payload: Record<string, unknown>;
  }) => Promise<string | EnqueueJoinJobResult>;
  sendCurrentGroupStatus?: (input: {
    text: string;
    repeat: number;
  }) => Promise<void>;
  sendCurrentGroupHidetag?: (input: {
    text: string;
    participantCount?: number;
  }) => Promise<void>;
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

function mediaCommandPayload(ctx: CommandContext): string {
  const inline = (ctx.rawPayload ?? ctx.args.join(" ")).trim();
  if (inline) return inline;
  const caption = ctx.media?.caption?.trim() ?? "";
  if (!caption) return "";
  const invokedName = ctx.invokedName?.trim() ?? "";
  const prefix = session(ctx).prefix;
  const commandToken = `${prefix}${invokedName}`.trim().toLowerCase();
  if (
    commandToken &&
    caption.toLowerCase().startsWith(commandToken) &&
    (!caption[commandToken.length] ||
      /\s/.test(caption[commandToken.length] ?? ""))
  )
    return caption.slice(commandToken.length).trim();
  return caption;
}

function formatSeconds(milliseconds: number): string {
  return `${Math.max(0, Math.round(milliseconds / 1000))}s`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function queuedJobAcknowledgement(
  kind: "allstatus" | "allchat",
  result: string | EnqueueJobResult,
): string {
  if (typeof result === "string")
    return `${kind === "allstatus" ? "All-status" : "All-chat"} job queued: ${result}`;
  const delay = Math.max(1, Math.round((result.delayMs ?? 20000) / 1000));
  const totalGroups = result.totalGroups ?? "—";
  const totalPosts = result.totalPosts ?? "—";
  const expectedTime =
    result.expectedTimeMs === undefined
      ? "—"
      : (() => {
          const expectedSeconds = Math.max(
            0,
            Math.ceil(result.expectedTimeMs / 1000),
          );
          const minutes = Math.floor(expectedSeconds / 60);
          const seconds = expectedSeconds % 60;
          return `${minutes}m ${seconds}s`;
        })();
  return [
    `✦ PAPPY OMEGA MINI · ${kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT"}`,
    "─────────────────────",
    `Total groups  · ${totalGroups}`,
    `Expected posts · ${totalPosts}`,
    `Delay         · ${delay}s`,
    `Expected time · ${expectedTime}`,
    `Live code     · ${result.jobCode}`,
    "",
  ].join("\n");
}

function repeatAndPayload(
  ctx: CommandContext,
  enabled: boolean,
): { repeat: number; text: string } {
  const raw = ctx.rawPayload ?? ctx.args.join(" ");
  if (!enabled) return { repeat: 1, text: mediaCommandPayload(ctx) };
  const match = /^(\d+)(?:[ \t]+|\n+)([\s\S]*)$/.exec(raw);
  if (!match) return { repeat: 1, text: mediaCommandPayload(ctx) };
  return {
    repeat: Math.max(1, Math.min(20, Number(match[1] ?? 1))),
    text: (match[2] ?? "").trim(),
  };
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
      description: "Create and pair a WhatsApp session from this owner chat.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.pairSession)
          return "WhatsApp pairing is unavailable from this transport.";
        const raw = mediaCommandPayload(ctx);
        const parts = raw.split(/\s+/).filter(Boolean);
        const label = parts[0] ?? "whatsapp-session";
        const phoneNumber = parts[1] ?? "";
        if (!/^\d{8,15}$/.test(phoneNumber.replace(/\D/g, "")))
          return "Usage: .pair <label> <international-phone-number>. Example: .pair support 2348012345678";
        try {
          const paired = await ctx.pairSession({ label, phoneNumber });
          return [
            "✦ PAPPY OMEGA MINI · PAIRING",
            "─────────────────────",
            `Session · ${paired.sessionName}`,
            `Phone   · ${paired.phoneNumber}`,
            `Code    · ${paired.code}`,
            "",
            "Open WhatsApp → Linked Devices → Link a Device → Link with phone number, then enter the code.",
            "The new session is chained to this workspace and its source Telegram owner.",
          ].join("\n");
        } catch (error) {
          return `Pairing failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
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
      name: "previewdebug",
      aliases: ["previewdiag"],
      description: "Inspect the canonical Baileys-native preview pipeline.",
      ownerOnly: true,
      run: async (ctx) => {
        const url = ctx.args.join(" ").trim();
        if (!url) return "Usage: .previewdebug <https://example.com/...>.";
        const scope = `${ctx.workspaceId}:${ctx.sessionId}`;
        await prepareCanonicalPreviewContent({
          text: url,
          content: { text: url },
          cacheScope: scope,
        });
        const debug = getPreviewDebugSnapshot(scope);
        if (!debug) return "LINK PREVIEW DEBUG\nResult: FALLBACK\nReason: no snapshot.";
        return [
          "LINK PREVIEW DEBUG",
          `URL: ${debug.url}`,
          `Canonical: ${debug.canonicalUrl}`,
          `Title: ${debug.title ?? "—"}`,
          `Description: ${debug.description ?? "—"}`,
          `Selected Image: ${debug.selectedImageUrl ?? "—"}`,
          `Source Dimensions: ${debug.sourceWidth ?? "—"} × ${debug.sourceHeight ?? "—"}`,
          `Source Bytes: ${debug.sourceBytes ?? "—"}`,
          `Processing: ${debug.processing}`,
          `Crop: ${debug.crop}`,
          `Compression: ${debug.compression}`,
          `Baileys Preview Flag: ${debug.nativeFlag}`,
          `Baileys Payload: ${debug.payload}`,
          `Cache: ${debug.cache}`,
          `Result: ${debug.result}`,
          ...(debug.reason ? [`Reason: ${debug.reason}`] : []),
        ].join("\n");
      },
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
        if (enabled && ctx.enqueueJoinJob) {
          const settings = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
          const started = await ctx.enqueueJoinJob({
            payload: {
              targetCount: settings.targetCount,
              delayMs: settings.delayMs,
              minDelayMs: settings.minDelayMs,
              maxDelayMs: settings.maxDelayMs,
              retryLimit: settings.retryLimit,
              retryBaseMs: settings.retryBaseMs,
              sessionCooldownMs: settings.sessionCooldownMs,
              restrictionThreshold: settings.restrictionThreshold,
              requestMode: settings.mode,
              sourceBucket: "active",
            },
          });
          if (typeof started === "string") return `${started}`;
          const expected = formatDuration(started.expectedTimeMs);
          return `Auto-join is ON for ${next.sessionName}.\nTarget       · ${started.targetCount} Active link(s)\nDelay        · ${formatSeconds(started.delayMs)}\nExpected time · ${expected}\nLive code    · ${started.jobCode}`;
        }
        return `Auto-join is now ${next.autoJoinEnabled ? "ON" : "OFF"} for ${next.sessionName}.\nUse ${next.prefix}autojoin on|off to set it explicitly.`;
      },
    },
    {
      name: "join",
      aliases: ["joinmanager", "joinstart"],
      description: "Start a real Active-bucket Join Manager worker.",
      run: async (ctx) => {
        if (!ctx.enqueueJoinJob) return "Join Manager is unavailable until the worker runtime is ready.";
        const current = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
        const started = await ctx.enqueueJoinJob({
          payload: {
            targetCount: current.targetCount,
            delayMs: current.delayMs,
            minDelayMs: current.minDelayMs,
            maxDelayMs: current.maxDelayMs,
            retryLimit: current.retryLimit,
            retryBaseMs: current.retryBaseMs,
            sessionCooldownMs: current.sessionCooldownMs,
            restrictionThreshold: current.restrictionThreshold,
            requestMode: current.mode,
            sourceBucket: "active",
          },
        });
        if (typeof started === "string") return started;
        return `Join Manager started.\nTarget       · ${started.targetCount} Active link(s)\nDelay        · ${formatSeconds(started.delayMs)}\nExpected time · ${formatDuration(started.expectedTimeMs)}\nLive code    · ${started.jobCode}`;
      },
    },
    {
      name: "targetgs",
      aliases: ["jointarget", "jointargets"],
      description: "Set or inspect the Active-bucket Join Manager target.",
      run: async (ctx) => {
        const current = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
        const raw = mediaCommandPayload(ctx).trim();
        if (!raw)
          return `Join target: ${current.targetCount} Active link(s).\nUsage: ${session(ctx).prefix}targetgs <1-10000>.`;
        if (!/^\d+$/.test(raw))
          return `Usage: ${session(ctx).prefix}targetgs <1-10000>.`;
        const targetCount = Number(raw);
        if (targetCount < 1 || targetCount > 10000)
          return "Join target must be between 1 and 10000 links.";
        const next = updateSessionJoinSettings(ctx.workspaceId, ctx.sessionId, { targetCount });
        return `Join target updated: ${next.joinSettings?.targetCount ?? targetCount} Active link(s).`;
      },
    },
    {
      name: "iggc",
      aliases: ["ignoregc", "ignoregroup"],
      description: "Ignore or list WhatsApp groups excluded from broadcasts.",
      ownerOnly: true,
      run: async (ctx) => {
        const current = session(ctx);
        const raw = mediaCommandPayload(ctx).trim();
        if (!raw || raw.toLowerCase() === "list")
          return current.ignoredGroupLinks?.length
            ? `Ignored groups (${current.ignoredGroupLinks.length}):\n${current.ignoredGroupLinks.join("\n")}`
            : "No ignored WhatsApp groups configured.";
        if (raw.toLowerCase() === "clear") {
          updateSession(ctx.workspaceId, ctx.sessionId, { ignoredGroupLinks: [] });
          return "Ignored WhatsApp group list cleared.";
        }
        const canonical = canonicalizeHttpUrl(raw);
        if (!canonical.toLowerCase().startsWith("https://chat.whatsapp.com/") || !/[A-Za-z0-9_-]+$/.test(canonical))
          return `Usage: ${current.prefix}iggc <WhatsApp group invite link>, ${current.prefix}iggc list, or ${current.prefix}iggc clear.`;
        const ignored = [...new Set([...(current.ignoredGroupLinks ?? []), canonical])];
        updateSession(ctx.workspaceId, ctx.sessionId, { ignoredGroupLinks: ignored });
        return `Group ignored for this session's broadcasts:\n${canonical}`;
      },
    },
    {
      name: "setprefix",
      aliases: ["prefix"],
      description:
        "Set the session prefix; use none or null for prefixless mode.",
      run: async (ctx) => {
        const requested = ctx.args[0]?.toLowerCase();
        const value =
          requested === "none" || requested === "null"
            ? ""
            : (ctx.args[0] ?? ".").slice(0, 3);
        const next = updateSession(ctx.workspaceId, ctx.sessionId, {
          prefix: value,
        });
        return `Your prefix is now ${next.prefix || "none"}.`;
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
      name: "broadcastdelay",
      aliases: ["setbroadcastdelay", "postdelay"],
      description: "Set the allchat/allstatus delay in seconds.",
      ownerOnly: true,
      run: async (ctx) => {
        const raw = mediaCommandPayload(ctx);
        if (!/^\d+$/.test(raw))
          return `Broadcast delay is ${Math.round(getWorkspaceDefaults(ctx.workspaceId).defaultBroadcastDelayMs / 1000)}s. Usage: .broadcastdelay <1-60>.`;
        const seconds = Number(raw);
        if (seconds < 1 || seconds > 60)
          return "Broadcast delay must be between 1 and 60 seconds.";
        const next = updateWorkspaceDefaults(ctx.workspaceId, {
          defaultBroadcastDelayMs: seconds * 1000,
        });
        return `Broadcast delay set to ${Math.round(next.defaultBroadcastDelayMs / 1000)}s for allchat/allstatus jobs.`;
      },
    },
    {
      name: "allstatus",
      aliases: [],
      description: "Queue bounded delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "allstatusx",
        );
        if (!text && !ctx.media)
          return "Usage: .allstatus [repeat] <text or media>.";
        const queued = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allstatus", queued);
      },
    },
    {
      name: "allstatusx",
      aliases: [],
      description: "Queue repeated status delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return "Usage: .allstatusx [repeat] <text or media>.";
        const queued = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allstatus", queued);
      },
    },
    {
      name: "gstatus",
      aliases: [],
      description:
        "Send one status payload directly to the current WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupStatus)
          return "WhatsApp transport is unavailable.";
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "gstatusx",
        );
        if (!text && !ctx.media)
          return repeat > 1
            ? "Usage: .gstatusx <count> <text or media> (or reply to a message)."
            : "Usage: .gstatus <text or media> (or reply to a message).";
        await ctx.sendCurrentGroupStatus({ text, repeat });
        return "";
      },
    },
    {
      name: "gstatusx",
      aliases: [],
      description: "Repeat status payload in the current WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupStatus)
          return "WhatsApp transport is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return "Usage: .gstatusx <count> <text or media> (or reply to a message).";
        await ctx.sendCurrentGroupStatus({ text, repeat });
        return "";
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
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "allchatx",
        );
        if (!text && !ctx.media)
          return "Usage: .allchat [repeat] <text or media>.";
        const queued = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allchat", queued);
      },
    },
    {
      name: "allchatx",
      aliases: [],
      description: "Queue repeated delivery to all eligible group chats.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return "Usage: .allchatx [repeat] <text or media>.";
        const queued = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allchat", queued);
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
      description: "Fast hidetag of every member in this WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupHidetag)
          return "WhatsApp transport is unavailable.";
        const numericCount =
          ctx.args.length === 1 && /^\d+$/.test(ctx.args[0] ?? "")
            ? Math.max(1, Math.min(1000, Number(ctx.args[0])))
            : undefined;
        const text = numericCount
          ? mediaCommandPayload({ ...ctx, args: [], rawPayload: "" })
          : mediaCommandPayload(ctx);
        if (!text && !ctx.media && numericCount === undefined)
          return "Usage: .tag <payload or media> or .tag <member-count>.";
        await ctx.sendCurrentGroupHidetag({
          text,
          ...(numericCount !== undefined
            ? { participantCount: numericCount }
            : {}),
        });
        return "";
      },
    },
    {
      name: "stag",
      aliases: [],
      description: "Immediate hidetag of every member in this WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupHidetag)
          return "WhatsApp transport is unavailable.";
        const text = mediaCommandPayload(ctx);
        if (!text && !ctx.media) return "Usage: .stag <payload or media>.";
        await ctx.sendCurrentGroupHidetag({ text });
        return "";
      },
    },
    {
      name: "stopstag",
      aliases: ["stoptag"],
      description: "Cancel active STag work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("tag")} STag job(s).`
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
        const suppliedIdentity =
          ctx.mentionedJids?.[0] ?? ctx.quotedSenderJid ?? ctx.args[offset + 1];
        const identityValue = suppliedIdentity
          ?.replace(/[^0-9A-Za-z:_.@-]/g, "")
          .trim();
        const identity = identityValue && /^\d+$/.test(identityValue)
          ? `${identityValue}@s.whatsapp.net`
          : identityValue;
        if (!identity || !["add", "remove"].includes(action ?? ""))
          return "Usage: reply to a WhatsApp user or mention them with .setsudo add|remove, or use .setsudo global add|remove <phone number>.";
        if (identity.endsWith("@lid") || identity.endsWith("@hosted.lid"))
          return "That WhatsApp identity is still a LID and could not be mapped to a phone JID. Reply to the user again after the session refreshes its identity map.";
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
  const normalizedRaw = raw.trim();
  const commandMatch = /^(\S+)(?:\s+|$)/.exec(normalizedRaw);
  const name = commandMatch?.[1] ?? "";
  const payloadStart = commandMatch?.[0]?.length ?? normalizedRaw.length;
  const args = normalizedRaw
    .slice(payloadStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const rawPayload = normalizedRaw.slice(payloadStart);
  const invokedName = name.toLowerCase();
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
  return command.run({
    ...ctx,
    invokedName,
    args: normalizedArgs,
    rawPayload,
  });
}
