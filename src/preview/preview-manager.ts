import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export interface PreviewRecord {
  schemaVersion: 1;
  canonicalUrl: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  siteName?: string;
  fetchedAt: number;
  expiresAt: number;
  fallback: boolean;
}

export interface PreviewAdapter {
  fetch(
    url: string,
  ): Promise<
    Pick<PreviewRecord, "title" | "description" | "thumbnailUrl" | "siteName">
  >;
}

export class PreviewManager {
  private readonly failures = new Map<
    string,
    { count: number; blockedUntil: number }
  >();
  private readonly cacheTtlSeconds = 60 * 60 * 24;

  constructor(
    private readonly redis: Redis,
    private readonly adapter: PreviewAdapter,
  ) {}

  async resolve(url: string): Promise<PreviewRecord> {
    const canonicalUrl = canonicalize(url);
    const cacheKey = `pappy-omega-mini:preview:v1:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as PreviewRecord;
    const host = new URL(canonicalUrl).hostname;
    const circuit = this.failures.get(host);
    if (circuit && circuit.blockedUntil > Date.now())
      return this.fallback(canonicalUrl);
    try {
      const metadata = await this.adapter.fetch(canonicalUrl);
      const record: PreviewRecord = {
        schemaVersion: 1,
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
      schemaVersion: 1,
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
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}
