import crypto from "node:crypto";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

const LOCK_TTL_SECONDS = 30;
const LOCK_REFRESH_MS = 10_000;
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export interface SessionLock {
  key: string;
  token: string;
  release(): Promise<void>;
}

async function acquireLock(
  workspaceId: string,
  sessionId: string,
  namespace: "lifecycle" | "operation",
): Promise<SessionLock | undefined> {
  const key = `workspace:${workspaceId}:session:${sessionId}:${namespace}-lock`;
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") return undefined;
  const timer = setInterval(() => {
    void redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        key,
        token,
        LOCK_TTL_SECONDS,
      )
      .catch(() => undefined);
  }, LOCK_REFRESH_MS);
  timer.unref?.();
  let released = false;
  return {
    key,
    token,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(timer);
      await redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        )
        .catch(() => undefined);
    },
  };
}

export function acquireSessionLock(
  workspaceId: string,
  sessionId: string,
): Promise<SessionLock | undefined> {
  return acquireLock(workspaceId, sessionId, "lifecycle");
}

export function acquireSessionOperationLock(
  workspaceId: string,
  sessionId: string,
): Promise<SessionLock | undefined> {
  return acquireLock(workspaceId, sessionId, "operation");
}

export async function closeSessionLockRedis(): Promise<void> {
  await redis.quit();
}
