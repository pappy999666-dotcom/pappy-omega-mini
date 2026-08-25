/** Normalize text before sending it through Telegram’s UTF-8 API. */
export function telegramSafeText(value: unknown, maxLength = 4096): string {
  const raw = String(value ?? "");
  // Telegram requires valid UTF-8. Normalize malformed UTF-16 first, then
  // truncate by Unicode code point so a multi-byte character is never split at
  // the end of a button label or rendered message.
  const normalized = Array.from(raw)
    .map((character) => {
      if (character.length === 1) {
        const code = character.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) return "�";
      }
      return character;
    })
    .join("");
  return Array.from(normalized)
    .slice(0, Math.max(0, maxLength))
    .join("");
}
