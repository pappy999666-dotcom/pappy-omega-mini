import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  PROCESS_ROLE: z.enum(["full", "worker"]).default("full"),
  WORKER_SESSIONS: z.string().default(""),
  EXCLUDED_SESSIONS: z.string().default(""),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(8),
  OWNER_TELEGRAM_IDS: z.string().default(""),
  ENCRYPTION_SECRET: z.string().min(32).optional(),
  OPTIONAL_DOMAIN: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017/pappy_omega_mini"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_TIMEZONE: z.string().default("Africa/Lagos"),
  SESSION_ROOT: z.string().default("./storage/sessions"),
  MEDIA_ROOT: z.string().default("./data/media"),
  MAX_MEDIA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().max(32).default(16),
  VALIDATOR_CONCURRENCY: z.coerce.number().int().positive().max(32).default(16),
  BROADCAST_CONCURRENCY: z.coerce.number().int().positive().max(16).default(8),
  PAIRING_CUSTOM_CODE: z.string().default("PAPPYBOT"),
  PAIRING_REQUEST_TTL_MS: z.coerce
    .number()
    .int()
    .min(5 * 60 * 1000)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(30 * 60 * 1000),
  WHATSAPP_READY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(300_000)
    .default(90_000),
  WORKLOAD_CONTROL_ENABLED: z.coerce.boolean().default(false),
  WORKLOAD_CONTROL_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  WORKLOAD_CONTROL_BIND: z.string().default("127.0.0.1"),
  WORKLOAD_CONTROL_PORT: z.coerce.number().int().positive().max(65535).default(8787),
  WORKLOAD_PACKAGE_VERSION: z.string().default("1.2.36"),
  WORKLOAD_MIN_WORKER_VERSION: z.string().default("1.0.0"),
  WORKLOAD_RELEASE_PATH: z.string().default("./worker-package/index.js"),
  WORKLOAD_RELEASE_PRIVATE_KEY_PATH: z.string().default("./.secrets/worker-release-private.pem"),
  WORKLOAD_RELEASE_VERSION: z.string().default("1.2.36"),
  WORKLOAD_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(10 * 60_000).default(75_000),
});

export const env = envSchema.parse(process.env);

export const workerSessionIds = new Set(
  env.WORKER_SESSIONS.split(",").map((value) => value.trim()).filter(Boolean),
);

export const excludedSessionIds = new Set(
  env.EXCLUDED_SESSIONS.split(",").map((value) => value.trim()).filter(Boolean),
);

export const isWorkerProcess = env.PROCESS_ROLE === "worker";

export const ownerTelegramIds = new Set(
  env.OWNER_TELEGRAM_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

export function assertProductionSecrets(): void {
  if (env.NODE_ENV === "production" && !env.TELEGRAM_BOT_TOKEN && !isWorkerProcess) {
    throw new Error("TELEGRAM_BOT_TOKEN is required in production.");
  }
  if (env.NODE_ENV === "production" && !env.ENCRYPTION_SECRET) {
    throw new Error(
      "ENCRYPTION_SECRET with at least 32 characters is required in production.",
    );
  }
}
