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
  closeModeratorProtectionRedis,
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
  getSession,
  hydrateSessionRegistry,
  isExplicitlyLoggedOutSession,
  listAllSessions,
  isPersistedWhatsAppSessionRecoverable,
  updateSession,
} from "./core/session-registry.js";
import { hydrateControlPlane } from "./core/control-plane.js";
import { startRuntimeHealthMonitor, stopRuntimeHealthMonitor } from "./core/runtime-health.js";
import { startWorkerRuntime } from "./jobs/runtime.js";
import { ensureDurableValidatorIndexes } from "./links/validator-persistence.js";
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
import { hydrateStickerCommandBindings } from "./whatsapp/sticker-command-bindings.js";
import { closeValidatorSnapshot } from "./links/validator-snapshot.js";
import { closeLinkCollector } from "./links/link-collector.js";
import { closeBroadcastProgress } from "./workload/broadcast-progress.js";
import { closeCanonicalPreview } from "./whatsapp/baileys-native-preview.js";
import { closeSessionLockRedis } from "./core/session-lock.js";
import { routeWhatsAppText, type WhatsAppReply } from "./whatsapp/message-router.js";
import { runAntiChecks } from "./whatsapp/anti-system/engine.js";
import { callAssignedWorkloadTransport } from "./whatsapp/workload-transport.js";
import { setWorkloadInboundEventHandler } from "./workload/events.js";
import type { WorkloadInboundEvent, WorkloadInboundResult } from "./workload/types.js";
import {
  startRemoteBridgeResponder,
  stopRemoteBridgeResponder,
} from "./whatsapp/remote-bridge.js";
import {
  startWorkloadControlServer,
  stopWorkloadControlServer,
} from "./workload/control-server.js";

const INBOUND_DEDUPE_TTL_MS = 5 * 60_000;
let processShutdownInProgress = false;
const inboundDedupe = new Map<string, { expiresAt: number; result: Promise<WorkloadInboundResult> }>();

process.on("uncaughtException", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (processShutdownInProgress && message === "Connection is closed.") {
    console.warn("[pappy-omega-mini] Redis connection closed during shutdown; continuing cleanup.");
    return;
  }
  console.error("[pappy-omega-mini] uncaught exception:", error);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (processShutdownInProgress && message === "Connection is closed.") {
    console.warn("[pappy-omega-mini] Redis rejection during shutdown; continuing cleanup.");
    return;
  }
  console.error("[pappy-omega-mini] unhandled rejection:", reason);
  process.exitCode = 1;
});

function inboundDedupeKey(event: WorkloadInboundEvent): string | undefined {
  return event.messageId
    ? `${event.workspaceId}:${event.sessionId}:${event.messageId}`
    : undefined;
}

