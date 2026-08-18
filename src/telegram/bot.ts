import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { env, ownerTelegramIds } from "../config/env.js";
import {
  resolveUser,
  listSessions,
  createSession,
  getSession,
} from "../core/session-registry.js";
import { buildSessionMenu } from "../menus/menu-model.js";
import { renderTelegramSessionMenu } from "../menus/renderers.js";
import {
  getAdminMediaOverview,
  uploadWhatsappMenuMedia,
  selectWhatsappMenuMedia,
} from "../admin/media-actions.js";

const BOT_NAME = "pappy-omega-mini";
const pendingMedia = new Map<string, "image" | "video">();

export function createTelegramBot(): Telegraf<Context> {
  if (!env.TELEGRAM_BOT_TOKEN)
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const bot = new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const user = resolveUser(
      String(ctx.from.id),
      ctx.from.first_name,
      ctx.from.username,
    );
    await ctx.reply(
      [
        `✦ <b>${BOT_NAME}</b>`,
        "",
        "A polished Telegram + WhatsApp command center.",
        `Workspace: <code>${user.workspaceId.slice(0, 8)}</code>`,
        "",
        "Pair a session, then manage it from Telegram or WhatsApp with the same simple shortcuts.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("Pair WhatsApp", "pair:start"),
            Markup.button.callback("Sessions", "sessions:list"),
          ],
          [
            Markup.button.callback("Admin Media", "admin:media"),
            Markup.button.callback("Help", "help"),
          ],
        ]),
      },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "<b>PAPPY OMEGA MINI</b>\n\nUse /pair to create a session, /sessions to manage sessions, and /adminmedia to manage WhatsApp menu media.",
      { parse_mode: "HTML" },
    );
  });

  bot.command("pair", async (ctx) => {
    const telegramUserId = String(ctx.from.id);
    const user = resolveUser(
      telegramUserId,
      ctx.from.first_name,
      ctx.from.username,
    );
    const sessionName =
      ctx.message.text.split(/\s+/).slice(1).join(" ").trim() ||
      `session-${listSessions(user.workspaceId).length + 1}`;
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName,
    });
    await ctx.reply(
      `Pairing workspace session <b>${escapeHtml(session.sessionName)}</b> is queued.\n\nThe transport adapter will provide the verified pairing-code flow next.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("sessions", async (ctx) => {
    const user = resolveUser(
      String(ctx.from.id),
      ctx.from.first_name,
      ctx.from.username,
    );
    const sessions = listSessions(user.workspaceId);
    if (!sessions.length) {
      await ctx.reply("No sessions yet. Use /pair <session name> to begin.");
      return;
    }
    for (const session of sessions) {
      const model = buildSessionMenu(
        session,
        ownerTelegramIds.has(String(ctx.from.id)),
      );
      const rendered = renderTelegramSessionMenu(model);
      await ctx.reply(rendered.text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(
          rendered.inline_keyboard.map((row) =>
            row.map((button) =>
              Markup.button.callback(button.text, button.callback_data),
            ),
          ),
        ),
      });
    }
  });

  bot.on("photo", async (ctx) => {
    if (!isOwner(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "image")
      return ctx.reply(
        "Open Admin Media → Add Image first, then upload the image.",
      );
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const file = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(file.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const user = resolveUser(
      String(ctx.from.id),
      ctx.from.first_name,
      ctx.from.username,
    );
    const media = await uploadWhatsappMenuMedia({
      workspaceId: user.workspaceId,
      fileName: `whatsapp-menu-${photo.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      bytes,
    });
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      `${media.fileName} uploaded. Use /adminmedia to review it, then select it from the media library.`,
    );
  });

  bot.on("video", async (ctx) => {
    if (!isOwner(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "video")
      return ctx.reply(
        "Open Admin Media → Add Video first, then upload the video.",
      );
    const file = await ctx.telegram.getFileLink(ctx.message.video.file_id);
    const response = await fetch(file.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const user = resolveUser(
      String(ctx.from.id),
      ctx.from.first_name,
      ctx.from.username,
    );
    const media = await uploadWhatsappMenuMedia({
      workspaceId: user.workspaceId,
      fileName: `whatsapp-menu-${ctx.message.video.file_unique_id}.mp4`,
      mimeType: ctx.message.video.mime_type ?? "video/mp4",
      bytes,
    });
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      `${media.fileName} uploaded. Use /adminmedia to review it, then select it from the media library.`,
    );
  });

  bot.command("adminmedia", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("Owner access required.");
    const user = resolveUser(
      String(ctx.from.id),
      ctx.from.first_name,
      ctx.from.username,
    );
    await ctx.reply(getAdminMediaOverview(user.workspaceId));
  });

  bot.action("sessions:list", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveUser(
      String(ctx.from?.id ?? ""),
      ctx.from?.first_name,
      ctx.from?.username,
    );
    const sessions = listSessions(user.workspaceId);
    await ctx.editMessageText(
      sessions.length
        ? sessions
            .map((session) => `${session.sessionName} · ${session.status}`)
            .join("\n")
        : "No sessions yet. Use Pair WhatsApp.",
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("Pair WhatsApp", "pair:start")],
          [Markup.button.callback("Back", "home")],
        ]),
      },
    );
  });

  bot.action(/^admin:media:add:(image|video)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx)) return ctx.editMessageText("Owner access required.");
    const kind = String(ctx.match[1]) as "image" | "video";
    pendingMedia.set(String(ctx.from?.id ?? ""), kind);
    await ctx.reply(
      `Upload the ${kind} you want to use for the WhatsApp menu. This request expires when the next matching upload is received.`,
    );
  });

  bot.action("admin:media", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx)) return ctx.editMessageText("Owner access required.");
    const user = resolveUser(
      String(ctx.from?.id ?? ""),
      ctx.from?.first_name,
      ctx.from?.username,
    );
    await ctx.editMessageText(
      getAdminMediaOverview(user.workspaceId),
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Add Image", "admin:media:add:image"),
          Markup.button.callback("Add Video", "admin:media:add:video"),
        ],
        [Markup.button.callback("Back", "home")],
      ]),
    );
  });

  bot.action(/^session:action:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `Action <code>${escapeHtml(String(ctx.match[1]))}</code> selected. Use the same command shortcut on WhatsApp.`,
      { parse_mode: "HTML" },
    );
  });

  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "<b>Shared controls</b>\n\nTelegram buttons and WhatsApp shortcuts operate on the same isolated workspace session. Examples: .menu, .autojoin on, .pfp, .setgpp, .groups, .health.",
      { parse_mode: "HTML" },
    );
  });

  bot.catch((error, ctx) => {
    console.error(`[telegram] update ${ctx.updateType} failed`, error);
  });
  return bot;
}

function isOwner(ctx: Context): boolean {
  return Boolean(ctx.from && ownerTelegramIds.has(String(ctx.from.id)));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
