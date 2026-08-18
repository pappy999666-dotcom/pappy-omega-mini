export interface TelegramTextExtra {
  parse_mode?: string;
  caption?: string;
  [key: string]: unknown;
}

export function normalizeTelegramNewlines(value: string): string {
  return String(value ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function renderTelegramBlockquote(
  value: string,
  expandable = false,
): string {
  const flattened = normalizeTelegramNewlines(value).replace(
    /<\/?blockquote(?:\s+expandable)?>/gu,
    "",
  );
  return `<blockquote${expandable ? " expandable" : ""}>${flattened || " "}</blockquote>`;
}

export function renderTelegramPlainText(value: string): string {
  return renderTelegramBlockquote(escapeHtml(normalizeTelegramNewlines(value)));
}

export function renderTelegramHtml(value: string): string {
  return renderTelegramBlockquote(value);
}

export function successResponse(title: string, detail = ""): string {
  return `<b>✅ ${escapeHtml(title)}</b>${detail ? `\n\n${detail}` : ""}`;
}

export function dangerResponse(title: string, detail = ""): string {
  return `<b>⛔ ${escapeHtml(title)}</b>${detail ? `\n\n${detail}` : ""}`;
}

export function warningResponse(title: string, detail = ""): string {
  return `<b>⚠️ ${escapeHtml(title)}</b>${detail ? `\n\n${detail}` : ""}`;
}

export function infoResponse(title: string, detail = ""): string {
  return `<b>◆ ${escapeHtml(title)}</b>${detail ? `\n\n${detail}` : ""}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
