import type { SessionMenuModel } from "./menu-model.js";

export interface TelegramButton {
  text: string;
  callback_data: string;
}

export function renderTelegramSessionMenu(model: SessionMenuModel): {
  text: string;
  inline_keyboard: TelegramButton[][];
} {
  const rows: TelegramButton[][] = [];
  for (let i = 0; i < model.actions.length; i += 2) {
    const first = model.actions[i];
    const second = model.actions[i + 1];
    const row: TelegramButton[] = [];
    if (first)
      row.push({
        text: first.label,
        callback_data: `session:action:${first.command}`,
      });
    if (second)
      row.push({
        text: second.label,
        callback_data: `session:action:${second.command}`,
      });
    rows.push(row);
  }
  return {
    text: [
      `<b>${escapeHtml(model.title)}</b>`,
      escapeHtml(model.subtitle),
      "",
      `<code>${escapeHtml(model.statusLine)}</code>`,
      "",
      "<i>Select an action or use the matching WhatsApp shortcut.</i>",
    ].join("\n"),
    inline_keyboard: rows,
  };
}

export function renderWhatsappCommandReference(
  model: SessionMenuModel,
  prefix: string,
): string {
  return [
    "PAPPY OMEGA MINI",
    model.title,
    model.statusLine,
    "",
    ...model.actions.map(
      (action) =>
        `${prefix}${action.command.padEnd(10, " ")} — ${action.description}`,
    ),
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
