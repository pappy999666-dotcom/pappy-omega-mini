const PHONE_JID_RE = /^(\d{7,15})@(s\.whatsapp\.net|c\.us)$/iu;
const DIGITS_RE = /^\d{7,15}$/;

export function phoneDigitsFromIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  const jidMatch = PHONE_JID_RE.exec(normalized);
  if (jidMatch?.[1]) return jidMatch[1];
  if (DIGITS_RE.test(normalized)) return normalized;
  if (/^\+?[0-9][0-9\s().-]{6,20}$/.test(normalized)) {
    const formattedDigits = normalized.replace(/\D/g, "");
    if (DIGITS_RE.test(formattedDigits)) return formattedDigits;
  }
  return undefined;
}

export function phoneJidFromIdentity(value: unknown): string | undefined {
  const digits = phoneDigitsFromIdentity(value);
  return digits ? `${digits}@s.whatsapp.net` : undefined;
}

export function isLidIdentity(value: unknown): boolean {
  return typeof value === "string" && /@(?:lid|hosted\.lid)$/iu.test(value.trim());
}

export function firstVerifiedPhone(...values: unknown[]): string | undefined {
  for (const value of values) {
    const digits = phoneDigitsFromIdentity(value);
    if (digits) return digits;
  }
  return undefined;
}

export function maskedPhoneLabel(digits: string | undefined, index?: number): string {
  const prefix = index === undefined ? "" : `#${index + 1} `;
  if (!digits) return `${prefix}Verified phone unavailable`;
  return `${prefix}+${digits.slice(0, 3)}•••${digits.slice(-4)}`;
}

export function verifiedMentionJids(values: unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => phoneJidFromIdentity(value)).filter((value): value is string => Boolean(value)))];
}

export function verifiedTargetPhone(args: string[] | undefined, mentions: unknown[] | undefined, quotedSender: unknown): string | undefined {
  const mentioned = verifiedMentionJids(mentions);
  if (mentioned.length) return phoneDigitsFromIdentity(mentioned[0]);
  const quoted = phoneDigitsFromIdentity(quotedSender);
  if (quoted) return quoted;
  for (const arg of args ?? []) {
    const digits = phoneDigitsFromIdentity(arg);
    if (digits) return digits;
  }
  return undefined;
}

/** Resolve exactly one target to a phone JID; LID-only values are intentionally rejected. */
export function verifiedTargetJid(args: string[] | undefined, mentions: unknown[] | undefined, quotedSender: unknown): string | undefined {
  return phoneJidFromIdentity(verifiedTargetPhone(args, mentions, quotedSender));
}

/** Collect explicit, mentioned, and quoted targets as deduplicated phone JIDs. */
export function verifiedTargetJids(args: string[] | undefined, mentions: unknown[] | undefined, quotedSender: unknown): string[] {
  const values = [
    ...(Array.isArray(mentions) ? mentions : []),
    ...(quotedSender ? [quotedSender] : []),
    ...(args ?? []),
  ];
  return [...new Set(values.map((value) => phoneJidFromIdentity(value)).filter((value): value is string => Boolean(value)))];
}
