import { mkdir } from "node:fs/promises";
import {
  env,
  assertProductionSecrets,
  excludedSessionIds,
  isWorkerProcess,
  workerSessionIds,
} from "./config/env.js";
import { createTelegramBot } from "./telegram/bot.js";
import {
  startModeratorReconciliation,
  stopModeratorReconciliation,
} from "./telegram/moderator.js";
import {
  hasPersistedWhatsAppAuth,
  purgeWhatsAppSession,
  startWhatsAppSession,
  shutdownWhatsAppSessions,
  waitForWhatsAppSessionReady,
} from "./whatsapp/session-manager.js";
import {
  hydrateSessionRegistry,
  listAllSessions,
  updateSession,
} from "./core/session-registry.js";
import { hydrateControlPlane } from "./core/control-plane.js";
import { startWorkerRuntime } from "./jobs/runtime.js";
import {
  closeMongo,
  deletePairingRequest,
  ensureMongoIndexes,
  listExpiredPairingRequests,
} from "./persistence/mongo.js";
import type { JobOrchestrator } from "./jobs/job-orchestrator.js";
import { DurableScheduler } from "./jobs/scheduler.js";
import { AutoPromoteScheduler } from "./autopromote/service.js";
import { hydrateMenuMedia } from "./media/menu-media-store.js";
import { closeValidatorSnapshot } from "./links/validator-snapshot.js";
import { closeCanonicalPreview } from "./whatsapp/baileys-native-preview.js";
import { closeSessionLockRedis } from "./core/session-lock.js";
import { routeWhatsAppText } from "./whatsapp/message-router.js";
import {
  startRemoteBridgeResponder,
  stopRemoteBridgeResponder,
} from "./whatsapp/remote-bridge.js";

