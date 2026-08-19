import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
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
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  PAIRING_CUSTOM_CODE: z.string().default("PAPPYBOT"),
  WHATSAPP_READY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(300_000)
    .default(90_000),
});

export const env = envSchema.parse(process.env);

export const ownerTelegramIds = new Set(
  env.OWNER_TELEGRAM_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

export function assertProductionSecrets(): void {
  if (env.NODE_ENV === "production" && !env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required in production.");
  }
  if (env.NODE_ENV === "production" && !env.ENCRYPTION_SECRET) {
    throw new Error(
      "ENCRYPTION_SECRET with at least 32 characters is required in production.",
    );
  }
}
