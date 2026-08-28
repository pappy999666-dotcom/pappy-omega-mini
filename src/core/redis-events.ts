import type { Redis } from "ioredis";

const lastReportedAt = new Map<string, number>();
const DEDUPE_WINDOW_MS = 5_000;
const MAX_ERROR_KEYS = 100;

export function attachRedisErrorHandler(
  client: Redis,
  label: string,
): Redis {
  client.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${label}:${message}`;
    const now = Date.now();
    const previous = lastReportedAt.get(key) ?? 0;
    if (now - previous < DEDUPE_WINDOW_MS) return;
    lastReportedAt.set(key, now);
    if (lastReportedAt.size > MAX_ERROR_KEYS) {
      const oldest = lastReportedAt.keys().next().value;
      if (oldest) lastReportedAt.delete(oldest);
    }
    console.error(`[pappy-omega-mini] ${label} Redis error: ${message}`);
  });
  return client;
}

export function getRedisErrorLogStats(): { size: number } {
  return { size: lastReportedAt.size };
}
