import { access, constants, mkdir } from "node:fs/promises";
import { env, ownerTelegramIds } from "./config/env.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkStorage(path: string): Promise<CheckResult> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.R_OK | constants.W_OK);
    return {
      name: `storage:${path}`,
      ok: true,
      detail: "read/write available",
    };
  } catch (error) {
    return {
      name: `storage:${path}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkTelegram(): Promise<CheckResult> {
  if (!env.TELEGRAM_BOT_TOKEN)
    return {
      name: "telegram",
      ok: false,
      detail: "TELEGRAM_BOT_TOKEN is not configured",
    };
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
    );
    const body = (await response.json()) as {
      ok?: boolean;
      result?: { username?: string };
    };
    return body.ok
      ? {
          name: "telegram",
          ok: true,
          detail: `identity verified${body.result?.username ? ` as @${body.result.username}` : ""}`,
        }
      : { name: "telegram", ok: false, detail: "Telegram rejected the token" };
  } catch (error) {
    return {
      name: "telegram",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      retryStrategy: () => null,
    });
    await redis.connect();
    const pong = await redis.ping();
    await redis.quit();
    return { name: "redis", ok: pong === "PONG", detail: pong };
  } catch (error) {
    return {
      name: "redis",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkMongo(): Promise<CheckResult> {
  const { default: mongoose } = await import("mongoose");
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
    await mongoose.connection.db?.command({ ping: 1 });
    await mongoose.disconnect();
    return { name: "mongodb", ok: true, detail: "ping succeeded" };
  } catch (error) {
    await mongoose.disconnect().catch(() => undefined);
    return {
      name: "mongodb",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      detail: process.version,
    },
    {
      name: "owner-ids",
      ok: ownerTelegramIds.size > 0,
      detail: `${ownerTelegramIds.size} configured`,
    },
    {
      name: "encryption",
      ok: env.NODE_ENV !== "production" || Boolean(env.ENCRYPTION_SECRET),
      detail: env.ENCRYPTION_SECRET ? "configured" : "missing in production",
    },
    await checkStorage(env.SESSION_ROOT),
    await checkStorage(env.MEDIA_ROOT),
    await checkTelegram(),
    await checkRedis(),
    await checkMongo(),
  ];
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runDoctor();
  for (const result of results)
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`,
    );
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
