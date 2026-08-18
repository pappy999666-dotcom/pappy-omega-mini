import { mkdir } from "node:fs/promises";
import { env, assertProductionSecrets } from "./config/env.js";
import { createTelegramBot } from "./telegram/bot.js";
import { shutdownWhatsAppSessions } from "./whatsapp/session-manager.js";
import { hydrateSessionRegistry } from "./core/session-registry.js";
import { hydrateControlPlane } from "./core/control-plane.js";
import { startWorkerRuntime } from "./jobs/runtime.js";
import { closeMongo, ensureMongoIndexes } from "./persistence/mongo.js";
import type { JobOrchestrator } from "./jobs/job-orchestrator.js";
import { DurableScheduler } from "./jobs/scheduler.js";
import { hydrateMenuMedia } from "./media/menu-media-store.js";

async function main(): Promise<void> {
  assertProductionSecrets();
  await mkdir(env.SESSION_ROOT, { recursive: true });
  await mkdir(env.MEDIA_ROOT, { recursive: true });

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log(
      "[pappy-omega-mini] Scaffold ready. Set TELEGRAM_BOT_TOKEN to start the Telegram gateway.",
    );
    console.log(
      "[pappy-omega-mini] WhatsApp transport remains isolated behind the session-manager boundary.",
    );
    return;
  }

  await ensureMongoIndexes();
  await hydrateMenuMedia();
  await hydrateSessionRegistry();
  await hydrateControlPlane();
  const bot = createTelegramBot();
  let workers: JobOrchestrator | undefined;
  let scheduler: DurableScheduler | undefined;
  if (env.TELEGRAM_BOT_TOKEN) {
    workers = startWorkerRuntime();
    scheduler = new DurableScheduler(workers);
    scheduler.start();
  }
  await bot.launch();
  console.log("[pappy-omega-mini] Telegram gateway online.");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pappy-omega-mini] ${signal} received; stopping new work.`);
    bot.stop(signal);
    await scheduler?.close();
    await workers?.close();
    shutdownWhatsAppSessions();
    await closeMongo();
    console.log("[pappy-omega-mini] transports closed; shutdown complete.");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[pappy-omega-mini] fatal startup error", error);
  process.exitCode = 1;
});
