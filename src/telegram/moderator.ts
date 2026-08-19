import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Context, Telegraf } from "telegraf";
import { env } from "../config/env.js";
import { btn, keyboard, pageText, ui } from "./ui.js";
import { escapeHtml, infoResponse, successResponse, warningResponse } from "./renderer.js";
import {
  countModeratorWarnings,
  countModeratorWarningsForGroup,
  deleteModeratorWarnings,
  listDueModeratorGroups,
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
let protectionRedis: Redis | undefined;
let moderatorReconciliationTimer: ReturnType<typeof setInterval> | undefined;

type DestructiveConfirmation = {
  token: string;
  action: "ban" | "resetwarn" | "tagall";
  groupId: string;
  actorId: string;
  targetId: string;
  chatId: number;
  promptMessageId?: number;
  sourceMessageId?: number;
  expiresAt: number;
};
const destructiveConfirmations = new Map<string, DestructiveConfirmation>();
function getProtectionRedis(): Redis {
  return (protectionRedis ??= (() => {
    const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    client.on("error", () => undefined);
    return client;
  })());
}
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
    welcomeEnabled: false,
    goodbyeEnabled: false,
    filters: [],
    whitelist: [],
    staff: [],
    trustedUsers: [],
    raidEnabled: false,
    raidJoinThreshold: 8,
    raidWindowSeconds: 30,
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

async function reconcileModeratorExpiries(bot: Telegraf<Context>, now = Date.now()): Promise<void> {
  const groups = await listDueModeratorGroups(now).catch(() => []);
  for (const group of groups) {
    const muteExpired = group.groupMuteUntil !== undefined && group.groupMuteUntil <= now;
    const lockExpired = group.groupLockUntil !== undefined && group.groupLockUntil <= now;
    if (!muteExpired && !lockExpired) continue;
    const next = { ...group };
    if (muteExpired) delete next.groupMuteUntil;
    if (lockExpired) {
      delete next.groupLockUntil;
      delete next.groupLockReason;
    }
    const muteStillActive = next.groupMuteUntil !== undefined && next.groupMuteUntil > now;
    const lockStillActive = next.groupLockUntil !== undefined && next.groupLockUntil > now;
    let success = true;
    if (!muteStillActive && !lockStillActive) {
      try {
        await bot.telegram.setChatPermissions(Number(group.groupId), {
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
        });
      } catch {
        success = false;
      }
    }
    if (success) {
      next.updatedAt = now;
      await saveModeratorGroup(next);
    }
    await saveModeratorEvent({
      eventId: randomUUID(),
      groupId: group.groupId,
      actorId: "scheduler",
      rule: "expiry",
      action: muteExpired ? "group_mute_expired" : "group_lock_expired",
      success,
      ...(success ? {} : { failureReason: "Telegram setChatPermissions failed" }),
      timestamp: now,
    }).catch(() => undefined);
  }
}

export function startModeratorReconciliation(bot: Telegraf<Context>): void {
  if (moderatorReconciliationTimer) return;
  moderatorReconciliationTimer = setInterval(() => void reconcileModeratorExpiries(bot), 15_000);
  moderatorReconciliationTimer.unref?.();
  void reconcileModeratorExpiries(bot);
}

export function stopModeratorReconciliation(): void {
  if (moderatorReconciliationTimer) clearInterval(moderatorReconciliationTimer);
  moderatorReconciliationTimer = undefined;
}

export function installModeratorProtection(bot: Telegraf<Context>): void {
  bot.on("new_chat_members", async (ctx, next) => {
    const id = groupId(ctx);
    if (!id) return next();
    const group = await loadModeratorGroup(id).catch(() => undefined);
    if (!group?.raidEnabled) return next();
    const message = ctx.message as unknown as { message_id?: number; new_chat_members?: Array<{ id?: number; is_bot?: boolean }> };
    const joined = (message.new_chat_members ?? []).filter((member) => !member.is_bot && member.id !== undefined);
    if (!joined.length) return next();
    const now = Date.now();
    const redis = getProtectionRedis();
    const key = `pappy:moderator:raid:${id}`;
    for (const member of joined) await redis.zadd(key, now, `${now}:${member.id}:${randomUUID()}`);
    await redis.zremrangebyscore(key, 0, now - Math.max(10, group.raidWindowSeconds ?? 30) * 1000);
    await redis.expire(key, Math.max(30, (group.raidWindowSeconds ?? 30) * 2));
    const count = await redis.zcard(key);
    const threshold = Math.max(2, group.raidJoinThreshold ?? 8);
    if (count < threshold || (group.groupLockUntil !== undefined && group.groupLockUntil > now)) return next();
    const lockUntil = now + 60_000;
    let success = true;
    try {
      await ctx.telegram.setChatPermissions(Number(id), { can_send_messages: false });
      group.groupLockUntil = lockUntil;
      group.groupLockReason = `join flood: ${count} joins in ${group.raidWindowSeconds ?? 30}s`;
      group.updatedAt = now;
      await saveModeratorGroup(group);
    } catch {
      success = false;
    }
    await saveModeratorEvent({
      eventId: randomUUID(), groupId: id, actorId: "system", rule: "raid", action: "temporary_lockdown",
      success, ...(success ? {} : { failureReason: "Telegram setChatPermissions failed" }), timestamp: now,
    }).catch(() => undefined);
    return next();
  });

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
    if (!(group.knownMembers ?? []).includes(sender)) {
      group.knownMembers = [...(group.knownMembers ?? []), sender].slice(-500);
      group.updatedAt = Date.now();
      await saveModeratorGroup(group).catch(() => undefined);
    }
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
    const filter = group.filters.find((entry) =>
      text.toLowerCase().includes(entry.trigger.toLowerCase()),
    );
    if (filter) {
      await ctx.reply(filter.response);
      await recordEvent(ctx, {
        rule: "filter",
        action: "respond",
        targetId: sender,
        success: true,
      });
      return;
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
      const redis = getProtectionRedis();
      await redis.zadd(
        key,
        now,
        `${now}:${message.message_id ?? randomUUID()}`,
      );
      await redis.zremrangebyscore(key, 0, now - 10_000);
      await redis.expire(key, 30);
      const count = await redis.zcard(key);
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

async function moderatorDashboardText(group: ModeratorGroupRecord): Promise<string> {
  const [warnings, events] = await Promise.all([
    countModeratorWarningsForGroup(group.groupId).catch(() => 0),
    listModeratorEvents(group.groupId, 3).catch(() => []),
  ]);
  const recent = events.length
    ? events.map((event) => `${event.success ? "✅" : "⛔"} ${event.action}${event.targetId ? ` · ${event.targetId}` : ""}`).join("\n")
    : "No recent actions.";
  return pageText(
    "Group Moderator",
    infoResponse(
      "Control Room",
      `<b>Group:</b> ${escapeHtml(group.title ?? group.groupId)}\n` +
        `<b>Protection:</b> ${group.enabled ? "ON" : "OFF"} · <b>Anti-link:</b> ${group.antiLink ? "ON" : "OFF"} · <b>Anti-spam:</b> ${group.antiSpam ? "ON" : "OFF"}\n` +
        `<b>Welcome:</b> ${group.welcomeEnabled ? "ON" : "OFF"} · <b>Goodbye:</b> ${group.goodbyeEnabled ? "ON" : "OFF"}\n` +
        `<b>Warnings:</b> ${warnings} · <b>Filters:</b> ${group.filters.length} · <b>Staff:</b> ${group.staff.length} · <b>Whitelist:</b> ${group.whitelist.length}\n\n` +
        `<b>Recent activity</b>\n${escapeHtml(recent)}\n\n` +
        `<i>Reply to a member and use /mute, /unmute, /warn, /ban, or /unban for target actions.</i>`,
    ),
  );
}

function moderatorDashboardKeyboard(group: ModeratorGroupRecord) {
  return keyboard([
    [btn(`🛡 Protection: ${group.enabled ? "ON" : "OFF"}`, "mod:toggle:enabled", group.enabled ? "success" : "danger")],
    [
      btn(`🔗 Anti-link: ${group.antiLink ? "ON" : "OFF"}`, "mod:toggle:antiLink", group.antiLink ? "success" : "primary"),
      btn(`⚡ Anti-spam: ${group.antiSpam ? "ON" : "OFF"}`, "mod:toggle:antiSpam", group.antiSpam ? "success" : "primary"),
    ],
    [
      btn(`👋 Welcome: ${group.welcomeEnabled ? "ON" : "OFF"}`, "mod:toggle:welcome", group.welcomeEnabled ? "success" : "primary"),
      btn(`↩ Goodbye: ${group.goodbyeEnabled ? "ON" : "OFF"}`, "mod:toggle:goodbye", group.goodbyeEnabled ? "success" : "primary"),
    ],
    [btn("📜 Rules", "mod:view:rules"), btn("🧰 Filters", "mod:view:filters")],
    [btn("⚠ Warnings", "mod:view:warnings"), btn("🧾 Logs", "mod:view:logs")],
    [btn("🔄 Refresh", "mod:refresh")],
    [btn(ui.close, "menu:main")],
  ]);
}

async function editModeratorDashboard(ctx: Context, group: ModeratorGroupRecord): Promise<void> {
  const text = await moderatorDashboardText(group);
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: moderatorDashboardKeyboard(group),
  }).catch(async () => {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: moderatorDashboardKeyboard(group),
    }).catch(() => undefined);
  });
}

