import crypto from "node:crypto";
import { env } from "../config/env.js";
import { getSharedRedisPool, type PooledRedis } from "./redis-pool.js";

const LOCK_TTL_SECONDS = 30;
const LOCK_REFRESH_MS = 10_000;
const pool = getSharedRedisPool("session-lock", { maxConnections: 5, minConnections: 1 });

export interface SessionLock {
  key: string;
  token: string;
  ownerId: string;
  createdAt: number;
  release(): Promise<void>;
}

export interface SessionLockSnapshot {
  key: string;
  ownerId?: string;
  createdAt?: number;
  tokenPresent: boolean;
  expiresInSeconds?: number;
}

const processOwnerId = `${process.env.HOSTNAME ?? "control"}:${process.pid}`;

async function acquireLock(
  workspaceId: string,
  sessionId: string,
  namespace: "lifecycle" | "operation",
): Promise<SessionLock | undefined> {
  const key = `workspace:${workspaceId}:session:${sessionId}:${namespace}-lock`;
  const token = crypto.randomUUID();
  const createdAt = Date.now();
  const ownerId = processOwnerId;
  const lockValue = JSON.stringify({ token, ownerId, createdAt });
  const redis = await pool.acquire();
  try {
    const acquired = await redis.set(key, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
    if (acquired !== "OK") return undefined;
  } finally {
    pool.release(redis);
  }
  const timer = setInterval(() => {
    void withRedisLockRefresh(key, lockValue);
  }, LOCK_REFRESH_MS);
  timer.unref?.();
  let released = false;
  return {
    key,
    token,
    ownerId,
    createdAt,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(timer);
      await withRedisLockRelease(key, lockValue);
    },
  };
}

async function withRedisLockRefresh(key: string, lockValue: string): Promise<void> {
  const redis = await pool.acquire();
  try {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        key,
        lockValue,
        LOCK_TTL_SECONDS,
      )
      .catch(() => undefined);
  } finally {
    pool.release(redis);
  }
}

async function withRedisLockRelease(key: string, lockValue: string): Promise<void> {
  const redis = await pool.acquire();
  try {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        lockValue,
      )
      .catch(() => undefined);
  } finally {
    pool.release(redis);
  }
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

export async function getSessionLockSnapshot(
  workspaceId: string,
  sessionId: string,
  namespace: "lifecycle" | "operation",
): Promise<SessionLockSnapshot> {
  const key = `workspace:${workspaceId}:session:${sessionId}:${namespace}-lock`;
  const redis = await pool.acquire();
  let raw: string | null;
  let ttl: number;
  try {
    [raw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  } finally {
    pool.release(redis);
  }
  if (!raw) return { key, tokenPresent: false };
  try {
    const parsed = JSON.parse(raw) as { ownerId?: unknown; createdAt?: unknown };
    return {
      key,
      tokenPresent: true,
      ...(typeof parsed.ownerId === "string" ? { ownerId: parsed.ownerId } : {}),
      ...(typeof parsed.createdAt === "number" ? { createdAt: parsed.createdAt } : {}),
      ...(ttl >= 0 ? { expiresInSeconds: ttl } : {}),
    };
  } catch {
    return { key, tokenPresent: true, ...(ttl >= 0 ? { expiresInSeconds: ttl } : {}) };
  }
}

export async function closeSessionLockRedis(): Promise<void> {
  // Pool is shared, closed via closeAllRedisPools in index.ts shutdown
}
