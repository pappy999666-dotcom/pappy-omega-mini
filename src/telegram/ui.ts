import { Markup } from "telegraf";
import type { WhatsAppSession } from "../types/domain.js";
import { buildSessionMenu } from "../menus/menu-model.js";
import { renderTelegramSessionMenu } from "../menus/renderers.js";

export const ui = {
  brand: "✦ PAPPY OMEGA MINI",
  divider: "━━━━━━━━━━━━━━━━━━━━",
  success: "✅",
  danger: "⛔",
  info: "◆",
  back: "‹ Back",
  close: "× Close",
};

type Button = ReturnType<typeof Markup.button.callback>;
type Keyboard = ReturnType<typeof Markup.inlineKeyboard>;

export function dashboardKeyboard(isAdmin: boolean): Keyboard {
  const rows: Button[][] = [
    [
      Markup.button.callback("▣ Help", "ui:help"),
      Markup.button.callback("⚡ Pair", "pair:start"),
    ],
    [
      Markup.button.callback("◈ Sessions", "sessions:page:0"),
      Markup.button.callback("↔ Bridge", "ui:bridge"),
    ],
    [
      Markup.button.callback("⌁ Validator Hub", "ui:validator"),
      Markup.button.callback("⇢ Join Manager", "ui:join"),
    ],
    [
      Markup.button.callback("◷ Scheduled Jobs", "ui:schedule"),
      Markup.button.callback("⚙ Settings", "ui:settings"),
    ],
    [Markup.button.callback("◌ Support", "ui:support")],
  ];
  if (isAdmin)
    rows.push([Markup.button.callback("♛ Admin Control", "admin:home")]);
  return Markup.inlineKeyboard(rows);
}

export function simpleBackKeyboard(target = "home"): Keyboard {
  return Markup.inlineKeyboard([[Markup.button.callback(ui.back, target)]]);
}

export function sessionsKeyboard(
  sessions: WhatsAppSession[],
  page: number,
  pageSize = 5,
  isAdmin = false,
): Keyboard {
  const start = page * pageSize;
  const current = sessions.slice(start, start + pageSize);
  const rows: Button[][] = current.map((session) => [
    Markup.button.callback(
      `${session.status === "ACTIVE" ? "●" : "○"} ${session.sessionName}`,
      `session:view:${session.sessionId}`,
    ),
  ]);
  const navigation: Button[] = [];
  if (page > 0)
    navigation.push(
      Markup.button.callback("‹ Previous", `sessions:page:${page - 1}`),
    );
  if (start + pageSize < sessions.length)
    navigation.push(
      Markup.button.callback("Next ›", `sessions:page:${page + 1}`),
    );
  if (navigation.length) rows.push(navigation);
  rows.push([Markup.button.callback("⚡ Pair New", "pair:start")]);
  if (isAdmin)
    rows.push([Markup.button.callback("♛ Admin Control", "admin:home")]);
  rows.push([Markup.button.callback(ui.back, "home")]);
  return Markup.inlineKeyboard(rows);
}

export function sessionKeyboard(
  session: WhatsAppSession,
  isOwner: boolean,
): Keyboard {
  const actions = buildSessionMenu(session, isOwner).actions;
  const rows: Button[][] = [];
  for (let i = 0; i < actions.length; i += 2) {
    rows.push(
      actions
        .slice(i, i + 2)
        .map((action) =>
          Markup.button.callback(
            action.label,
            `session:action:${session.sessionId}:${action.id}`,
          ),
        ),
    );
  }
  rows.push([
    Markup.button.callback("↻ Refresh", `session:view:${session.sessionId}`),
    Markup.button.callback("‹ Sessions", "sessions:page:0"),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function adminKeyboard(): Keyboard {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚙ Force Join", "admin:forcejoin"),
      Markup.button.callback("◉ Users", "admin:users"),
    ],
    [
      Markup.button.callback("▣ Media", "admin:media"),
      Markup.button.callback("↔ Global Bridge", "admin:bridge"),
    ],
    [
      Markup.button.callback("◷ Global Jobs", "admin:jobs"),
      Markup.button.callback("▤ Master Bucket", "admin:bucket"),
    ],
    [
      Markup.button.callback("▥ Broadcast", "admin:broadcast"),
      Markup.button.callback("▤ Audit Log", "admin:audit"),
    ],
    [Markup.button.callback("⚠ Emergency Mode", "admin:safe")],
    [Markup.button.callback(ui.back, "home")],
  ]);
}

export function mediaKeyboard(): Keyboard {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("＋ Add Image", "admin:media:add:image"),
      Markup.button.callback("＋ Add Video", "admin:media:add:video"),
    ],
    [
      Markup.button.callback(
        "▣ Select WhatsApp Menu Media",
        "admin:media:select",
      ),
    ],
    [Markup.button.callback(ui.back, "admin:home")],
  ]);
}

export function pageText(title: string, body: string): string {
  return `<b>${ui.brand}</b>\n${ui.divider}\n<b>${escapeHtml(title)}</b>\n\n${body}`;
}

export function dashboardText(isAdmin: boolean): string {
  const role = isAdmin ? "Owner control plane" : "Personal workspace";
  return pageText(
    "Command Center",
    `Your isolated workspace is ready.\n\n<b>Mode:</b> ${role}\n<b>Transport:</b> Telegram + WhatsApp\n<b>Security:</b> workspace-scoped`,
  );
}

export function sessionText(session: WhatsAppSession): string {
  const model = buildSessionMenu(session, false);
  const rendered = renderTelegramSessionMenu(model);
  return pageText(
    "Session Overview",
    rendered.text.replace(/<b>.*?<\/b>\n?/s, "").trim(),
  );
}

export function helpText(): string {
  return pageText(
    "Help & Shortcuts",
    "<b>Pairing</b> — Pair one or more WhatsApp sessions from Telegram.\n<b>Session</b> — Open an isolated session control panel.\n<b>WhatsApp</b> — Use .menu, .ping, .autojoin on/off, .pfp, .setgpp, .groups, .health, .setname, .setbio, .setsudo, and .setprefix.\n<b>Safety</b> — Long operations are designed for bounded queues and recoverable execution.",
  );
}

export function featureText(title: string, body: string): string {
  return pageText(title, body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