async function callbackModerator(ctx: Context): Promise<ModeratorGroupRecord | undefined> {
  if (!(await requireModerator(ctx))) return undefined;
  return ensureGroup(ctx);
}

export async function openModeratorDashboard(ctx: Context): Promise<void> {
  const group = await callbackModerator(ctx);
  if (!group) return;
  await ctx.answerCbQuery("Opening moderator controls…");
  await editModeratorDashboard(ctx, group);
}

function callbackMessageId(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : undefined;
}

function scheduleDelete(telegram: Context["telegram"], chatId: number, messageId: number | undefined, delayMs = 8_000): void {
  if (!messageId) return;
  setTimeout(() => {
    void telegram.deleteMessage(chatId, messageId).catch(() => undefined);
  }, delayMs);
}

function createDestructiveConfirmation(
  ctx: Context,
  action: DestructiveConfirmation["action"],
  targetId: string,
): DestructiveConfirmation | undefined {
  const group = groupId(ctx);
  const actor = actorId(ctx);
  const chatId = ctx.chat?.id;
  if (!group || !actor || !chatId) return undefined;
  const token = randomUUID();
  const sourceMessageId = commandMessage(ctx)?.message_id;
  const confirmation: DestructiveConfirmation = {
    token,
    action,
    groupId: group,
    actorId: actor,
    targetId,
    chatId,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    expiresAt: Date.now() + 60_000,
  };
  destructiveConfirmations.set(token, confirmation);
  return confirmation;
}

