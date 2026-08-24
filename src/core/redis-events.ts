import type { Redis } from "ioredis";

const lastReportedAt = new Map<string, number>();

export function attachRedisErrorHandler(
  client: Redis,
  label: string,
): Redis {
  client.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${label}:${message}`;
    const now = Date.now();
    const previous = lastReportedAt.get(key) ?? 0;
    if (now - previous < 5_000) return;
    lastReportedAt.set(key, now);
    console.error(`[pappy-omega-mini] ${label} Redis error: ${message}`);
  });
  return client;
}
