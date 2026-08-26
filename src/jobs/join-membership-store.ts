import type { Redis } from "ioredis";

const PREFIX = "pappy-omega-mini:join-memberships:";

export class JoinMembershipStore {
  constructor(private readonly redis: Redis) {}

  private key(workspaceId: string, sessionId: string, kind: "groups" | "links" = "groups"): string {
    return `${PREFIX}${workspaceId}:${sessionId}:${kind}`;
  }

  async list(workspaceId: string, sessionId: string): Promise<Set<string>> {
    const values = await this.redis.smembers(this.key(workspaceId, sessionId, "groups"));
    return new Set(values);
  }

  async listLinks(workspaceId: string, sessionId: string): Promise<Set<string>> {
    const values = await this.redis.smembers(this.key(workspaceId, sessionId, "links"));
    return new Set(values);
  }

  async add(
    workspaceId: string,
    sessionId: string,
    groupJid: string | undefined,
    canonicalUrl: string,
  ): Promise<void> {
    const operations: Promise<unknown>[] = [this.redis.sadd(this.key(workspaceId, sessionId, "links"), canonicalUrl)];
    if (groupJid?.endsWith("@g.us")) operations.push(this.redis.sadd(this.key(workspaceId, sessionId, "groups"), groupJid));
    await Promise.all(operations);
  }
}