async function main(): Promise<void> {
  assertProductionSecrets();
  startRuntimeHealthMonitor();
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
  await ensureDurableValidatorIndexes();
  await hydrateSessionRegistry();
  await hydrateMenuMedia();
  await hydrateStickerCommandBindings();
  await hydrateControlPlane();
  let bot: ReturnType<typeof createTelegramBot> | undefined;
  if (!isWorkerProcess) {
    bot = createTelegramBot();
    startModeratorReconciliation(bot);
    void bot.launch()
      .then(() => console.log("[pappy-omega-mini] Telegram polling stopped."))
      .catch((error) => console.error("[pappy-omega-mini] Telegram gateway failed:", error instanceof Error ? error.message : String(error)));
    console.log("[pappy-omega-mini] Telegram gateway starting in polling mode.");
  }
  let workers: JobOrchestrator | undefined;
  let scheduler: DurableScheduler | undefined;
  let autoPromoteScheduler: AutoPromoteScheduler | undefined;
  let pairingCleanupTimer: NodeJS.Timeout | undefined;
  workers = startWorkerRuntime();
  if (isWorkerProcess) await startRemoteBridgeResponder(routeWhatsAppText);
  if (!isWorkerProcess) {
    setWorkloadInboundEventHandler(async (event) => {
      const key = inboundDedupeKey(event);
      const cached = key ? inboundDedupe.get(key) : undefined;
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      if (cached) inboundDedupe.delete(key!);
      const processInbound = async (): Promise<WorkloadInboundResult> => {
      if (!event.interactionId && !event.interactionDisplayText && event.remoteJid.endsWith("@g.us") && !event.fromMe) {
        let sessionPrefix = "";
        try {
          sessionPrefix = getSession(event.workspaceId, event.sessionId).prefix ?? "";
        } catch {
          // The authenticated workload assignment was already checked by the control server.
        }
        void runAntiChecks({
          workspaceId: event.workspaceId,
          sessionId: event.sessionId,
          groupJid: event.remoteJid,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          senderJid: event.senderJid,
          text: event.text,
          prefix: sessionPrefix,
          ...(event.quotedText ? { quotedText: event.quotedText } : {}),
          ...(event.mentionedJids?.length ? { mentionedJids: event.mentionedJids } : {}),
          ...(event.message ? { message: event.message } : {}),
          ...(event.rawKey ? { rawKey: event.rawKey } : {}),
          ...(event.media ? { mediaKind: event.media.kind, ...(event.media.ptt !== undefined ? { mediaPtt: event.media.ptt } : {}) } : {}),
        }).catch((error) => {
          if (process.env.PAPPY_DEBUG_WA_ANTI === "1")
            console.warn(`[pappy-omega-mini] isolated panel Anti System check failed session=${event.sessionId}:`, error);
        });
      }
      const reply = await routeWhatsAppText({
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        chatJid: event.remoteJid,
        senderJid: event.senderJid,
        ...(event.receivedAt ? { receivedAt: event.receivedAt } : {}),
        text: event.text,
        ...(event.interactionId ? { interactionId: event.interactionId } : {}),
        ...(event.interactionDisplayText ? { interactionDisplayText: event.interactionDisplayText } : {}),
        ...(event.quotedText ? { quotedText: event.quotedText } : {}),
        ...(event.quotedSenderJid ? { quotedSenderJid: event.quotedSenderJid } : {}),
        ...(event.quotedMessageKey ? { quotedMessageKey: event.quotedMessageKey } : {}),
        ...(event.quotedStickerFingerprint ? { quotedStickerFingerprint: event.quotedStickerFingerprint } : {}),
        ...(event.stickerFingerprint ? { stickerFingerprint: event.stickerFingerprint } : {}),
        ...(event.mentionedJids?.length ? { mentionedJids: event.mentionedJids } : {}),
        ...(event.media
          ? {
              media: {
                kind: event.media.kind,
                bytes: Buffer.from(event.media.bytes, "base64"),
                ...(event.media.mimeType ? { mimeType: event.media.mimeType } : {}),
                ...(event.media.fileName ? { fileName: event.media.fileName } : {}),
                ...(event.media.caption ? { caption: event.media.caption } : {}),
                ...(event.media.ptt !== undefined ? { ptt: event.media.ptt } : {}),
              },
            }
          : {}),
        ...(event.fromMe ? { fromMe: true } : {}),
      });
      if (!reply) return { reply: null };
      let payload: Record<string, unknown>;
      if (typeof reply === "string") payload = { text: reply };
      else {
        const result = reply as WhatsAppReply;
        payload = result.media
          ? result.media.kind === "sticker"
            ? {
                sticker: result.media.bytes,
                mimetype: "image/webp",
              }
            : {
                [result.media.kind]: result.media.bytes,
                ...(result.media.kind !== "audio" && (result.caption ?? "") ? { caption: result.caption } : {}),
                ...(result.media.mimeType ? { mimetype: result.media.mimeType } : {}),
                ...(result.media.kind === "video" || result.media.kind === "document" ? { fileName: result.media.fileName } : {}),
                ...(result.nativeFlow ? { nativeFlow: result.nativeFlow } : {}),
                ...(result.nativeTable ? { nativeTable: result.nativeTable } : {}),
                ...(result.richMenu ? { richMenu: result.richMenu } : {}),
                ...(result.mentions?.length ? { mentions: result.mentions } : {}),
              }
          : {
              ...(result.text ? { text: result.text } : {}),
              ...(result.nativeFlow ? { nativeFlow: result.nativeFlow } : {}),
              ...(result.nativeTable ? { nativeTable: result.nativeTable } : {}),
              ...(result.richMenu ? { richMenu: result.richMenu } : {}),
              ...(result.mentions?.length ? { mentions: result.mentions } : {}),
            };
      }
      await callAssignedWorkloadTransport(event.workspaceId, event.sessionId, "sendMessage", [event.remoteJid, payload]);
      return { reply: { delivered: true } };
      };
      if (!key) return processInbound();
      let result: Promise<WorkloadInboundResult>;
      result = processInbound().catch((error) => {
        if (inboundDedupe.get(key)?.result === result) inboundDedupe.delete(key);
        throw error;
      });
      inboundDedupe.set(key, { expiresAt: Date.now() + INBOUND_DEDUPE_TTL_MS, result });
      const timer = setTimeout(() => {
        if (inboundDedupe.get(key)?.result === result) inboundDedupe.delete(key);
      }, INBOUND_DEDUPE_TTL_MS);
      timer.unref?.();
      return result;
    });
    await startWorkloadControlServer();
  }
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
  // An assigned panel owns the WhatsApp socket for its phone. Do not recover
  // an older local duplicate for the same phone in the main process: two
  // Baileys sockets for one account cause 401/408 reconnect churn and make
  // every panel command wait behind a socket that can never become ready.
  const assignedPhoneNumbers = new Set(
    persistedSessions
      .filter((session) => Boolean(session.workloadWorkerId))
      .map((session) => session.phoneNumber?.replace(/\D/g, "") ?? "")
      .filter(Boolean),
  );
  const ownedSessions = persistedSessions.filter((session) => {
    if (isWorkerProcess) return workerSessionIds.has(session.sessionId);
    const phone = session.phoneNumber?.replace(/\D/g, "") ?? "";
    if (!session.workloadWorkerId && phone && assignedPhoneNumbers.has(phone)) return false;
    return !excludedSessionIds.has(session.sessionId) && !session.workloadWorkerId;
  });
  const recoverableSessions = [];
  for (const session of ownedSessions) {
    if (!isPersistedWhatsAppSessionRecoverable(session)) continue;
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
  if (isWorkerProcess) {
    console.log(`[pappy-omega-mini] Worker role online; owned sessions=${[...workerSessionIds].join(",") || "none"}. Telegram gateway disabled.`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    processShutdownInProgress = true;
    console.log(`[pappy-omega-mini] ${signal} received; stopping new work.`);
    try {
      bot?.stop(signal);
    } catch (error) {
      console.warn(
        "[pappy-omega-mini] Telegram stop was already closed; continuing shutdown:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (pairingCleanupTimer) clearInterval(pairingCleanupTimer);
    if (bot) {
      try {
        stopModeratorReconciliation();
      } catch (error) {
        console.warn(
          "[pappy-omega-mini] moderator cleanup failed during shutdown:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const closeSafely = async (label: string, task: () => Promise<void>): Promise<void> => {
      try {
        await task();
      } catch (error) {
        console.error(
          `[pappy-omega-mini] ${label} cleanup failed; continuing shutdown:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    await closeSafely("workload control", stopWorkloadControlServer);
    await closeSafely("scheduler", async () => scheduler?.close());
    await closeSafely("auto-promote scheduler", async () => autoPromoteScheduler?.close());
    await closeSafely("WhatsApp sessions", shutdownWhatsAppSessions);
    await closeSafely("job workers", async () => workers?.close());
    await closeSafely("validator snapshot", closeValidatorSnapshot);
    await closeSafely("link collector", closeLinkCollector);
    await closeSafely("broadcast progress", closeBroadcastProgress);
    await closeSafely("moderator protection", closeModeratorProtectionRedis);
    await closeSafely("MongoDB", closeMongo);
    await closeSafely("canonical preview", closeCanonicalPreview);
    await closeSafely("session lock", closeSessionLockRedis);
    await closeSafely("remote bridge", stopRemoteBridgeResponder);
    stopRuntimeHealthMonitor();
    console.log("[pappy-omega-mini] transports closed; shutdown complete.");
    // A few library-owned handles (for example duplicated Redis clients) can
    // outlive their public close promise. Give final microtasks a short grace
    // window, then exit cleanly instead of letting systemd SIGKILL the process.
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function cleanupLoggedOutSessions(): Promise<void> {
  const terminal = listAllSessions().filter(
    (session) =>
      (isWorkerProcess ? workerSessionIds.has(session.sessionId) : !excludedSessionIds.has(session.sessionId)) &&
      isExplicitlyLoggedOutSession(session),
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
      (isWorkerProcess ? workerSessionIds.has(session.sessionId) : !excludedSessionIds.has(session.sessionId) && !session.workloadWorkerId) &&
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
