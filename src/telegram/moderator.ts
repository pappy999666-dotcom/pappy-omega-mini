import { randomUUID } from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import {
  countModeratorWarnings,
  listModeratorEvents,
  listModeratorWarnings,
  loadModeratorGroup,
  saveModeratorEvent,
  saveModeratorGroup,
  saveModeratorWarning,
  type ModeratorGroupRecord,
} from "../persistence/mongo.js";

const ADMIN_STATUSES = new Set(["creator", "administrator"]);
const GROUP_TYPES = new Set(["group", "supergroup"]);

type CommandMessage = {
  text?: string;
  message_id?: number;
  reply_to_message?: {
    message_id?: number;
    from?: { id?: number };
  };
};

function commandMessage(ctx: Context): CommandMessage | undefined {
  const message = ctx.message;
  return message && "text" in message ? (message as CommandMessage) : undefined;
}

function groupId(ctx: Context): string | undefined {
  const chat = ctx.chat;
  return chat && GROUP_TYPES.has(chat.type) ? String(chat.id) : undefined;
}

function actorId(ctx: Context): string | undefined {
  return ctx.from ? String(ctx.from.id) : undefined;
}

function args(ctx: Context): string[] {
  const text = commandMessage(ctx)?.text?.trim() ?? "";
  return text.split(/\s+/).slice(1).filter(Boolean);
}

function targetId(ctx: Context): string | undefined {
  const replyTarget = commandMessage(ctx)?.reply_to_message?.from?.id;
  if (replyTarget) return String(replyTarget);
  return args(ctx)[0]?.replace(/^@/, "");
}

async function ensureGroup(
  ctx: Context,
): Promise<ModeratorGroupRecord | undefined> {
  const id = groupId(ctx);
  if (!id) {
    await ctx.reply(
      "This moderator command is available in Telegram groups only.",
    );
    return undefined;
  }
  const existing = await loadModeratorGroup(id).catch(() => undefined);
  if (existing) return existing;
  const created: ModeratorGroupRecord = {
    groupId: id,
    ...(ctx.chat && "title" in ctx.chat ? { title: ctx.chat.title } : {}),
    enabled: true,
    antiLink: false,
    antiSpam: false,
    warnLimit: 3,
    muteDefaultSeconds: 600,
    whitelist: [],
    staff: [],
    updatedAt: Date.now(),
  };
  await saveModeratorGroup(created);
  return created;
}

async function requireModerator(ctx: Context): Promise<boolean> {
  const id = groupId(ctx);
  const user = ctx.from;
  if (!id || !user) {
    await ctx.reply("Use this command inside a group as a moderator.");
    return false;
  }
  try {
    const member = await ctx.telegram.getChatMember(Number(id), user.id);
    if (!ADMIN_STATUSES.has(member.status)) {
      await ctx.reply("⛔ Moderator permission required.");
      return false;
    }
    return true;
  } catch (error) {
    await ctx.reply("⛔ I cannot verify moderator permissions in this group.");
    return false;
  }
}

async function recordEvent(
  ctx: Context,
  input: {
    rule: string;
    action: string;
    targetId?: string;
    reason?: string;
    success: boolean;
    failureReason?: string;
  },
): Promise<void> {
  const group = groupId(ctx);
  const actor = actorId(ctx);
  if (!group || !actor) return;
  const messageId = commandMessage(ctx)?.message_id;
  const base = {
    eventId: randomUUID(),
    groupId: group,
    actorId: actor,
    ...input,
    timestamp: Date.now(),
  };
  await saveModeratorEvent(messageId ? { ...base, messageId } : base).catch(
    () => undefined,
  );
}

