import type { Redis } from "ioredis";

const PREFIX = "pappy-omega-mini:join-memberships:";

export class JoinMembershipStore {
  constructor(private readonly redis: Redis) {}

  private key(workspaceId: string, sessionId: string): string {
    return `${PREFIX}${workspaceId}:${sessionId}`;
  }

  async list(workspaceId: string, sessionId: string): Promise<Set<string>> {
    const values = await this.redis.smembers(this.key(workspaceId, sessionId));
    return new Set(values);
  }

  async add(workspaceId: string, sessionId: string, groupJid: string): Promise<void> {
    if (groupJid.endsWith("@g.us")) await this.redis.sadd(this.key(workspaceId, sessionId), groupJid);
  }
}
