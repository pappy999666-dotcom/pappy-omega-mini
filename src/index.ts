import { mkdir } from "node:fs/promises";
import { env, assertProductionSecrets } from "./config/env.js";
import { createTelegramBot } from "./telegram/bot.js";
import {
  startModeratorReconciliation,
  stopModeratorReconciliation,
} from "./telegram/moderator.js";
import {
  hasPersistedWhatsAppAuth,
  shutdownWhatsAppSessions,
  startWhatsAppSession,
} from "./whatsapp/session-manager.js";
import {
  hydrateSessionRegistry,
  listAllSessions,
} from "./core/session-registry.js";
import { hydrateControlPlane } from "./core/control-plane.js";
import { startWorkerRuntime } from "./jobs/runtime.js";
import { closeMongo, ensureMongoIndexes } from "./persistence/mongo.js";
import type { JobOrchestrator } from "./jobs/job-orchestrator.js";
import { DurableScheduler } from "./jobs/scheduler.js";
import { hydrateMenuMedia } from "./media/menu-media-store.js";
import { closeValidatorSnapshot } from "./links/validator-snapshot.js";
import { closeOutboundPreview } from "./whatsapp/outbound-preview.js";

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
  const persistedSessions = listAllSessions();
  const recoverableSessions = [];
  for (const session of persistedSessions) {
    if (session.status === "LOGGED_OUT" || session.authHealth === "INVALID")
      continue;
    if (await hasPersistedWhatsAppAuth(session.workspaceId, session.sessionId))
      recoverableSessions.push(session);
  }
  await startRecoverableSessions(recoverableSessions, 6);
  console.log(
    `[pappy-omega-mini] WhatsApp recovery scheduled for ${recoverableSessions.length} paired session(s); ${persistedSessions.length - recoverableSessions.length} session(s) await pairing.`,
  );
  const bot = createTelegramBot();
  startModeratorReconciliation(bot);
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
    stopModeratorReconciliation();
    await scheduler?.close();
    await workers?.close();
    await closeValidatorSnapshot();
    shutdownWhatsAppSessions();
    await closeMongo();
    await closeOutboundPreview();
    console.log("[pappy-omega-mini] transports closed; shutdown complete.");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function startRecoverableSessions(
  sessions: ReturnType<typeof listAllSessions>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      const session = sessions[index];
      if (!session) return;
      try {
        await startWhatsAppSession(session.workspaceId, session.sessionId);
      } catch (error) {
        console.error(
          `[pappy-omega-mini] startup recovery failed session=${session.sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), sessions.length || 1) },
      () => worker(),
    ),
  );
}

main().catch((error) => {
  console.error("[pappy-omega-mini] fatal startup error", error);
  process.exitCode = 1;
});