async function main(): Promise<void> {
  assertProductionSecrets();
  await mkdir(env.SESSION_ROOT, { recursive: true });
  await mkdir(env.MEDIA_ROOT, { recursive: true });

  if (!env.TELEGRAM_BOT_TOKEN && !isWorkerProcess) {
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
  let workers: JobOrchestrator | undefined;
  let scheduler: DurableScheduler | undefined;
  let autoPromoteScheduler: AutoPromoteScheduler | undefined;
  let pairingCleanupTimer: NodeJS.Timeout | undefined;
  workers = startWorkerRuntime();
  if (isWorkerProcess) await startRemoteBridgeResponder(routeWhatsAppText);
  if (!isWorkerProcess) {
    scheduler = new DurableScheduler(workers);
    scheduler.start();
    autoPromoteScheduler = new AutoPromoteScheduler(workers);
    autoPromoteScheduler.start();
  }
  if (!isWorkerProcess) {
    await cleanupExpiredPairingSessions();
    await cleanupLoggedOutSessions();
    pairingCleanupTimer = setInterval(() => {
      void cleanupExpiredPairingSessions();
      void cleanupLoggedOutSessions();
    }, 5 * 60 * 1000);
    pairingCleanupTimer.unref?.();
  }
  const persistedSessions = listAllSessions();
  const ownedSessions = persistedSessions.filter((session) => {
    if (isWorkerProcess) return workerSessionIds.has(session.sessionId);
    return !excludedSessionIds.has(session.sessionId);
  });
  const recoverableSessions = [];
  for (const session of ownedSessions) {
    if (session.status === "LOGGED_OUT" || session.authHealth === "INVALID")
      continue;
    if (
      await hasPersistedWhatsAppAuth(session.workspaceId, session.sessionId)
    ) {
      recoverableSessions.push(session);
    } else {
      updateSession(session.workspaceId, session.sessionId, {
        status: "PAIRING",
        authHealth: "UNKNOWN",
        disconnectReason:
          "No complete persisted WhatsApp credentials were found; auth was preserved and pairing is required.",
      });
    }
  }
  await startRecoverableSessions(recoverableSessions, 6);
  console.log(
    `[pappy-omega-mini] ${isWorkerProcess ? "Worker" : "Main"} WhatsApp recovery completed for ${recoverableSessions.length} persisted paired session(s); ${ownedSessions.length - recoverableSessions.length} owned session(s) await pairing or recovery.`,
  );
  let bot: ReturnType<typeof createTelegramBot> | undefined;
  if (!isWorkerProcess) {
    bot = createTelegramBot();
    startModeratorReconciliation(bot);
    await bot.launch();
    console.log("[pappy-omega-mini] Telegram gateway online.");
  } else {
    console.log(`[pappy-omega-mini] Worker role online; owned sessions=${[...workerSessionIds].join(",") || "none"}. Telegram gateway disabled.`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pappy-omega-mini] ${signal} received; stopping new work.`);
    bot?.stop(signal);
    if (pairingCleanupTimer) clearInterval(pairingCleanupTimer);
    if (bot) stopModeratorReconciliation();
    await scheduler?.close();
    await autoPromoteScheduler?.close();
    await workers?.close();
    await closeValidatorSnapshot();
    await shutdownWhatsAppSessions();
    await closeMongo();
    await closeCanonicalPreview();
    await closeSessionLockRedis();
    await stopRemoteBridgeResponder();
    console.log("[pappy-omega-mini] transports closed; shutdown complete.");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function cleanupLoggedOutSessions(): Promise<void> {
  const terminal = listAllSessions().filter(
    (session) =>
      (isWorkerProcess ? workerSessionIds.has(session.sessionId) : !excludedSessionIds.has(session.sessionId)) &&
      (session.status === "LOGGED_OUT" ||
        (session.authHealth === "INVALID" && session.status !== "ACTIVE")),
  );
  for (const session of terminal) {
    await purgeWhatsAppSession(session.workspaceId, session.sessionId).catch(
      (error) => {
        console.error(
          `[pappy-omega-mini] logged-out session purge failed session=${session.sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }
  if (terminal.length)
    console.info(
      `[pappy-omega-mini] logged-out cleanup sessionsPurged=${terminal.length}`,
    );
}

async function cleanupExpiredPairingSessions(): Promise<void> {
  const cutoffAt = Date.now() - env.PAIRING_REQUEST_TTL_MS;
  const expiredRequests = await listExpiredPairingRequests(cutoffAt);
  const expiredIds = new Set(
    expiredRequests
      .map((request) => request.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const candidates = listAllSessions().filter(
    (session) =>
      (isWorkerProcess ? workerSessionIds.has(session.sessionId) : !excludedSessionIds.has(session.sessionId)) &&
      session.status === "PAIRING" &&
      typeof session.createdAt === "number" &&
      session.createdAt < cutoffAt,
  );
  let purged = 0;
  for (const session of candidates) {
    const hasAuth = await hasPersistedWhatsAppAuth(
      session.workspaceId,
      session.sessionId,
    );
    if (hasAuth) continue;
    await purgeWhatsAppSession(session.workspaceId, session.sessionId).catch(
      (error) => {
        console.error(
          `[pappy-omega-mini] expired pairing purge failed session=${session.sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    expiredIds.delete(session.sessionId);
    purged += 1;
  }
  for (const request of expiredRequests)
    await deletePairingRequest(request.telegramUserId).catch(() => undefined);
  if (expiredRequests.length || purged)
    console.info(
      `[pappy-omega-mini] expired pairing cleanup requests=${expiredRequests.length} sessionsPurged=${purged} orphanRequestSessions=${expiredIds.size}`,
    );
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
        const ready = await waitForWhatsAppSessionReady(
          session.workspaceId,
          session.sessionId,
        );
        if (!ready)
          console.warn(
            `[pappy-omega-mini] startup recovery did not reach ACTIVE session=${session.sessionId}`,
          );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        updateSession(session.workspaceId, session.sessionId, {
          status: "ERROR",
          authHealth: "DEGRADED",
          lastError: `startup recovery: ${reason}`.slice(0, 500),
          disconnectReason:
            "Startup recovery failed; auth was preserved and retry remains available.",
        });
        console.error(
          `[pappy-omega-mini] startup recovery failed session=${session.sessionId}:`,
          reason,
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
