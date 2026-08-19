import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export interface PreviewRecord {
  schemaVersion: 2;
  canonicalUrl: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  thumbnailData?: string;
  siteName?: string;
  fetchedAt: number;
  expiresAt: number;
  fallback: boolean;
}

export interface PreviewAdapter {
  fetch(
    url: string,
  ): Promise<
    Pick<
      PreviewRecord,
      "title" | "description" | "thumbnailUrl" | "thumbnailData" | "siteName"
    >
  >;
}

export class PreviewManager {
  private readonly failures = new Map<
    string,
    { count: number; blockedUntil: number }
  >();
  private readonly cacheTtlSeconds = 60 * 60 * 24;
  private readonly fetchTimeoutMs = 8_000;

  constructor(
    private readonly redis: Redis,
    private readonly adapter: PreviewAdapter,
  ) {}

  async resolve(url: string): Promise<PreviewRecord> {
    const canonicalUrl = canonicalize(url);
    assertSafePreviewUrl(canonicalUrl);
    const cacheKey = `pappy-omega-mini:preview:v2:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as PreviewRecord;
    const host = new URL(canonicalUrl).hostname;
    const circuit = this.failures.get(host);
    if (circuit && circuit.blockedUntil > Date.now())
      return this.fallback(canonicalUrl);
    try {
      const metadata = await withTimeout(
        this.adapter.fetch(canonicalUrl),
        this.fetchTimeoutMs,
      );
      const record: PreviewRecord = {
        schemaVersion: 2,
        canonicalUrl,
        ...metadata,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + this.cacheTtlSeconds * 1000,
        fallback: false,
      };
      await this.redis.set(
        cacheKey,
        JSON.stringify(record),
        "EX",
        this.cacheTtlSeconds,
      );
      this.failures.delete(host);
      return record;
    } catch {
      this.registerFailure(host);
      return this.fallback(canonicalUrl);
    }
  }

  private fallback(canonicalUrl: string): PreviewRecord {
    return {
      schemaVersion: 2,
      canonicalUrl,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      fallback: true,
    };
  }

  private registerFailure(host: string): void {
    const current = this.failures.get(host) ?? { count: 0, blockedUntil: 0 };
    const count = current.count + 1;
    const cooldown = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(count, 9));
    this.failures.set(host, { count, blockedUntil: Date.now() + cooldown });
  }
}

export function canonicalize(url: string): string {
  const parsed = new URL(url.trim());
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Preview URLs must use HTTP or HTTPS.");
  if (parsed.username || parsed.password)
    throw new Error("Preview URLs cannot contain credentials.");
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

export function assertSafePreviewUrl(url: string): void {
  const hostname = new URL(url).hostname.toLowerCase();
  const blockedNames = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "169.254.169.254",
    "::1",
  ]);
  if (blockedNames.has(hostname) || hostname.endsWith(".localhost"))
    throw new Error("Preview host is not allowed.");
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return;
  const [a = -1, b = -1] = ipv4.slice(1).map(Number);
  if (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
    throw new Error("Preview host is not allowed.");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Preview fetch timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
