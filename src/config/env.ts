import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  OWNER_TELEGRAM_IDS: z.string().default(""),
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
}
