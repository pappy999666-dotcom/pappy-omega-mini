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
  /** Dedicated HMAC secret for internal Redis bridge messages. */
  BRIDGE_HMAC_SECRET: z.string().min(32).optional(),
  /** Dedicated token for loopback recovery and diagnostics. */
  INTERNAL_CONTROL_TOKEN: z.string().min(32).optional(),
  SESSION_RECOVERY_TOKEN: z.string().min(32).optional(),
  PANEL_DEBUG_TOKEN: z.string().min(32).optional(),
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
  NOELIA_MUSIC_API_BASE: z.string().url().default("https://noelia.noeldfa.dpdns.org/api/music"),
  NOELIA_MUSIC_API_KEY: z.string().min(1).optional(),
  MAX_MEDIA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().max(32).default(16),
  VALIDATOR_CONCURRENCY: z.coerce.number().int().positive().max(32).default(16),
  VALIDATOR_DURABLE_DUAL_WRITE: z.coerce.boolean().default(false),
  BROADCAST_CONCURRENCY: z.coerce.number().int().positive().max(64).default(16),
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
  WORKLOAD_PACKAGE_VERSION: z.string().default("1.2.97"),
  WORKLOAD_MIN_WORKER_VERSION: z.string().default("1.0.0"),
  WORKLOAD_RELEASE_PATH: z.string().default("./worker-package/index.js"),
  WORKLOAD_RELEASE_PRIVATE_KEY_PATH: z.string().default("./.secrets/worker-release-private.pem"),
  WORKLOAD_RELEASE_VERSION: z.string().default("1.2.97"),
  WORKLOAD_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(10 * 60_000).default(75_000),
  /** Max concurrent WhatsApp session reconnects to prevent storms */
  MAX_CONCURRENT_RECONNECTS: z.coerce.number().int().positive().max(10).default(3),
  /** Batch flush interval for MongoDB trace writes (ms) */
  MONGO_BATCH_FLUSH_MS: z.coerce.number().int().positive().max(5_000).default(500),
  /** Max batch size for MongoDB trace writes */
  MONGO_BATCH_MAX_SIZE: z.coerce.number().int().positive().max(500).default(100),
  /** Circuit breaker failure threshold before opening */
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().max(20).default(5),
  /** Circuit breaker reset timeout (ms) */
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  /** Max entries in inbound dedupe map before forced cleanup */
  DEDUPE_MAP_MAX_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),
  /**
   * Max CPU worker threads for pure-compute offload. Defaults to
   * availableParallelism() - 1 (leaves one core for the main event loop).
   * Set lower on single-core Pterodactyl allocations to avoid cgroup
   * throttling; set higher on multi-core boxes for faster batch work.
   */
  CPU_WORKER_COUNT: z.coerce.number().int().min(0).max(32).optional(),
  /**
   * RSS threshold (MB) at which the memory watchdog performs a controlled
   * shutdown so systemd restarts the process. Baileys per-session state
   * (signal sender-key records, prekey caches, LID maps) grows with group
   * traffic and is not fully reclaimable; left alone the process eventually
   * aborts with a V8 heap OOM (SIGABRT/core dump) and stays unresponsive
   * until recovery finishes. A controlled bounce is a ~40s blip instead.
   * Set 0 to disable the watchdog.
   */
  MEMORY_WATCHDOG_MAX_RSS_MB: z.coerce.number().int().min(0).max(16384).default(1800),
  /** How often the memory watchdog samples process RSS (ms). */
  MEMORY_WATCHDOG_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(60_000),
  /**
   * When true, the panel control HTTP server runs on its own worker thread
   * so API responses stay fast even when the main event loop is saturated
   * with Baileys/crypto work. Recommended for production.
   */

  // --------------------------------------------------------------------------
  // Baileys engine tuning (fork plogme). Audit 2026-09-06.
  // Env toggles allow rollback without a code change.
  // --------------------------------------------------------------------------
  /**
   * Baileys send/decrypt retry budget. 0 disables retries entirely (silent
   * message drops on transient failures). A small bounded value is safe now
   * that the per-session crypto guard prevents retry storms.
   */
  BAILEYS_MAX_MSG_RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(1),
  /** Delay between Baileys retry requests (ms). 0 disables the delay. */
  BAILEYS_RETRY_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),
  /**
   * Fire initial contacts/chats queries on socket open. The app resolves its
   * own inventories on demand, so these startup queries are largely redundant
   * work on reconnects. Set true only if contact/chat resolution degrades.
   */
  BAILEYS_FIRE_INIT_QUERIES: z.preprocess(
    (value) => (value === undefined || value === "" ? false : String(value).toLowerCase() === "true"),
    z.boolean(),
  ),
  /**
   * Let the engine generate high-quality link previews on outbound messages.
   * The app supplies its own cached native previews, so engine-side preview
   * generation is duplicate fetch/thumbnail work on URL-heavy broadcasts.
   */
  BAILEYS_HIGH_QUALITY_LINK_PREVIEW: z.preprocess(
    (value) => (value === undefined || value === "" ? false : String(value).toLowerCase() === "true"),
    z.boolean(),
  ),
  /**
   * Skip JIDs the bot never routes to (@newsletter, @broadcast, unknown
   * suffixes) to reduce per-message processing on busy accounts.
   */
  BAILEYS_IGNORE_EXTRA_JIDS: z.preprocess(
    (value) => (value === undefined || value === "" ? true : String(value).toLowerCase() === "true"),
    z.boolean(),
  ),
  /**
   * Which history-sync types the engine is allowed to hand to the app.
   * - nonblocking: only NON_BLOCKING_DATA / PUSH_NAME (smallest reconnect cost)
   * - standard: fork default (everything except FULL)
   */
  BAILEYS_HISTORY_MODE: z.enum(["nonblocking", "standard"]).default("nonblocking"),
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
