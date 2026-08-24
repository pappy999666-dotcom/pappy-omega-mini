/** Normalize text before sending it through Telegram’s UTF-8 API. */
export function telegramSafeText(value: unknown, maxLength = 4096): string {
  const normalized = Buffer.from(String(value ?? ""), "utf8").toString("utf8");
  return normalized.slice(0, Math.max(0, maxLength));
}