function consumeDestructiveConfirmation(
  ctx: Context,
  token: string,
): DestructiveConfirmation | undefined {
  const confirmation = destructiveConfirmations.get(token);
  if (!confirmation) return undefined;
  if (confirmation.expiresAt < Date.now()) {
    destructiveConfirmations.delete(token);
    return undefined;
  }
  if (
    confirmation.groupId !== groupId(ctx) ||
    confirmation.actorId !== actorId(ctx) ||
    confirmation.chatId !== ctx.chat?.id
  )
    return undefined;
  destructiveConfirmations.delete(token);
  return confirmation;
}

export function installModeratorCommands(bot: Telegraf<Context>): void {
  bot.command("moderation", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    if (!groupId(ctx)) {
      await ctx.reply("Open this command inside a Telegram group.");
      return;
    }
    const group = await ensureGroup(ctx);
    if (!group) return;
    await ctx.reply(await moderatorDashboardText(group), {
      parse_mode: "HTML",
      reply_markup: moderatorDashboardKeyboard(group),
    });
  });

  bot.action("mod:refresh", async (ctx) => {
    await ctx.answerCbQuery("Refreshing…");
    const group = await callbackModerator(ctx);
    if (group) await editModeratorDashboard(ctx, group);
  });

  bot.action(/^mod:toggle:(enabled|antiLink|antiSpam|welcome|goodbye)$/, async (ctx) => {
    const group = await callbackModerator(ctx);
    if (!group) return;
    const key = ctx.match[1] as "enabled" | "antiLink" | "antiSpam" | "welcome" | "goodbye";
    const field = key === "welcome" ? "welcomeEnabled" : key === "goodbye" ? "goodbyeEnabled" : key;
    group[field] = !group[field];
    group.updatedAt = Date.now();
    await saveModeratorGroup(group);
    await recordEvent(ctx, { rule: "settings", action: `toggle_${key}`, success: true });
    await ctx.answerCbQuery(`${key} ${group[field] ? "enabled" : "disabled"}`);
    await editModeratorDashboard(ctx, group);
  });

  bot.action("mod:view:rules", async (ctx) => {
    const group = await callbackModerator(ctx);
    if (!group) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText(pageText("Group Rules", infoResponse("Published Rules", group.rules ?? "No group rules have been configured.")), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "mod:refresh")]]),
    });
  });

  bot.action("mod:view:filters", async (ctx) => {
    const group = await callbackModerator(ctx);
    if (!group) return;
    await ctx.answerCbQuery();
    const body = group.filters.length
      ? group.filters.map((entry) => `<code>${escapeHtml(entry.trigger)}</code> → ${escapeHtml(entry.response)}`).join("\n")
      : "No keyword filters configured.";
    await ctx.editMessageText(pageText("Filters", infoResponse("Keyword Filters", body)), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "mod:refresh")]]),
    });
  });

  bot.action("mod:view:warnings", async (ctx) => {
    const group = await callbackModerator(ctx);
    if (!group) return;
    await ctx.answerCbQuery();
    const count = await countModeratorWarningsForGroup(group.groupId).catch(() => 0);
    await ctx.editMessageText(pageText("Warnings", infoResponse("Warning Overview", `<b>Total records:</b> ${count}\n\nUse /warns or /warnlist for member-specific records.`)), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "mod:refresh")]]),
    });
  });

  bot.action("mod:view:logs", async (ctx) => {
    const group = await callbackModerator(ctx);
    if (!group) return;
    await ctx.answerCbQuery();
    const events = await listModeratorEvents(group.groupId, 15);
    const body = events.length
      ? events.map((event) => `${event.success ? "✅" : "⛔"} ${escapeHtml(event.action)} · ${escapeHtml(event.targetId ?? "group")}`).join("\n")
      : "No moderation events recorded.";
    await ctx.editMessageText(pageText("Moderation Logs", infoResponse("Recent Actions", body)), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "mod:refresh")]]),
    });
  });

  bot.command("mute", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    const id = groupId(ctx);
    const target = targetId(ctx);
    const values = args(ctx);
    if (id && target === "all") {
      const duration = Math.max(
        30,
        Math.min(86_400, Number(values[1]) || group?.muteDefaultSeconds || 600),
      );
      let ok = true;
      try {
        await ctx.telegram.setChatPermissions(Number(id), {
          can_send_messages: false,
        });
      } catch {
        ok = false;
      }
      await recordEvent(ctx, {
        rule: "manual",
        action: "group_mute",
        reason: `${duration}s`,
        success: ok,
        ...(ok ? {} : { failureReason: "Telegram setChatPermissions failed" }),
      });
      await ctx.reply(
        ok
          ? `✅ Group muted for ${duration}s. Telegram will require an explicit /unmute all when the window ends.`
          : "⛔ Group mute failed; check my administrator permissions.",
      );
      return;
    }
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

  bot.command("tagall", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const observed = Array.from(new Set(group.knownMembers ?? []));
    if (!observed.length) {
      await ctx.reply("No observed members are available yet. The bot builds this bounded list from real group traffic.");
      return;
    }
    const confirmation = createDestructiveConfirmation(ctx, "tagall", "group");
    if (!confirmation) return;
    const prompt = await ctx.reply(
      pageText(
        "Confirm Tag-All",
        warningResponse(
          "Bounded Mention Job",
          `<b>Observed members:</b> ${observed.length}\n<b>Maximum sent:</b> 50\n<b>Excluded:</b> admins, staff, whitelist, trusted users, and bots\n\nThis uses only members observed by the bot and sends one bounded mention message.`,
        ),
      ),
      {
        parse_mode: "HTML",
        reply_markup: keyboard([
          [btn("📣 Confirm Tag-All", `mod:confirm:tagall:${confirmation.token}`, "danger")],
          [btn("Cancel", `mod:cancel:${confirmation.token}`)],
        ]),
      },
    );
    confirmation.promptMessageId = prompt.message_id;
    destructiveConfirmations.set(confirmation.token, confirmation);
    scheduleDelete(ctx.telegram, confirmation.chatId, confirmation.sourceMessageId, 12_000);
  });

  bot.command("ban", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const id = groupId(ctx);
    const target = targetId(ctx);
    if (!id || !target) {
      await ctx.reply("Reply to a member or provide a numeric Telegram user ID.");
      return;
    }
    const confirmation = createDestructiveConfirmation(ctx, "ban", target);
    if (!confirmation) return;
    const prompt = await ctx.reply(
      pageText(
        "Confirm Ban",
        warningResponse(
          "Destructive Action",
          `<b>Target:</b> <code>${escapeHtml(target)}</code>\\n\\nThis removes the member from the group. The action is recorded and cannot be undone with /unban unless you choose to restore access later.`,
        ),
      ),
      {
        parse_mode: "HTML",
        reply_markup: keyboard([
          [btn("⛔ Confirm Ban", `mod:confirm:ban:${confirmation.token}`, "danger")],
          [btn("Cancel", `mod:cancel:${confirmation.token}`)],
        ]),
      },
    );
    confirmation.promptMessageId = prompt.message_id;
    destructiveConfirmations.set(confirmation.token, confirmation);
    scheduleDelete(ctx.telegram, confirmation.chatId, confirmation.sourceMessageId, 12_000);
  });

  bot.action(/^mod:confirm:(ban|resetwarn|tagall):([a-f0-9-]+)$/, async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const token = ctx.match[2];
    if (!token) {
      await ctx.answerCbQuery("Invalid confirmation.", { show_alert: true });
      return;
    }
    const confirmation = consumeDestructiveConfirmation(ctx, token);
    if (!confirmation || confirmation.action !== ctx.match[1]) {
      await ctx.answerCbQuery("This confirmation expired or was already used.", { show_alert: true });
      return;
    }
    let ok = true;
    let detail = "";
    try {
      if (confirmation.action === "ban") {
        await ctx.telegram.banChatMember(Number(confirmation.groupId), Number(confirmation.targetId));
        detail = `Member ${confirmation.targetId} banned.`;
      } else if (confirmation.action === "resetwarn") {
        const deleted = await deleteModeratorWarnings(confirmation.groupId, confirmation.targetId);
        detail = `Cleared ${deleted} warning record(s) for ${confirmation.targetId}.`;
      } else {
        const group = await loadModeratorGroup(confirmation.groupId);
        const admins = await ctx.telegram.getChatAdministrators(Number(confirmation.groupId));
        const excluded = new Set([
          ...(group?.staff ?? []),
          ...(group?.whitelist ?? []),
          ...(group?.trustedUsers ?? []),
          ...admins.map((member) => String(member.user.id)),
        ]);
        const members = Array.from(new Set(group?.knownMembers ?? []))
          .filter((member) => !excluded.has(member))
          .slice(0, 50);
        if (!members.length) throw new Error("No eligible observed members are available for tag-all.");
        const mentions = members.map((member) => `<a href="tg://user?id=${encodeURIComponent(member)}">member</a>`).join(" ");
        await ctx.telegram.sendMessage(Number(confirmation.groupId), `📣 ${mentions}`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        detail = `Tagged ${members.length} eligible observed member(s).`;
      }
    } catch {
      ok = false;
      detail = confirmation.action === "ban" ? "Ban failed; check administrator permissions." : "Clear failed; try again later.";
    }
    await recordEvent(ctx, {
      rule: confirmation.action === "ban" ? "manual" : confirmation.action === "resetwarn" ? "warning" : "tagall",
      action: confirmation.action === "ban" ? "ban" : confirmation.action === "resetwarn" ? "reset" : "tagall",
      targetId: confirmation.targetId,
      success: ok,
      ...(ok ? {} : { failureReason: detail }),
    });
    await ctx.answerCbQuery(ok ? "Completed" : "Action failed", { show_alert: !ok });
    await ctx.editMessageText(
      pageText(ok ? "Completed" : "Action Failed", ok ? successResponse("Action Complete", detail) : warningResponse("No Change Applied", detail)),
      { parse_mode: "HTML", reply_markup: keyboard([[btn(ui.close, "menu:main")]]) },
    ).catch(() => undefined);
    scheduleDelete(ctx.telegram, confirmation.chatId, callbackMessageId(ctx), ok ? 8_000 : 12_000);
    scheduleDelete(ctx.telegram, confirmation.chatId, confirmation.sourceMessageId, 1_000);
  });

  bot.action(/^mod:cancel:([a-f0-9-]+)$/, async (ctx) => {
    const token = ctx.match[1];
    if (!token) {
      await ctx.answerCbQuery("Invalid confirmation.", { show_alert: true });
      return;
    }
    const confirmation = consumeDestructiveConfirmation(ctx, token);
    if (!confirmation) {
      await ctx.answerCbQuery("This confirmation expired or was already used.", { show_alert: true });
      return;
    }
    if (!(await requireModerator(ctx))) return;
    await ctx.answerCbQuery("Cancelled");
    await ctx.editMessageText(pageText("Cancelled", infoResponse("No Change Applied", "The destructive action was cancelled.")), { parse_mode: "HTML" }).catch(() => undefined);
    scheduleDelete(ctx.telegram, confirmation.chatId, callbackMessageId(ctx), 2_000);
    scheduleDelete(ctx.telegram, confirmation.chatId, confirmation.sourceMessageId, 1_000);
  });

  bot.command("unban", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const id = groupId(ctx);
    const target = targetId(ctx);
    if (!id || !target) {
      await ctx.reply(
        "Reply to a member or provide a numeric Telegram user ID.",
      );
      return;
    }
    let ok = true;
    try {
      await ctx.telegram.unbanChatMember(Number(id), Number(target), {
        only_if_banned: true,
      });
    } catch {
      ok = false;
    }
    await recordEvent(ctx, {
      rule: "manual",
      action: "unban",
      targetId: target,
      success: ok,
      ...(ok ? {} : { failureReason: "Telegram unbanChatMember failed" }),
    });
    await ctx.reply(
      ok
        ? `✅ Member ${target} unbanned.`
        : "⛔ Unban failed; check my administrator permissions.",
    );
  });

  bot.command("unmute", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const id = groupId(ctx);
    const target = targetId(ctx);
    if (id && target === "all") {
      let ok = true;
      try {
        await ctx.telegram.setChatPermissions(Number(id), {
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
        });
      } catch {
        ok = false;
      }
      await recordEvent(ctx, {
        rule: "manual",
        action: "group_unmute",
        success: ok,
        ...(ok ? {} : { failureReason: "Telegram setChatPermissions failed" }),
      });
      await ctx.reply(
        ok
          ? "✅ Group unmuted."
          : "⛔ Group unmute failed; check my administrator permissions.",
      );
      return;
    }
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
    const target = targetId(ctx);
    if (!groupId(ctx) || !target) {
      await ctx.reply("Reply to a member or provide a numeric Telegram user ID.");
      return;
    }
    const confirmation = createDestructiveConfirmation(ctx, "resetwarn", target);
    if (!confirmation) return;
    const prompt = await ctx.reply(
      pageText(
        "Clear Warnings",
        warningResponse("Confirm Clear", `<b>Target:</b> <code>${escapeHtml(target)}</code>\\n\\nThis permanently clears the stored warning records for this member.`),
      ),
      {
        parse_mode: "HTML",
        reply_markup: keyboard([
          [btn("🧹 Confirm Clear", `mod:confirm:resetwarn:${confirmation.token}`, "danger")],
          [btn("Cancel", `mod:cancel:${confirmation.token}`)],
        ]),
      },
    );
    confirmation.promptMessageId = prompt.message_id;
    destructiveConfirmations.set(confirmation.token, confirmation);
    scheduleDelete(ctx.telegram, confirmation.chatId, confirmation.sourceMessageId, 12_000);
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

  const updateGreeting = async (
    ctx: Context,
    kind: "welcome" | "goodbye",
  ): Promise<void> => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const values = args(ctx);
    const value = values[0]?.toLowerCase();
    const enabledKey = kind === "welcome" ? "welcomeEnabled" : "goodbyeEnabled";
    const textKey = kind === "welcome" ? "welcomeText" : "goodbyeText";
    if (value === "on" || value === "off") {
      group[enabledKey] = value === "on";
      const text = values.slice(1).join(" ").trim();
      if (text) group[textKey] = text.slice(0, 1000);
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, { rule: kind, action: value, success: true });
    }
    await ctx.reply(
      `${kind}: ${group[enabledKey] ? "ON" : "OFF"}${group[textKey] ? `\\nTemplate: ${group[textKey]}` : ""}`,
    );
  };
  bot.command("welcome", (ctx) => updateGreeting(ctx, "welcome"));
  bot.command("goodbye", (ctx) => updateGreeting(ctx, "goodbye"));

  bot.command("filter", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const group = await ensureGroup(ctx);
    if (!group) return;
    const values = args(ctx);
    const action = values[0]?.toLowerCase();
    const trigger = values[1]?.toLowerCase();
    if (action === "add" && trigger && values.length >= 3) {
      const response = values.slice(2).join(" ").slice(0, 1000);
      group.filters = [
        ...group.filters.filter((entry) => entry.trigger !== trigger),
        { trigger, response },
      ];
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, {
        rule: "filter",
        action: "add",
        targetId: trigger,
        success: true,
      });
    } else if (action === "remove" && trigger) {
      group.filters = group.filters.filter(
        (entry) => entry.trigger !== trigger,
      );
      group.updatedAt = Date.now();
      await saveModeratorGroup(group);
      await recordEvent(ctx, {
        rule: "filter",
        action: "remove",
        targetId: trigger,
        success: true,
      });
    }
    await ctx.reply(
      group.filters.length
        ? group.filters
            .map((entry) => `${entry.trigger} → ${entry.response}`)
            .join("\\n")
        : "No keyword filters configured.",
    );
  });

  bot.on("new_chat_members", async (ctx) => {
    const id = groupId(ctx);
    if (!id) return;
    const group = await loadModeratorGroup(id).catch(() => undefined);
    if (!group?.welcomeEnabled) return;
    const members =
      "new_chat_members" in ctx.message ? ctx.message.new_chat_members : [];
    const names = members
      .map((member) => `@${member.username ?? member.first_name}`)
      .join(", ");
    await ctx.reply(
      (group.welcomeText ?? "Welcome {members} to the group!").replace(
        "{members}",
        names,
      ),
    );
  });

  bot.on("left_chat_member", async (ctx) => {
    const id = groupId(ctx);
    if (!id) return;
    const group = await loadModeratorGroup(id).catch(() => undefined);
    if (!group?.goodbyeEnabled) return;
    const member =
      "left_chat_member" in ctx.message
        ? ctx.message.left_chat_member
        : undefined;
    const name = member
      ? `@${member.username ?? member.first_name}`
      : "A member";
    await ctx.reply(
      (group.goodbyeText ?? "Goodbye {member}.").replace("{member}", name),
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
  { command: "ban", description: "Ban a replied-to member" },
  { command: "unban", description: "Unban a member" },
  { command: "unmute", description: "Unmute a replied-to member" },
  { command: "warn", description: "Warn a replied-to member" },
  { command: "warns", description: "View warning records" },
  { command: "warnlist", description: "List warning records" },
  { command: "resetwarn", description: "Reset member warnings" },
  { command: "warnlimit", description: "Set warning escalation limit" },
  { command: "rules", description: "Show group rules" },
  { command: "staff", description: "Manage delegated staff" },
  { command: "whitelist", description: "Manage trusted users" },
];
