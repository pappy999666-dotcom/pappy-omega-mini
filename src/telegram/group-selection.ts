export interface StableSelectionEntry<T extends object> {
  expiresAt: number;
  value: T;
}

/**
 * Message-button selection store. Tokens are deliberately short for Telegram's
 * callback-data budget and resolve to the exact record captured when the list
 * was rendered. An expired token is invalid rather than being re-indexed into
 * a potentially different group.
 */
export class StableSelectionStore<T extends object> {
  private sequence = 1;
  private readonly entries = new Map<string, StableSelectionEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  issue(namespace: string, value: T, now = Date.now()): string {
    let token = "";
    do {
      token = (this.sequence++).toString(10);
    } while (this.entries.has(`${namespace}:${token}`));
    this.entries.set(`${namespace}:${token}`, {
      expiresAt: now + this.ttlMs,
      value: { ...value },
    });
    return token;
  }

  resolve(namespace: string, token: string, now = Date.now()): T | undefined {
    const key = `${namespace}:${token}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...entry.value };
  }

  size(): number {
    return this.entries.size;
  }
}

const COMPACT_GROUP_PREFIX = "g";

function encodeGroupSessionId(sessionId: string): string {
  const uuid = sessionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (uuid) return `u${Buffer.from(sessionId.replaceAll("-", ""), "hex").toString("base64url")}`;
  return `s${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

function decodeGroupSessionId(token: string): string | undefined {
  try {
    if (token.startsWith("u")) {
      const hex = Buffer.from(token.slice(1), "base64url").toString("hex");
      if (hex.length !== 32) return undefined;
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    if (token.startsWith("s")) return Buffer.from(token.slice(1), "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Telegram permits at most 64 bytes of callback data. A UUID-based legacy
 * Group route can exceed that budget, particularly for moderation and picture
 * actions. Compact only Group routes; all other callback routes stay unchanged.
 */
export function compactGroupCallbackData(callbackData: string): string {
  const match = callbackData.match(/^session:([^:]+):group:(.+)$/);
  if (!match?.[1] || !match[2]) return callbackData;
  if (Buffer.byteLength(callbackData, "utf8") <= 64) return callbackData;
  return `${COMPACT_GROUP_PREFIX}:${encodeGroupSessionId(match[1])}:${match[2]}`;
}

/**
 * Expand a compact Group callback before Telegraf route matching. The existing
 * handlers therefore retain their authorization, stale-selection, and
 * confirmation logic while Telegram receives the shorter representation.
 */
export function expandGroupCallbackData(callbackData: string): string | undefined {
  const match = callbackData.match(/^g:([^:]+):(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  const sessionId = decodeGroupSessionId(match[1]);
  return sessionId ? `session:${sessionId}:group:${match[2]}` : undefined;
}

export function isCompactGroupCallbackData(callbackData: string): boolean {
  return callbackData.startsWith(`${COMPACT_GROUP_PREFIX}:`);
}

export function compactGroupCallbackByteLength(callbackData: string): number {
  return Buffer.byteLength(compactGroupCallbackData(callbackData), "utf8");
}
