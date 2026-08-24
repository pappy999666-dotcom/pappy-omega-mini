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
