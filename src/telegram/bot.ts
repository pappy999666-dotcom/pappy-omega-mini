import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { env, ownerTelegramIds } from "../config/env.js";
import {
  resolveUser,
  listSessions,
  createSession,
  getSession,
} from "../core/session-registry.js";
import {
  getAdminMediaOverview,
  uploadWhatsappMenuMedia,
} from "../admin/media-actions.js";
import {
  adminKeyboard,
  dashboardKeyboard,
  dashboardText,
  featureText,
  helpText,
  mediaKeyboard,
  pageText,
  sessionKeyboard,
  sessionText,
  sessionsKeyboard,
  simpleBackKeyboard,
  ui,
} from "./ui.js";

const BOT_NAME = "pappy-omega-mini";
const pendingMedia = new Map<string, "image" | "video">();

export function createTelegramBot(): Telegraf<Context> {
  if (!env.TELEGRAM_BOT_TOKEN)
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const bot = new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const admin = isAdmin(ctx);
    resolveTelegramUser(ctx);
    await ctx.reply(dashboardText(admin), {
      parse_mode: "HTML",
      ...dashboardKeyboard(admin),
    });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText(), {
      parse_mode: "HTML",
      ...simpleBackKeyboard("home"),
    });
  });

  bot.command("pair", async (ctx) => {
    const user = resolveTelegramUser(ctx);
    const sessionName =
      ctx.message.text.split(/\s+/).slice(1).join(" ").trim() ||
      `session-${listSessions(user.workspaceId).length + 1}`;
    const session = createSession({
      workspaceId: user.workspaceId,
      sessionName,
    });
    await ctx.reply(
      pageText(
        "Pairing Request",
        `${ui.success} Session <b>${escapeHtml(session.sessionName)}</b> created.\n\nNext: provide a country-code phone number to continue the verified pairing flow.`,
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "Enter Phone Number",
              `pair:number:${session.sessionId}`,
            ),
          ],
          [Markup.button.callback(ui.back, "home")],
        ]),
      },
    );
  });

  bot.command("sessions", async (ctx) => {
    await sendSessions(ctx, 0);
  });

  bot.command("adminmedia", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await sendAdminMedia(ctx);
  });

  bot.on("photo", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "image")
      return ctx.reply("Open Admin Control → Media → Add Image first.");
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const file = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(file.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const user = resolveTelegramUser(ctx);
    const media = await uploadWhatsappMenuMedia({
      workspaceId: user.workspaceId,
      fileName: `whatsapp-menu-${photo.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      bytes,
    });
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      pageText(
        "Media Uploaded",
        `${ui.success} <code>${escapeHtml(media.fileName)}</code> is ready in the workspace media library.`,
      ),
      { parse_mode: "HTML", ...mediaKeyboard() },
    );
  });

  bot.on("video", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "video")
      return ctx.reply("Open Admin Control → Media → Add Video first.");
    const file = await ctx.telegram.getFileLink(ctx.message.video.file_id);
    const response = await fetch(file.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const user = resolveTelegramUser(ctx);
    const media = await uploadWhatsappMenuMedia({
      workspaceId: user.workspaceId,
      fileName: `whatsapp-menu-${ctx.message.video.file_unique_id}.mp4`,
      mimeType: ctx.message.video.mime_type ?? "video/mp4",
      bytes,
    });
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      pageText(
        "Media Uploaded",
        `${ui.success} <code>${escapeHtml(media.fileName)}</code> is ready in the workspace media library.`,
      ),
      { parse_mode: "HTML", ...mediaKeyboard() },
    );
  });

  bot.action("home", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(dashboardText(isAdmin(ctx)), {
      parse_mode: "HTML",
      ...dashboardKeyboard(isAdmin(ctx)),
    });
  });

  bot.action("ui:help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(helpText(), {
      parse_mode: "HTML",
      ...simpleBackKeyboard("home"),
    });
  });

  bot.action("ui:bridge", async (ctx) =>
    showFeature(
      ctx,
      "Bridge",
      "Select a session first, then execute a supported WhatsApp command inside its isolated workspace.",
    ),
  );
  bot.action("ui:validator", async (ctx) =>
    showFeature(
      ctx,
      "Validator Hub",
      "Main, Active, Dead, and Error buckets are designed for deduplicated collection, validation, exports, and live progress.",
    ),
  );
  bot.action("ui:join", async (ctx) =>
    showFeature(
      ctx,
      "Join Manager",
      "Start, pause, stop, refresh, and configure bounded link joining. Auto-join remains OFF by default.",
    ),
  );
  bot.action("ui:schedule", async (ctx) =>
    showFeature(
      ctx,
      "Scheduled Jobs",
      "Create timezone-aware jobs for owned sessions with bounded queue execution and cancellation.",
    ),
  );
  bot.action("ui:settings", async (ctx) =>
    showFeature(
      ctx,
      "Settings",
      "Configure workspace defaults, timezone, command presentation, and safe operation limits.",
    ),
  );
  bot.action("ui:support", async (ctx) =>
    showFeature(
      ctx,
      "Support",
      "Send a support message from this workspace. Admin notifications are handled separately.",
    ),
  );

  bot.action(/^sessions:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await sendSessions(ctx, Number(ctx.match[1]));
  });

  bot.action(/^session:view:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = resolveOwnedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await ctx.editMessageText(sessionText(session), {
      parse_mode: "HTML",
      ...sessionKeyboard(session, isAdmin(ctx)),
    });
  });

  bot.action(/^session:action:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = resolveOwnedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const action = ctx.match[2];
    if (action === "sudo" && !isAdmin(ctx)) return deny(ctx);
    await ctx.editMessageText(
      pageText(
        `${session.sessionName} · ${action}`,
        `The <code>${escapeHtml(action ?? "unknown")}</code> action is scoped to this session. Use the matching WhatsApp shortcut or continue the guided flow here.`,
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "↻ Session",
              `session:view:${session.sessionId}`,
            ),
          ],
          [Markup.button.callback("‹ Sessions", "sessions:page:0")],
        ]),
      },
    );
  });

  bot.action("pair:start", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      pageText(
        "Pair WhatsApp",
        "Choose a session name first. The next step will request a country-code phone number and then display the copy-ready pairing code.",
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("Use Guided Pairing", "pair:guided")],
          [Markup.button.callback(ui.back, "home")],
        ]),
      },
    );
  });

  bot.action("pair:guided", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      pageText(
        "Session Name",
        "Send a name such as <code>main</code>, <code>business</code>, or <code>support-1</code>.",
      ),
      { parse_mode: "HTML", ...simpleBackKeyboard("pair:start") },
    );
  });

  bot.action(/^pair:number:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = resolveOwnedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await ctx.editMessageText(
      pageText(
        "Phone Number",
        `Send the full WhatsApp number for <b>${escapeHtml(session.sessionName)}</b> in international format, for example <code>2348012345678</code>.`,
      ),
      {
        parse_mode: "HTML",
        ...simpleBackKeyboard(`session:view:${session.sessionId}`),
      },
    );
  });

  bot.action("admin:home", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await ctx.editMessageText(
      pageText(
        "Admin Control",
        "Owner-only control plane. Changes are audited and scoped according to the selected operation.",
      ),
      { parse_mode: "HTML", ...adminKeyboard() },
    );
  });

  bot.action("admin:media", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await sendAdminMedia(ctx);
  });

  bot.action(/^admin:media:add:(image|video)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const kind = ctx.match[1] as "image" | "video";
    pendingMedia.set(String(ctx.from?.id ?? ""), kind);
    await ctx.editMessageText(
      pageText(
        `Add ${kind}`,
        `Upload the next ${kind} file in this chat. The pending request will be consumed by the next matching upload.`,
      ),
      { parse_mode: "HTML", ...simpleBackKeyboard("admin:media") },
    );
  });

  for (const action of [
    "admin:forcejoin",
    "admin:users",
    "admin:bridge",
    "admin:jobs",
    "admin:bucket",
    "admin:broadcast",
    "admin:audit",
    "admin:safe",
  ]) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      if (!requireAdmin(ctx)) return;
      await ctx.editMessageText(
        pageText(
          "Admin Module",
          `The <code>${escapeHtml(action.replace("admin:", ""))}</code> module is owner-only and ready for its guided controls.`,
        ),
        { parse_mode: "HTML", ...simpleBackKeyboard("admin:home") },
      );
    });
  }

  bot.action("admin:media:select", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await ctx.editMessageText(
      pageText(
        "Select Menu Media",
        getAdminMediaOverview(resolveTelegramUser(ctx).workspaceId),
      ),
      { parse_mode: "HTML", ...simpleBackKeyboard("admin:media") },
    );
  });

  bot.catch((error, ctx) =>
    console.error(`[telegram] update ${ctx.updateType} failed`, error),
  );
  return bot;
}

async function sendSessions(ctx: Context, page: number): Promise<void> {
  const user = resolveTelegramUser(ctx);
  const sessions = listSessions(user.workspaceId);
  const body = sessions.length
    ? pageText(
        "Your Sessions",
        `Page ${page + 1}\n\nSelect a session to open its isolated control panel.`,
      )
    : pageText(
        "Your Sessions",
        "No sessions yet. Start a guided pairing flow to create one.",
      );
  if ("editMessageText" in ctx && ctx.callbackQuery)
    await ctx.editMessageText(body, {
      parse_mode: "HTML",
      ...sessionsKeyboard(sessions, page, 5, isAdmin(ctx)),
    });
  else
    await ctx.reply(body, {
      parse_mode: "HTML",
      ...sessionsKeyboard(sessions, page, 5, isAdmin(ctx)),
    });
}

async function sendAdminMedia(ctx: Context): Promise<void> {
  await ctx.reply(
    pageText(
      "Admin Media",
      getAdminMediaOverview(resolveTelegramUser(ctx).workspaceId),
    ),
    { parse_mode: "HTML", ...mediaKeyboard() },
  );
}

async function showFeature(
  ctx: Context,
  title: string,
  body: string,
): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.editMessageText(featureText(title, body), {
    parse_mode: "HTML",
    ...simpleBackKeyboard("home"),
  });
}

function resolveTelegramUser(ctx: Context) {
  if (!ctx.from) throw new Error("Telegram actor is required.");
  return resolveUser(
    String(ctx.from.id),
    ctx.from.first_name,
    ctx.from.username,
  );
}

function resolveOwnedSession(ctx: Context, sessionId: string) {
  try {
    return getSession(resolveTelegramUser(ctx).workspaceId, sessionId);
  } catch {
    return undefined;
  }
}

function isAdmin(ctx: Context): boolean {
  return Boolean(ctx.from && ownerTelegramIds.has(String(ctx.from.id)));
}

function requireAdmin(ctx: Context): boolean {
  if (isAdmin(ctx)) return true;
  void ctx.answerCbQuery("Not available for this account.", {
    show_alert: true,
  });
  return false;
}

function deny(ctx: Context): void {
  void ctx.answerCbQuery("This action is not available for your workspace.", {
    show_alert: true,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