async function restrict(
  ctx: Context,
  target: string,
  untilDate?: number,
): Promise<boolean> {
  const id = groupId(ctx);
  if (!id) return false;
  try {
    await ctx.telegram.restrictChatMember(Number(id), Number(target), {
      permissions: { can_send_messages: false },
      ...(untilDate ? { until_date: untilDate } : {}),
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function restore(ctx: Context, target: string): Promise<boolean> {
  const id = groupId(ctx);
  if (!id) return false;
  try {
    await ctx.telegram.restrictChatMember(Number(id), Number(target), {
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_invite_users: true,
        can_pin_messages: false,
        can_change_info: false,
      },
    });
    return true;
  } catch (error) {
    return false;
  }
}

export function installModeratorCommands(bot: Telegraf<Context>): void {
  bot.command("moderation", async (ctx) => {
    if (!groupId(ctx)) {
      await ctx.reply("Open this command inside a Telegram group.");
      return;
    }
    await ctx.reply(
      "✦ PAPPY OMEGA MINI · GROUP MODERATOR\n\n" +
        "/mute · /unmute · /warn · /warns\n" +
        "/settings · /protection · /antilink\n" +
        "/rules · /logs\n\n" +
        "Reply to a member’s message for moderation actions. Staff permissions are checked by Telegram.",
    );
  });

  bot.command("mute", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    const target = targetId(ctx);
    if (!group || !target) {
      await ctx.reply(
        "Reply to a member or provide a numeric Telegram user ID. Usage: /mute 600",
      );
      return;
    }
    const duration = Math.max(
      30,
      Math.min(86_400, Number(args(ctx)[0]) || group.muteDefaultSeconds),
    );
    const ok = await restrict(
      ctx,
      target,
      Math.floor(Date.now() / 1000) + duration,
    );
    await recordEvent(ctx, {
      rule: "manual",
      action: "mute",
      targetId: target,
      reason: `${duration}s`,
      success: ok,
      ...(ok ? {} : { failureReason: "Telegram restrictChatMember failed" }),
    });
    await ctx.reply(
      ok
        ? `✅ Member ${target} muted for ${duration}s.`
        : "⛔ Mute failed; check my administrator restrict-members permission.",
    );
  });

  bot.command("unmute", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const target = targetId(ctx);
    if (!target) {
      await ctx.reply(
        "Reply to a member or provide a numeric Telegram user ID. Usage: /unmute",
      );
      return;
    }
    const ok = await restore(ctx, target);
    await recordEvent(ctx, {
      rule: "manual",
      action: "unmute",
      targetId: target,
      success: ok,
      ...(ok ? {} : { failureReason: "Telegram restrictChatMember failed" }),
    });
    await ctx.reply(
      ok
        ? `✅ Member ${target} unmuted.`
        : "⛔ Unmute failed; check my administrator permissions.",
    );
  });

  bot.command("warn", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    const target = targetId(ctx);
    if (!group || !target) {
      await ctx.reply(
        "Reply to a member or provide a numeric Telegram user ID. Usage: /warn reason",
      );
      return;
    }
    const reason =
      args(ctx)
        .filter((value) => value !== target)
        .join(" ") || "moderator warning";
    const count = (await countModeratorWarnings(group.groupId, target)) + 1;
    await saveModeratorWarning({
      warningId: randomUUID(),
      groupId: group.groupId,
      userId: target,
      actorId: actorId(ctx) ?? "unknown",
      reason,
      count,
      createdAt: Date.now(),
    });
    const escalated = count >= group.warnLimit;
    const muted = escalated
      ? await restrict(
          ctx,
          target,
          Math.floor(Date.now() / 1000) + group.muteDefaultSeconds,
        )
      : false;
    await recordEvent(ctx, {
      rule: "warning",
      action: escalated ? "warn_escalate_mute" : "warn",
      targetId: target,
      reason,
      success: true,
    });
    await ctx.reply(
      escalated && muted
        ? `⚠️ Warning ${count}/${group.warnLimit}; member muted automatically.`
        : `⚠️ Warning ${count}/${group.warnLimit} recorded.`,
    );
  });

  bot.command("warns", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    const target = targetId(ctx);
    if (!group) return;
    const warnings = await listModeratorWarnings(group.groupId, target);
    await ctx.reply(
      warnings.length
        ? warnings
            .slice(0, 10)
            .map(
              (warning) =>
                `${warning.count}. ${warning.userId}: ${warning.reason}`,
            )
            .join("\n")
        : "No warnings recorded.",
    );
  });

  bot.command("settings", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    await ctx.reply(
      `GROUP SETTINGS\nProtection: ${group.enabled ? "ON" : "OFF"}\nAnti-link: ${group.antiLink ? "ON" : "OFF"}\nAnti-spam: ${group.antiSpam ? "ON" : "OFF"}\nWarn limit: ${group.warnLimit}\nMute default: ${group.muteDefaultSeconds}s`,
    );
  });

  bot.command("protection", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const value = args(ctx)[0]?.toLowerCase();
    if (value === "on" || value === "off") {
      group.enabled = value === "on";
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
    }
    await ctx.reply(`Protection is ${group.enabled ? "ON" : "OFF"}.`);
  });

  bot.command("antilink", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const value = args(ctx)[0]?.toLowerCase();
    if (value === "on" || value === "off") {
      group.antiLink = value === "on";
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
    }
    await ctx.reply(`Anti-link is ${group.antiLink ? "ON" : "OFF"}.`);
  });

  bot.command("logs", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const events = await listModeratorEvents(group.groupId, 15);
    await ctx.reply(
      events.length
        ? events
            .map(
              (event) =>
                `${new Date(event.timestamp).toLocaleString()} · ${event.action} · ${event.targetId ?? "group"} · ${event.success ? "ok" : "failed"}`,
            )
            .join("\n")
        : "No moderation events recorded.",
    );
  });
}

export const moderatorCommandScopes = [
  { command: "moderation", description: "Open group moderator commands" },
  { command: "mute", description: "Mute a replied-to member" },
  { command: "unmute", description: "Unmute a replied-to member" },
  { command: "warn", description: "Warn a replied-to member" },
  { command: "warns", description: "View warning records" },
  { command: "settings", description: "View group moderation settings" },
  { command: "protection", description: "Toggle group protection" },
  { command: "antilink", description: "Toggle anti-link" },
  { command: "logs", description: "View moderation logs" },
];
