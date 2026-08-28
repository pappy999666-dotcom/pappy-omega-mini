import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config/env.js";

export interface PooledRedis extends Redis {
  __pool_refCount: number;
  __pool_inUse: boolean;
}

interface PoolOptions {
  maxConnections?: number;
  minConnections?: number;
  acquireTimeoutMs?: number;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_MIN_CONNECTIONS = 2;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;

export class RedisConnectionPool {
  private readonly connections: PooledRedis[] = [];
  private readonly available: PooledRedis[] = [];
  private readonly waiters: Array<(redis: PooledRedis) => void> = [];
  private readonly maxConnections: number;
  private readonly minConnections: number;
  private readonly acquireTimeoutMs: number;
  private readonly label: string;
  private shuttingDown = false;
  private warmupPromise: Promise<void> | undefined;

  constructor(label: string, options: PoolOptions = {}) {
    this.label = label;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.minConnections = options.minConnections ?? DEFAULT_MIN_CONNECTIONS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  }

  private createConnection(): PooledRedis {
    const options: RedisOptions = {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times: number) => {
        if (times > 10) return null;
        return Math.min(times * 200, 2_000);
      },
      reconnectOnError: (err: Error) => {
        const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"];
        return targetErrors.some((target) => err.message.includes(target));
      },
    };
    const redis = new Redis(env.REDIS_URL, options) as PooledRedis;
    redis.__pool_refCount = 0;
    redis.__pool_inUse = false;
    redis.on("error", (error) => {
      if (!this.shuttingDown) {
        console.warn(`[redis-pool:${this.label}] connection error:`, error.message);
      }
    });
    this.connections.push(redis);
    return redis;
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      for (let i = 0; i < this.minConnections; i++) {
        const conn = this.createConnection();
        this.available.push(conn);
      }
    })();
    return this.warmupPromise;
  }

  async acquire(): Promise<PooledRedis> {
    await this.warmup();
    if (this.shuttingDown) {
      throw new Error(`[redis-pool:${this.label}] pool is shutting down`);
    }
    const available = this.available.pop();
    if (available) {
      available.__pool_refCount++;
      available.__pool_inUse = true;
      return available;
    }
    if (this.connections.length < this.maxConnections) {
      const conn = this.createConnection();
      conn.__pool_refCount = 1;
      conn.__pool_inUse = true;
      return conn;
    }
    return new Promise<PooledRedis>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(resolveWithConn);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`[redis-pool:${this.label}] acquire timeout after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);
      const resolveWithConn = (redis: PooledRedis) => {
        clearTimeout(timer);
        resolve(redis);
      };
      this.waiters.push(resolveWithConn);
    });
  }

  release(redis: PooledRedis): void {
    if (this.shuttingDown) {
      this.destroyConnection(redis);
      return;
    }
    redis.__pool_refCount = Math.max(0, redis.__pool_refCount - 1);
    redis.__pool_inUse = false;
    const waiter = this.waiters.shift();
    if (waiter) {
      redis.__pool_refCount++;
      redis.__pool_inUse = true;
      waiter(redis);
      return;
    }
    this.available.push(redis);
  }

  private destroyConnection(redis: PooledRedis): void {
    const index = this.connections.indexOf(redis);
    if (index >= 0) this.connections.splice(index, 1);
    const availIndex = this.available.indexOf(redis);
    if (availIndex >= 0) this.available.splice(availIndex, 1);
    void redis.quit().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    for (const waiter of this.waiters) {
      const conn = this.available.shift() ?? this.connections[0];
      if (conn) waiter(conn);
    }
    this.waiters.length = 0;
    await Promise.allSettled(
      this.connections.map((conn) => conn.quit().catch(() => undefined)),
    );
    this.connections.length = 0;
    this.available.length = 0;
  }

  get stats(): { total: number; available: number; inUse: number; waiters: number } {
    return {
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.filter((c) => c.__pool_inUse).length,
      waiters: this.waiters.length,
    };
  }
}

const globalPools = new Map<string, RedisConnectionPool>();

export function getSharedRedisPool(label: string, options?: PoolOptions): RedisConnectionPool {
  let pool = globalPools.get(label);
  if (!pool) {
    pool = new RedisConnectionPool(label, options);
    globalPools.set(label, pool);
  }
  return pool;
}

export async function closeAllRedisPools(): Promise<void> {
  await Promise.allSettled([...globalPools.values()].map((pool) => pool.close()));
  globalPools.clear();
}

export async function withRedis<T>(
  label: string,
  fn: (redis: Redis) => Promise<T>,
  options?: PoolOptions,
): Promise<T> {
  const pool = getSharedRedisPool(label, options);
  const conn = await pool.acquire();
  try {
    return await fn(conn);
  } finally {
    pool.release(conn);
  }
}
