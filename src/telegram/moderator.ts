import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Context, Telegraf } from "telegraf";
import { env } from "../config/env.js";
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
const protectionRedis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const LINK_PATTERN =
  /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|chat\.whatsapp\.com\/|wa\.me\/)/i;

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

export function installModeratorProtection(bot: Telegraf<Context>): void {
  bot.on("message", async (ctx, next) => {
    const id = groupId(ctx);
    if (!id) return next();
    const message = ctx.message as unknown as {
      text?: string;
      caption?: string;
      message_id?: number;
    };
    const text = message.text ?? message.caption ?? "";
    if (!text || text.startsWith("/")) return next();
    const group = await loadModeratorGroup(id).catch(() => undefined);
    if (!group?.enabled) return next();
    const sender = actorId(ctx);
    if (!sender) return next();
    try {
      const member = await ctx.telegram.getChatMember(
        Number(id),
        Number(sender),
      );
      if (
        ADMIN_STATUSES.has(member.status) ||
        group.whitelist.includes(sender) ||
        group.staff.includes(sender)
      )
        return next();
    } catch {
      return next();
    }
    if (group.antiLink && LINK_PATTERN.test(text)) {
      let success = true;
      try {
        await ctx.telegram.deleteMessage(Number(id), message.message_id ?? 0);
      } catch {
        success = false;
      }
      await recordEvent(ctx, {
        rule: "anti-link",
        action: "delete",
        targetId: sender,
        success,
        ...(success ? {} : { failureReason: "Telegram deleteMessage failed" }),
      });
      return;
    }
    if (group.antiSpam) {
      const key = `pappy:moderator:spam:${id}:${sender}`;
      const now = Date.now();
      await protectionRedis.zadd(
        key,
        now,
        `${now}:${message.message_id ?? randomUUID()}`,
      );
      await protectionRedis.zremrangebyscore(key, 0, now - 10_000);
      await protectionRedis.expire(key, 30);
      const count = await protectionRedis.zcard(key);
      if (count >= 5) {
        const muted = await restrict(
          ctx,
          sender,
          Math.floor(now / 1000) + group.muteDefaultSeconds,
        );
        await recordEvent(ctx, {
          rule: "anti-spam",
          action: "mute",
          targetId: sender,
          success: muted,
          ...(muted
            ? {}
            : { failureReason: "Telegram restrictChatMember failed" }),
        });
        try {
          await ctx.telegram.deleteMessage(Number(id), message.message_id ?? 0);
        } catch {
          /* best effort cleanup */
        }
        return;
      }
    }
    return next();
  });
}

export function installModeratorCommands(bot: Telegraf<Context>): void {
  bot.command("moderation", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
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

  const showWarnings = async (ctx: Context): Promise<void> => {
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
  };
  bot.command("warns", showWarnings);
  bot.command("warnlist", showWarnings);

  bot.command("warnlimit", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const value = Number(args(ctx)[0]);
    if (Number.isInteger(value) && value >= 1 && value <= 20) {
      group.warnLimit = value;
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, {
        rule: "warning",
        action: "set_limit",
        reason: String(value),
        success: true,
      });
    }
    await ctx.reply(`Warning limit: ${group.warnLimit}`);
  });

  bot.command("resetwarn", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    const target = targetId(ctx);
    if (!group || !target) {
      await ctx.reply(
        "Reply to a member or provide a numeric Telegram user ID.",
      );
      return;
    }
    await recordEvent(ctx, {
      rule: "warning",
      action: "reset",
      targetId: target,
      success: false,
      failureReason: "Warning deletion endpoint not yet enabled",
    });
    await ctx.reply(
      "Warning reset is recorded but requires the warning deletion migration before it can remove durable records.",
    );
  });

  bot.command("rules", async (ctx) => {
    const group = await ensureGroup(ctx);
    if (!group) return;
    await ctx.reply(group.rules ?? "No group rules have been configured.");
  });

  bot.command("setrules", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const text = args(ctx).join(" ").trim();
    if (!text) {
      await ctx.reply("Usage: /setrules your group rules");
      return;
    }
    group.rules = text.slice(0, 4000);
    group.updatedAt = Date.now();
    await saveModeratorGroup(group);
    await recordEvent(ctx, { rule: "rules", action: "update", success: true });
    await ctx.reply("✅ Group rules updated.");
  });

  bot.command("staff", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const values = args(ctx);
    const action = values[0]?.toLowerCase();
    const member = values[1]?.replace(/^@/, "");
    if (action === "add" && member)
      group.staff = [...new Set([...group.staff, member])];
    else if (action === "remove" && member)
      group.staff = group.staff.filter((id) => id !== member);
    if (action === "add" || action === "remove") {
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, {
        rule: "staff",
        action,
        ...(member ? { targetId: member } : {}),
        success: true,
      });
    }
    await ctx.reply(
      group.staff.length
        ? `Staff: ${group.staff.join(", ")}`
        : "No delegated staff configured.",
    );
  });

  bot.command("whitelist", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const values = args(ctx);
    const action = values[0]?.toLowerCase();
    const member = values[1]?.replace(/^@/, "");
    if (action === "add" && member)
      group.whitelist = [...new Set([...group.whitelist, member])];
    else if (action === "remove" && member)
      group.whitelist = group.whitelist.filter((id) => id !== member);
    if (action === "add" || action === "remove") {
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, {
        rule: "whitelist",
        action,
        ...(member ? { targetId: member } : {}),
        success: true,
      });
    }
    await ctx.reply(
      group.whitelist.length
        ? `Whitelist: ${group.whitelist.join(", ")}`
        : "Whitelist is empty.",
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
  { command: "warnlist", description: "List warning records" },
  { command: "resetwarn", description: "Reset member warnings" },
  { command: "warnlimit", description: "Set warning escalation limit" },
  { command: "settings", description: "View group moderation settings" },
  { command: "rules", description: "Show group rules" },
  { command: "setrules", description: "Update group rules" },
  { command: "staff", description: "Manage delegated staff" },
  { command: "whitelist", description: "Manage trusted users" },
  { command: "protection", description: "Toggle group protection" },
  { command: "antilink", description: "Toggle anti-link" },
  { command: "logs", description: "View moderation logs" },
];
