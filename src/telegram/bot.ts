import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { env, ownerTelegramIds } from "../config/env.js";
import type { SessionJoinSettings } from "../types/domain.js";
import {
  resolveUser,
  listSessions,
  listVisibleSessions,
  listAllSessions,
  createSession,
  getSession,
  getSessionJoinSettings,
  updateSession,
  updateSessionJoinSettings,
  setUserStatusLocal,
  getWorkspaceDefaults,
  getWorkspaceOwnerTelegramUserId,
  updateWorkspaceDefaults,
} from "../core/session-registry.js";
import {
  clearWhatsappMenuMedia,
  getAdminMediaOverview,
  selectWhatsappMenuMedia,
  updateWhatsappMenuCaption,
  uploadWhatsappMenuMedia,
} from "../admin/media-actions.js";
import {
  getWhatsappMenuSettings,
  listMenuMedia,
} from "../media/menu-media-store.js";
import {
  getInceptorSnapshot,
  getWorkerRuntime,
  runInceptorSweep,
  runValidatorSweepNow,
  setJobCompletionNotifier,
} from "../jobs/runtime.js";
import type { JobRecord } from "../jobs/job-contracts.js";
import {
  cancelAutoPromoteConfig,
  createAutoPromoteConfig,
  deleteAutoPromoteConfig,
  pauseAutoPromoteConfig,
  resumeAutoPromoteConfig,
} from "../autopromote/service.js";
import type {
  AutoPromoteCommand,
  AutoPromoteScope,
} from "../autopromote/types.js";
import type { JobMediaReference } from "../whatsapp/job-media-store.js";
import type { WhatsAppMediaPayload } from "../whatsapp/media-payload.js";
import { persistJobMedia } from "../whatsapp/job-media-store.js";
import {
  getEmergencyState,
  listAuditEvents,
  recordAudit,
  setEmergencyState,
} from "../core/control-plane.js";
import { getValidatorSnapshot } from "../links/validator-snapshot.js";
import { GLOBAL_VALIDATOR_SCOPE } from "../links/link-bucket-store.js";
import {
  listValidatorBucket,
  countValidatorBucket,
  mergeValidatorBuckets,
  purgeValidatorBucket,
  type ValidatorBucket,
} from "../links/validator-operations.js";
import {
  collectLinks,
  collectLinksFromChunks,
  extractWhatsAppGroupInviteUrls,
  isWhatsAppGroupInviteUrl,
} from "../links/link-collector.js";
import { exportBucket } from "../links/link-export.js";
import { createHash, randomUUID } from "node:crypto";
import {
  deletePairingRequest,
  disableSchedule,
  getPairingRequest,
  listForceJoinTargets,
  listSchedules,
  getAutoPromoteConfig,
  listAutoPromoteConfigs,
  listAutoPromoteRuns,
  listSupportTickets,
  createSupportTicket,
  updateSupportTicket,
  listUsers,
  loadModeratorGroup,
  removeForceJoinTarget,
  savePairingRequest,
  saveSchedule,
  setForceJoinTargetEnabled,
  setUserStatus,
  upsertForceJoinTarget,
  type ForceJoinTargetRecord,
} from "../persistence/mongo.js";
import {
  purgeWhatsAppSession,
  requestWhatsAppPairingCode,
  restartWhatsAppSession,
  setPairingNotifier,
} from "../whatsapp/session-manager.js";
import {
  createWhatsAppGroup,
  getGroupInviteCode,
  updateGroupDescription,
  getProfilePictureUrl,
  leaveWhatsAppGroup,
  listGroups,
  removeProfilePicture,
  sendDirectText,
  updateGroupProfilePicture,
  updateProfileBio,
  updateProfileName,
  updateProfilePicture,
} from "../whatsapp/transport-adapter.js";
import { routeWhatsAppText } from "../whatsapp/message-router.js";
import { effectiveSessionStatus } from "../menus/menu-model.js";
import {
  installModeratorCommands,
  installModeratorProtection,
  moderatorCommandScopes,
  openModeratorDashboard,
} from "./moderator.js";
import {
  adminKeyboard,
  adminJobsKeyboard,
  adminJobsText,
  adminForceJoinKeyboard,
  adminForceJoinText,
  adminAuditKeyboard,
  adminAuditText,
  adminBucketKeyboard,
  adminBucketText,
  adminInceptorKeyboard,
  adminInceptorText,
  adminBridgeKeyboard,
  adminBridgeTargetToken,
  adminBridgeText,
  adminUsersKeyboard,
  adminUsersText,
  bucketKeyboard,
  forceJoinKeyboard,
  forceJoinText,
  workspaceSettingsKeyboard,
  workspaceSettingsText,
  validatorDashboardText,
  bridgeSessionPicker,
  dashboardKeyboard,
  dashboardText,
  groupStartKeyboard,
  groupStartText,
  featureText,
  globalBridgeKeyboard,
  globalBridgeText,
  globalBridgeResultText,
  validatorLiveKeyboard,
  validatorLiveText,
  helpText,
  joinManagerKeyboard,
  jobLiveKeyboard,
  jobLiveText,
  linkCollectionKeyboard,
  mediaKeyboard,
  menuMediaPickerKeyboard,
  pageText,
  sessionKeyboard,
  sessionText,
  sessionToolsKeyboard,
  sessionSettingsKeyboard,
  sessionAccessKeyboard,
  sessionValidatorKeyboard,
  sessionsKeyboard,
  autoPromoteScopeKeyboard,
  autoPromoteCommandKeyboard,
  autoPromoteDaysKeyboard,
  autoPromoteTimesKeyboard,
  autoPromotePostsKeyboard,
  autoPromoteConfirmKeyboard,
  autoPromoteDashboardKeyboard,
  autoPromoteGlobalTargetsKeyboard,
  autoPromoteText,
  btn,
  copyBtn,
  keyboard,
  workloadKeyboard,
  workloadText,
  workloadPanelText,
  workloadPanelKeyboard,
  workloadLoggerText,
  workloadLoggerKeyboard,
  workloadGuideText,
  adminWorkloadText,
  adminWorkloadKeyboard,
  adminWorkloadWorkerText,
  adminWorkloadWorkerKeyboard,
  ui,
} from "./ui.js";
import {
  dangerResponse,
  infoResponse,
  successResponse,
  warningResponse,
} from "./renderer.js";
import {
  assignWorkloadSession,
  createWorkloadPairingCode,
  getWorkloadMode,
  getOwnerWorkloadWorkerByDisplayKey,
  getOwnerWorkloadWorkerByCode,
  getWorkloadLoggerSnapshot,
  getWorkspaceWorkloadWorkerByDisplayKey,
  getWorkspaceWorkloadWorkerByCode,
  listWorkspaceWorkloadWorkers,
  revokeWorkloadWorker,
  setWorkloadMode,
  setWorkloadNotifier,
  type WorkloadNotification,
  toggleWorkloadWorker,
} from "../workload/service.js";
import { isWorkloadWorkerReady } from "../workload/readiness.js";

const pendingMedia = new Map<string, "image" | "video">();
const globalBridgeSelections = new Map<string, Set<string>>();
const globalBridgeActive = new Set<string>();
const joinStates = new Map<string, "idle" | "running" | "paused" | "stopped">();
const joinJobs = new Map<string, string>();
const liveLoops = new Map<string, ReturnType<typeof setInterval>>();
const validatorLiveStates = new Map<string, boolean>();
const passiveIntakeSuspended = new Set<string>();
const pendingAdminInput = new Map<
  string,
  | "forcejoin:target"
  | "forcejoin:name"
  | "forcejoin:button"
  | "broadcast:compose"
  | "menu:caption"
  | "workload:name"
>();
const pendingForceJoin = new Map<
  string,
  {
    workspaceId: string;
    target?: string;
    targetType?: "channel" | "group";
    displayName?: string;
  }
>();
const pendingAdminBroadcasts = new Map<
  string,
  { text: string; workspaceId: string }
>();
const pendingScheduleInput = new Map<string, { workspaceId: string }>();
type AutoPromoteWizard = {
  workspaceId: string;
  scope: AutoPromoteScope;
  sessionId?: string | undefined;
  targetSessionIds?: string[] | undefined;
  allFutureSessions?: boolean;
  command?: AutoPromoteCommand;
  days?: number;
  timesPerDay?: number;
  allstatusxPostsPerGroup?: number;
  payloadText?: string;
  payloadMedia?: JobMediaReference;
  payloadCaption?: string;
  payloadQuoted?: { messageId?: string; remoteJid?: string; text?: string };
  stage: "scope" | "command" | "days" | "times" | "posts" | "payload" | "confirm";
  chatId?: number | undefined;
  messageId?: number | undefined;
};
const pendingAutoPromote = new Map<string, AutoPromoteWizard>();
const pendingSupportInput = new Map<string, { workspaceId: string }>();
const pendingSupportReply = new Map<string, { ticketId: string }>();
const pendingWorkloadKey = new Map<string, { workspaceId: string }>();
const preferredWorkloadWorker = new Map<string, { workspaceId: string; workerId: string; workloadCode: string; displayKey: string }>();
const pendingGroupCreate = new Map<
  string,
  {
    workspaceId: string;
    sessionId: string;
    stage: "subject" | "participants" | "description";
    subject?: string;
    participants?: string[];
  }
>();
const pendingProfilePicture = new Map<
  string,
  { workspaceId: string; sessionId: string }
>();
const pendingSessionSudo = new Map<
  string,
  { workspaceId: string; sessionId: string; action: "add" | "remove" }
>();
const pendingGroupPicture = new Map<
  string,
  { workspaceId: string; sessionId: string; groupJid?: string }
>();
const pendingGroupLeave = new Map<
  string,
  { workspaceId: string; sessionId: string; groupJid?: string }
>();
const pendingSessionSetting = new Map<
  string,
  { workspaceId: string; sessionId: string; action: "name" | "bio" | "prefix" }
>();
type JoinSettingField =
  | "target"
  | "delay"
  | "minDelay"
  | "maxDelay"
  | "batch"
  | "retry"
  | "retryBase"
  | "cooldown"
  | "restriction"
  | "concurrency"
  | "mode";
const pendingJoinSettingInput = new Map<
  string,
  {
    workspaceId: string;
    sessionId: string;
    field: JoinSettingField;
    chatId: number;
    messageId: number;
  }
>();
const pendingBroadcastDelay = new Map<string, string>();
const pendingPairing = new Map<
  string,
  {
    stage: "label" | "phone";
    chatId: number;
    messageId?: number;
    sessionId?: string;
  }
>();
const pendingGlobalCommand = new Map<
  string,
  { workspaceId: string; chatId: number; messageId: number }
>();
const pendingSessionBridge = new Map<
  string,
  { workspaceId: string; sessionId: string; chatId: number; messageId: number }
>();
const pendingAdminBridge = new Map<
  string,
  { workspaceId: string; sessionId: string; chatId: number; messageId: number }
>();
const adminBridgeSelections = new Map<string, Set<string>>();
const pendingAdminGlobalBridge = new Map<
  string,
  { chatId: number; messageId: number }
>();
const pendingLiveJobCode = new Map<
  string,
  { workspaceId: string; chatId: number; messageId: number }
>();

function stopJobLiveLoop(loopKey: string): void {
  const current = liveLoops.get(loopKey);
  if (!current) return;
  clearInterval(current);
  liveLoops.delete(loopKey);
}

function startJobLiveLoop(
  ctx: Context,
  workspaceId: string,
  code: string,
  chatId: number,
  messageId: number,
): void {
  const loopKey = `job-live:${workspaceId}:${chatId}:${messageId}`;
  stopJobLiveLoop(loopKey);
  const refresh = async (): Promise<void> => {
    const job = await getWorkerRuntime()?.getByCode(workspaceId, code);
    const terminal = Boolean(
      job &&
        ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"].includes(
          job.state,
        ),
    );
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      jobLiveText(job),
      { parse_mode: "HTML", reply_markup: jobLiveKeyboard(job) },
    );
    if (terminal) stopJobLiveLoop(loopKey);
  };
  const interval = setInterval(() => {
    void refresh().catch(() => stopJobLiveLoop(loopKey));
  }, 1_000);
  liveLoops.set(loopKey, interval);
  setTimeout(() => stopJobLiveLoop(loopKey), 30 * 60_000).unref?.();
}

function clearPendingInputs(userId: string): void {
  pendingMedia.delete(userId);
  pendingAdminInput.delete(userId);
  pendingForceJoin.delete(userId);
  pendingAdminBroadcasts.delete(userId);
  pendingScheduleInput.delete(userId);
  pendingAutoPromote.delete(userId);
  pendingSupportInput.delete(userId);
  pendingSupportReply.delete(userId);
  pendingWorkloadKey.delete(userId);
  pendingGroupCreate.delete(userId);
  pendingProfilePicture.delete(userId);
  pendingSessionSudo.delete(userId);
  pendingGroupPicture.delete(userId);
  pendingGroupLeave.delete(userId);
  pendingSessionSetting.delete(userId);
  pendingJoinSettingInput.delete(userId);
  pendingBroadcastDelay.delete(userId);
  pendingPairing.delete(userId);
  pendingGlobalCommand.delete(userId);
  pendingSessionBridge.delete(userId);
  pendingAdminBridge.delete(userId);
  pendingAdminGlobalBridge.delete(userId);
  pendingLiveJobCode.delete(userId);
}

export function isAutoPromoteWizardContinuation(callbackData: string): boolean {
  return (
    callbackData.startsWith("autopromote:scope:") ||
    callbackData.startsWith("autopromote:command:") ||
    callbackData.startsWith("autopromote:days:") ||
    callbackData.startsWith("autopromote:times:") ||
    callbackData.startsWith("autopromote:posts:") ||
    callbackData === "autopromote:edit" ||
    callbackData === "autopromote:confirm" ||
    callbackData.startsWith("autopromote:global:") ||
    callbackData === "admin:autopromote:targets:refresh"
  );
}

async function registerTelegramCommandSuggestions(
  bot: Telegraf<Context>,
): Promise<void> {
  const privateCommands = [
    { command: "start", description: "Open the Pappy Omega dashboard" },
    { command: "help", description: "Show available commands" },
    { command: "menu", description: "Open the main menu" },
    { command: "pair", description: "Pair a WhatsApp session" },
    { command: "sessions", description: "List your WhatsApp sessions" },
    { command: "autopromote", description: "Schedule durable WhatsApp promotions" },
  ];
  const groupCommands = [
    { command: "help", description: "Show available commands" },
    { command: "menu", description: "Open the main menu" },
  ];
  try {
    await bot.telegram.setMyCommands(privateCommands, {
      scope: { type: "all_private_chats" },
    });
    await bot.telegram.setMyCommands(groupCommands, {
      scope: { type: "all_group_chats" },
    });
    await bot.telegram.setMyCommands(moderatorCommandScopes, {
      scope: { type: "all_chat_administrators" },
    });
  } catch (error) {
    console.error(
      "[pappy-omega-mini] Telegram command-scope registration failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createTelegramBot(): Telegraf<Context> {
  if (!env.TELEGRAM_BOT_TOKEN)
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const bot = new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN);
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== undefined) {
      const userId = String(ctx.from.id);
      const message = ctx.message;
      const isNewCommand = Boolean(message && "text" in message && typeof message.text === "string" && message.text.trim().startsWith("/"));
      if (isNewCommand) {
        clearPendingInputs(userId);
        passiveIntakeSuspended.delete(userId);
      }
      if (ctx.callbackQuery) {
        const callbackData = "data" in ctx.callbackQuery ? String(ctx.callbackQuery.data ?? "") : "";
        if (!isAutoPromoteWizardContinuation(callbackData)) {
          clearPendingInputs(userId);
          passiveIntakeSuspended.delete(userId);
        }
      }
    }
    await next();
  });
  void registerTelegramCommandSuggestions(bot);
  installModeratorCommands(bot);
  installModeratorProtection(bot);
  setPairingNotifier(async (chatId, message) => {
    await bot.telegram.sendMessage(
      chatId,
      `✦ <b>PAPPY OMEGA MINI</b>\n──────────────────────────────\n\n${message}`,
      { parse_mode: "HTML" },
    );
  });
  setWorkloadNotifier(async (notification: WorkloadNotification) => {
    const title = notification.state === "CONNECTED"
      ? "Workload Connected"
      : notification.state === "RECOVERED"
        ? "Workload Recovered"
        : notification.state === "OFFLINE"
          ? "Workload Offline"
          : notification.state === "UNREACHABLE"
            ? "Workload Heartbeat Lost"
            : "Workload Error";
    const icon = notification.state === "CONNECTED" || notification.state === "RECOVERED" ? "🟢" : notification.state === "ERROR" ? "🔴" : "🟡";
    const detail = notification.reason ? `\n<b>Reason:</b> ${escapeHtml(notification.reason)}` : "";
    await bot.telegram.sendMessage(
      notification.ownerTelegramUserId,
      `✦ <b>PAPPY OMEGA MINI</b>\n──────────────────────────────\n\n${icon} <b>${title}</b>\n\n<blockquote><b>Panel:</b> ${escapeHtml(notification.workerName)}\n<b>Code:</b> <code>${escapeHtml(notification.workloadCode)}</code>\n<b>Version:</b> <code>${escapeHtml(notification.workerVersion)}</code>\n<b>Sessions:</b> ${notification.assignedSessionCount}${detail}</blockquote>\n\n${notification.state === "CONNECTED" ? "Your panel is ready. Open Workload to select it for pairing." : notification.state === "RECOVERED" ? "The panel is healthy again and its assigned sessions can continue." : "Open Workload → Refresh Status for the latest panel state."}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });
  setJobCompletionNotifier(async (job) => {
    if (job.kind !== "allstatus" && job.kind !== "allchat") return;
    const payload = job.payload as {
      groups?: string[];
      count?: number;
      delayMs?: number;
      sourceChatJid?: string;
      sourceTransport?: "whatsapp";
    };
    const totalGroups = job.progress.total ?? new Set(payload.groups ?? []).size;
    const repeat = Math.max(1, Math.min(20, Number(payload.count ?? 1)));
    const expectedPosts = totalGroups * repeat;
    const progress = job.progress;
    const elapsedSeconds = Math.max(0, Math.ceil(progress.elapsedMs / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const delay = Math.max(1, Math.round(Number(payload.delayMs ?? 20000) / 1000));
    const code = job.jobCode ?? job.jobId.slice(0, 8);
    const kindLabel = job.kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT";
    const terminalLabel =
      job.state === "COMPLETED"
        ? "DONE"
        : job.state === "PARTIAL"
          ? "PARTIAL"
          : "FAILED";
    if (job.sessionId && payload.sourceTransport === "whatsapp" && payload.sourceChatJid) {
      const whatsappReport = [
        `✦ PAPPY OMEGA MINI · ${kindLabel} ${terminalLabel}`,
        "─────────────────────",
        `State         · ${job.state}`,
        `Total groups  · ${totalGroups}`,
        `Expected posts · ${expectedPosts}`,
        `Posted        · ${progress.success}`,
        `Failed        · ${progress.failed}`,
        `Skipped       · ${progress.skipped}`,
        `Delay         · ${delay}s`,
        `Total time    · ${minutes}m ${seconds}s`,
        `Live code     · ${code}`,
        "",
        job.state === "COMPLETED"
          ? "The broadcast finished successfully."
          : "The broadcast ended with failures or skips. Open Telegram Live Show for the durable details.",
      ].join("\n");
      void sendDirectText(
        job.workspaceId,
        job.sessionId,
        payload.sourceChatJid,
        whatsappReport,
      ).catch((error) =>
        console.error(
          `[pappy-omega-mini] WhatsApp completion report failed job=${code}:`,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
  bot.use(async (ctx, next) => {
    if (isAdmin(ctx) || !ctx.from) return next();
    const user = resolveTelegramUser(ctx);
    if (user.status === "banned") {
      if (ctx.callbackQuery)
        await ctx.answerCbQuery("This account is banned.", {
          show_alert: true,
        });
      else await ctx.reply("Access denied: this Telegram account is banned.");
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    resolveTelegramUser(ctx);
    const isGroup =
      ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (isGroup && ctx.chat) {
      const group = await loadModeratorGroup(String(ctx.chat.id)).catch(
        () => undefined,
      );
      let moderator = false;
      if (ctx.from) {
        const member = await ctx.telegram
          .getChatMember(ctx.chat.id, ctx.from.id)
          .catch(() => undefined);
        moderator =
          member?.status === "creator" || member?.status === "administrator";
      }
      const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
      await ctx.reply(groupStartText(title, moderator, group?.rules), {
        parse_mode: "HTML",
        reply_markup: groupStartKeyboard(moderator),
      });
      return;
    }
    if (!isAdmin(ctx)) {
      const gate = await getForceJoinGate(ctx);
      if (!gate.allowed) {
        await ctx.reply(forceJoinText(gate.targets, gate.passed), {
          parse_mode: "HTML",
          reply_markup: forceJoinKeyboard(gate.targets),
        });
        return;
      }
    }
    await ctx.reply(dashboardText(isAdmin(ctx)), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(isAdmin(ctx)),
    });
  });

  bot.action("group:start:refresh", async (ctx) => {
    await ctx.answerCbQuery("Refreshing…");
    if (
      !ctx.chat ||
      (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
    )
      return;
    const group = await loadModeratorGroup(String(ctx.chat.id)).catch(
      () => undefined,
    );
    const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
    let moderator = false;
    if (ctx.from) {
      const member = await ctx.telegram
        .getChatMember(ctx.chat.id, ctx.from.id)
        .catch(() => undefined);
      moderator =
        member?.status === "creator" || member?.status === "administrator";
    }
    await edit(
      ctx,
      groupStartText(title, moderator, group?.rules),
      groupStartKeyboard(moderator),
    );
  });

  bot.action("group:start:rules", async (ctx) => {
    await ctx.answerCbQuery();
    if (
      !ctx.chat ||
      (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
    )
      return;
    const group = await loadModeratorGroup(String(ctx.chat.id)).catch(
      () => undefined,
    );
    const title = "title" in ctx.chat ? ctx.chat.title : "Telegram group";
    let moderator = false;
    if (ctx.from) {
      const member = await ctx.telegram
        .getChatMember(ctx.chat.id, ctx.from.id)
        .catch(() => undefined);
      moderator =
        member?.status === "creator" || member?.status === "administrator";
    }
    await edit(
      ctx,
      pageText(
        "Group Rules",
        infoResponse(
          "Published Rules",
          escapeHtml(group?.rules ?? "No group rules have been configured."),
        ),
      ),
      keyboard([[btn(ui.back, "group:start:refresh")]]),
    );
  });
  bot.action("group:start:moderation", async (ctx) => {
    if (
      !ctx.chat ||
      (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
    ) {
      await ctx.answerCbQuery("Open this in a Telegram group.", {
        show_alert: true,
      });
      return;
    }
    await openModeratorDashboard(ctx);
  });

  bot.command("help", async (ctx) =>
    ctx.reply(helpText(), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "menu:main")]]),
    }),
  );
  bot.command("menu", async (ctx) => {
    resolveTelegramUser(ctx);
    await ctx.reply(dashboardText(isAdmin(ctx)), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(isAdmin(ctx)),
    });
  });
  bot.command("pair", async (ctx) =>
    startPairing(ctx, ctx.message.text.split(/\s+/).slice(1).join(" ").trim()),
  );
  bot.command("sessions", async (ctx) => sendSessions(ctx, 0));
  bot.command("adminmedia", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await sendAdminMedia(ctx);
  });
  bot.command("autopromote", async (ctx) => {
    const user = resolveTelegramUser(ctx);
    pendingAutoPromote.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
      scope: "USER",
      stage: "command",
    });
    await ctx.reply(
      pageText("Auto Promote", infoResponse("Choose Command", "Select the canonical operation to schedule.")),
      { parse_mode: "HTML", reply_markup: autoPromoteCommandKeyboard() },
    );
  });

  bot.on("text", async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      // A new Telegram command always closes the previous guided flow first.
      // This prevents an abandoned Bridge/PFP/Join/Support input from
      // consuming a later unrelated message.
      clearPendingInputs(userId);
      passiveIntakeSuspended.delete(userId);
      return;
    }
    const autoPromote = pendingAutoPromote.get(userId);
    if (autoPromote?.stage === "payload") {
      console.info(
        `[pappy-omega-mini] Telegram Auto Promote payload received user=${userId} chars=${ctx.message.text.length}`,
      );
      if (text.toLowerCase() === "cancel") {
        pendingAutoPromote.delete(userId);
        await ctx.reply(pageText("Auto Promote", infoResponse("Cancelled", "No Auto Promote configuration was created.")), { parse_mode: "HTML" });
        return;
      }
      const quotedText = ctx.message.reply_to_message && "text" in ctx.message.reply_to_message
        ? ctx.message.reply_to_message.text
        : undefined;
      try {
        pendingAutoPromote.set(userId, {
          ...autoPromote,
          payloadText: ctx.message.text,
          payloadCaption: ctx.message.text,
          ...(ctx.message.reply_to_message
            ? { payloadQuoted: { messageId: String(ctx.message.reply_to_message.message_id), ...(quotedText ? { text: quotedText } : {}) } }
            : {}),
          stage: "confirm",
        });
        await ctx.reply(
          pageText("Auto Promote · Confirm", autoPromoteWizardSummary({ ...autoPromote, payloadText: ctx.message.text })),
          { parse_mode: "HTML", reply_markup: autoPromoteConfirmKeyboard() },
        );
      } catch (error) {
        console.error(
          `[pappy-omega-mini] Auto Promote payload handling failed user=${userId}:`,
          error instanceof Error ? error.message : String(error),
        );
        await ctx.reply("Payload received, but the confirmation screen could not be delivered. Press Auto Promote again to retry.").catch(() => undefined);
      }
      return;
    }
    const joinInput = pendingJoinSettingInput.get(userId);
    if (joinInput) {
      const session = getSession(joinInput.workspaceId, joinInput.sessionId);
      if (text.toLowerCase() === "cancel") {
        pendingJoinSettingInput.delete(userId);
        await ctx.telegram
          .editMessageText(
            joinInput.chatId,
            joinInput.messageId,
            undefined,
            pageText("Join Manager · Settings", infoResponse("Cancelled", "No setting was changed.")),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([
                [btn("⚙ Join Settings", `session:${session.sessionId}:join:settings`)],
                [btn("‹ Join Manager", `session:${session.sessionId}:joinmgr`)],
              ]),
            },
          )
          .catch(() => undefined);
        return;
      }
      const parsed = parseJoinSetting(joinInput.field, text, getSessionJoinSettings(session.workspaceId, session.sessionId));
      if (!parsed.patch) {
        await ctx.telegram
          .editMessageText(
            joinInput.chatId,
            joinInput.messageId,
            undefined,
            pageText(
              `${session.sessionName} · Join Settings`,
              dangerResponse(
                "Invalid Setting",
                `${escapeHtml(parsed.error ?? "The value is not valid.")}\n\nCorrect the value or send <code>cancel</code>.`,
              ),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([[btn("✖ Cancel", `session:${session.sessionId}:join:settings`)] ]),
            },
          )
          .catch(() => undefined);
        return;
      }
      const next = updateSessionJoinSettings(
        session.workspaceId,
        session.sessionId,
        parsed.patch,
      );
      pendingJoinSettingInput.delete(userId);
      const settings = next.joinSettings ?? getSessionJoinSettings(session.workspaceId, session.sessionId);
      await ctx.telegram
        .editMessageText(
          joinInput.chatId,
          joinInput.messageId,
          undefined,
          pageText(
            `${session.sessionName} · Join Settings`,
            successResponse(
              "Setting Updated",
              `<b>Target:</b> ${settings.targetCount} · <b>Delay:</b> ${Math.round(settings.delayMs / 1000)}s · <b>Min/Max:</b> ${Math.round(settings.minDelayMs / 1000)}s/${Math.round(settings.maxDelayMs / 1000)}s\n<b>Batch:</b> ${settings.batchCycles} · <b>Concurrency:</b> ${settings.maxConcurrency} · <b>Retries:</b> ${settings.retryLimit} · <b>Backoff:</b> ${Math.round(settings.retryBaseMs / 1000)}s\n<b>Cooldown:</b> ${Math.round(settings.sessionCooldownMs / 1000)}s · <b>Stop:</b> ${settings.restrictionThreshold} rate limits · <b>Mode:</b> ${escapeHtml(settings.mode.toUpperCase())}`,
            ),
          ),
          {
            parse_mode: "HTML",
            reply_markup: keyboard([
              [btn("⚙ More Settings", `session:${session.sessionId}:join:settings`)],
              [btn("‹ Join Manager", `session:${session.sessionId}:joinmgr`)],
            ]),
          },
        )
        .catch(() => undefined);
      return;
    }
    const workloadInput = pendingWorkloadKey.get(userId);
    if (workloadInput && !ctx.message.text.startsWith("/")) {
      const workloadCode = ctx.message.text.trim().toLowerCase();
      if (workloadCode === "cancel") {
        pendingWorkloadKey.delete(userId);
        await ctx.reply(pageText("Workload", infoResponse("Cancelled", "No panel was added.")), { parse_mode: "HTML", reply_markup: workloadKeyboard(false) });
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(workloadCode) && !/^\d{5}$/.test(workloadCode)) {
        await ctx.reply(pageText("Workload", dangerResponse("Use Add Workload", "Tap <b>Add Workload</b> in Telegram to receive a pairing code and the exact <code>index.js</code> file. This screen no longer accepts a permanent panel code.")), { parse_mode: "HTML" });
        return;
      }
      const ownerTelegramUserId = String(ctx.from.id);
      const worker = /^\d{5}$/.test(workloadCode)
        ? (await getWorkspaceWorkloadWorkerByDisplayKey(workloadInput.workspaceId, workloadCode))
          ?? (await getOwnerWorkloadWorkerByDisplayKey(ownerTelegramUserId, workloadCode))
        : (await getWorkspaceWorkloadWorkerByCode(workloadInput.workspaceId, workloadCode))
          ?? (await getOwnerWorkloadWorkerByCode(ownerTelegramUserId, workloadCode));
      if (!worker) {
        await ctx.reply(pageText("Workload", dangerResponse("Use Add Workload", "Start again from <b>Add Workload</b>. Telegram will create a pairing code, send <code>index.js</code>, and show where to paste the code after you click Start on your panel.")), { parse_mode: "HTML" });
        return;
      }
      if (!isWorkloadWorkerReady(worker)) {
        await ctx.reply(pageText("Workload", dangerResponse("Panel is not ready", "The worker must be ACTIVE, compatible, and have a fresh heartbeat before it can host a session.")), { parse_mode: "HTML" });
        return;
      }
      pendingWorkloadKey.delete(userId);
      preferredWorkloadWorker.set(userId, { workspaceId: worker.workspaceId, workerId: worker.workerId, workloadCode: worker.workloadCode ?? worker.displayKey, displayKey: worker.displayKey });
      await ctx.reply(workloadPanelText(worker), { parse_mode: "HTML", reply_markup: workloadPanelKeyboard(worker.workloadCode ?? worker.displayKey) });
      return;
    }
    const pairing =
      pendingPairing.get(userId) ??
      (await getPairingRequest(userId).catch(() => undefined));
    if (pairing && !ctx.message.text.startsWith("/")) {
      await handlePairingText(ctx, pairing, ctx.message.text.trim());
      return;
    }
    const supportInput = pendingSupportInput.get(userId);
    if (supportInput && !ctx.message.text.startsWith("/")) {
      await handleSupportInput(ctx, supportInput, ctx.message.text.trim());
      return;
    }
    const groupLeave = pendingGroupLeave.get(userId);
    if (groupLeave && !ctx.message.text.startsWith("/")) {
      const groupJid = ctx.message.text.trim();
      if (!/^[0-9-]+-\d+@g\.us$/.test(groupJid)) {
        await ctx.reply(
          pageText(
            "Leave Group",
            dangerResponse(
              "Invalid Group JID",
              "Send a WhatsApp group JID ending in <code>@g.us</code>.",
            ),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
      pendingGroupLeave.set(userId, { ...groupLeave, groupJid });
      await ctx.reply(
        pageText(
          "Leave Group",
          dangerResponse(
            "Confirm Destructive Action",
            `Leave <code>${escapeHtml(groupJid)}</code>? This removes the session from the group.`,
          ),
        ),
        {
          parse_mode: "HTML",
          reply_markup: keyboard([
            [
              btn(
                "⚠ Confirm Leave",
                `session:${groupLeave.sessionId}:group:leave:confirm`,
                "danger",
              ),
            ],
            [btn("Cancel", `session:${groupLeave.sessionId}:action:groups`)],
          ]),
        },
      );
      return;
    }
    const groupPicture = pendingGroupPicture.get(userId);
    if (groupPicture && !ctx.message.text.startsWith("/")) {
      pendingGroupPicture.delete(userId);
      const input = ctx.message.text.trim().split(/\s+/);
      const groupJid = groupPicture.groupJid ?? input[0];
      const imageUrl = groupPicture.groupJid ? input[0] : input[1];
      try {
        if (!groupJid || !imageUrl || !/^https:\/\//i.test(imageUrl))
          throw new Error(
            groupPicture.groupJid
              ? "Send one HTTPS image URL."
              : "Usage: send <groupJid> <https image URL>.",
          );
        await updateGroupProfilePicture(
          groupPicture.workspaceId,
          groupPicture.sessionId,
          groupJid,
          imageUrl,
        );
        await ctx.reply(
          pageText(
            "Group Picture",
            successResponse(
              "Updated",
              `<code>${escapeHtml(groupJid)}</code> profile picture updated.`,
            ),
          ),
          { parse_mode: "HTML" },
        );
      } catch (error) {
        await ctx.reply(
          pageText(
            "Group Picture",
            dangerResponse(
              "Update Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          { parse_mode: "HTML" },
        );
      }
      return;
    }
    const broadcastWorkspaceId = pendingBroadcastDelay.get(userId);
    if (broadcastWorkspaceId && !ctx.message.text.startsWith("/")) {
      pendingBroadcastDelay.delete(userId);
      const seconds = Number(ctx.message.text.trim());
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
        await ctx.reply(
          pageText(
            "Broadcast Delay",
            dangerResponse("Invalid delay", "Send a whole number from 1 to 60."),
          ),
          { parse_mode: "HTML", reply_markup: keyboard([[btn("Cancel", "settings:menu")]]) },
        );
        return;
      }
      const next = updateWorkspaceDefaults(broadcastWorkspaceId, {
        defaultBroadcastDelayMs: seconds * 1000,
      });
      await ctx.reply(
        pageText(
          "Broadcast Delay",
          successResponse(
            "Updated",
            `Allchat/allstatus delay is now <b>${Math.round(next.defaultBroadcastDelayMs / 1000)}s</b>.`,
          ),
        ),
        { parse_mode: "HTML", reply_markup: keyboard([[btn("‹ Settings", "settings:menu")]]) },
      );
      return;
    }
    const sessionSetting = pendingSessionSetting.get(userId);
    if (sessionSetting && !ctx.message.text.startsWith("/")) {
      pendingSessionSetting.delete(userId);
      const value = ctx.message.text.trim();
      const current = ownedSession(ctx, sessionSetting.sessionId);
      if (!current || !value) return;
      try {
        if (sessionSetting.action === "name")
          await updateProfileName(
            sessionSetting.workspaceId,
            sessionSetting.sessionId,
            value,
          );
        if (sessionSetting.action === "bio")
          await updateProfileBio(
            sessionSetting.workspaceId,
            sessionSetting.sessionId,
            value,
          );
        const next =
          sessionSetting.action === "prefix"
            ? updateSession(
                sessionSetting.workspaceId,
                sessionSetting.sessionId,
                { prefix: value === "none" ? "" : value.slice(0, 3) },
              )
            : current;
        await ctx.reply(
          pageText(
            `Session · ${sessionSetting.action}`,
            successResponse(
              "Updated",
              sessionSetting.action === "prefix"
                ? `Prefix is now <code>${escapeHtml(next.prefix || "none")}</code>.`
                : `${sessionSetting.action === "name" ? "Name" : "Bio"} update sent to WhatsApp.`,
            ),
          ),
          {
            parse_mode: "HTML",
            reply_markup: keyboard([
              [btn("‹ Session", `session:${sessionSetting.sessionId}:menu`)],
            ]),
          },
        );
      } catch (error) {
        await ctx.reply(
          pageText(
            `Session · ${sessionSetting.action}`,
            dangerResponse(
              "Update Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          { parse_mode: "HTML" },
        );
      }
      return;
    }
    const sessionSudo = pendingSessionSudo.get(userId);
    if (sessionSudo && !ctx.message.text.startsWith("/")) {
      pendingSessionSudo.delete(userId);
      const identity = ctx.message.text
        .trim()
        .replace(/[^0-9A-Za-z:_.@-]/g, "");
      const current = ownedSession(ctx, sessionSudo.sessionId);
      if (!current || !identity) return;
      const next =
        sessionSudo.action === "add"
          ? [...new Set([...current.sudoList, identity])]
          : current.sudoList.filter((item) => item !== identity);
      updateSession(sessionSudo.workspaceId, sessionSudo.sessionId, {
        sudoList: next,
      });
      await ctx.reply(
        pageText(
          "Session · Sudo",
          successResponse(
            sessionSudo.action === "add" ? "Sudo Added" : "Sudo Removed",
            `<code>${escapeHtml(identity)}</code> is ${sessionSudo.action === "add" ? "now authorized" : "no longer authorized"} for this session.`,
          ),
        ),
        {
          parse_mode: "HTML",
          reply_markup: keyboard([
            [btn("‹ Sudo", `session:${sessionSudo.sessionId}:sudo:list`)],
            [btn("‹ Session", `session:${sessionSudo.sessionId}:menu`)],
          ]),
        },
      );
      return;
    }
    const profilePicture = pendingProfilePicture.get(userId);
    if (profilePicture && !ctx.message.text.startsWith("/")) {
      pendingProfilePicture.delete(userId);
      try {
        await updateProfilePicture(
          profilePicture.workspaceId,
          profilePicture.sessionId,
          ctx.message.text.trim(),
        );
        await ctx.reply(
          pageText(
            "Profile Picture",
            successResponse(
              "Updated",
              "The WhatsApp profile picture was changed.",
            ),
          ),
          { parse_mode: "HTML" },
        );
      } catch (error) {
        await ctx.reply(
          pageText(
            "Profile Picture",
            dangerResponse(
              "Update Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          { parse_mode: "HTML" },
        );
      }
      return;
    }
    const groupCreate = pendingGroupCreate.get(userId);
    if (groupCreate && !ctx.message.text.startsWith("/")) {
      const input = ctx.message.text.trim();
      if (input.toLowerCase() === "cancel") {
        pendingGroupCreate.delete(userId);
        await ctx.reply(
          pageText(
            "Create Group",
            infoResponse("Cancelled", "Group creation was cancelled."),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
      if (!input) {
        await ctx.reply(
          pageText(
            "Create Group",
            dangerResponse(
              "Name Required",
              "Send a group name, then optionally send participant phone numbers separated by spaces.",
            ),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
      if (groupCreate.stage === "subject") {
        pendingGroupCreate.set(userId, {
          ...groupCreate,
          stage: "participants",
          subject: input,
        });
        await ctx.reply(
          pageText(
            "Create Group",
            infoResponse(
              "Add Participants",
              `<b>Name:</b> ${escapeHtml(input)}\nSend WhatsApp phone numbers separated by spaces, or send <code>skip</code> to create the group with only this account.`,
            ),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
      if (groupCreate.stage === "participants") {
        const participants =
          input.toLowerCase() === "skip" ? [] : input.split(/[\s,]+/u);
        pendingGroupCreate.set(userId, {
          ...groupCreate,
          stage: "description",
          participants,
        });
        await ctx.reply(
          pageText(
            "Create Group",
            infoResponse(
              "Optional Description",
              "Send the group description, or send <code>skip</code> to finish without one.",
            ),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
      pendingGroupCreate.delete(userId);
      const description = input.toLowerCase() === "skip" ? "" : input;
      try {
        const jid = await createWhatsAppGroup(
          groupCreate.workspaceId,
          groupCreate.sessionId,
          groupCreate.subject ?? "",
          groupCreate.participants ?? [],
        );
        if (description)
          await updateGroupDescription(
            groupCreate.workspaceId,
            groupCreate.sessionId,
            jid,
            description,
          );
        const invite = await getGroupInviteCode(
          groupCreate.workspaceId,
          groupCreate.sessionId,
          jid,
        ).catch(() => undefined);
        await ctx.reply(
          pageText(
            "Create Group",
            successResponse(
              "Group Created",
              `<b>${escapeHtml(groupCreate.subject ?? "")}</b>\n<code>${escapeHtml(jid)}</code>${description ? `\nDescription initialized.` : ""}${invite ? `\nInvite: <code>https://chat.whatsapp.com/${escapeHtml(invite)}</code>` : ""}\n\nThe group was created and initialized through the live WhatsApp transport.`,
            ),
          ),
          { parse_mode: "HTML" },
        );
      } catch (error) {
        await ctx.reply(
          pageText(
            "Create Group",
            dangerResponse(
              "Creation Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          { parse_mode: "HTML" },
        );
      }
      return;
    }
    const adminGlobalBridge = pendingAdminGlobalBridge.get(userId);
    if (adminGlobalBridge) {
      pendingAdminGlobalBridge.delete(userId);
      const input = text;
      if (input.toLowerCase() === "cancel") {
        const selected = adminBridgeSelections.get(userId) ?? new Set<string>();
        await ctx.telegram
          .editMessageText(
            adminGlobalBridge.chatId,
            adminGlobalBridge.messageId,
            undefined,
            adminBridgeText(activeAllSessions()),
            { parse_mode: "HTML", reply_markup: adminBridgeKeyboard(activeAllSessions(), selected) },
          )
          .catch(async () => {
            await ctx.reply(adminBridgeText(activeAllSessions()), {
              parse_mode: "HTML",
              reply_markup: adminBridgeKeyboard(activeAllSessions(), selected),
            }).catch(() => undefined);
          });
        return;
      }
      const selected = adminBridgeSelections.get(userId) ?? new Set<string>();
      const quoted = ctx.message.reply_to_message;
      const quotedText = quoted
        ? "text" in quoted
          ? quoted.text
          : "caption" in quoted
            ? quoted.caption
            : undefined
        : undefined;
      const quotedMedia = await resolveTelegramQuotedMedia(ctx).catch(() => undefined);
      const targets = activeAllSessions().filter((item) =>
        selected.has(adminBridgeTargetToken(item.workspaceId, item.sessionId)),
      );
      const results: Array<{ sessionName: string; ok: boolean; output: string }> = [];
      for (const session of targets) {
        try {
          const command = normalizeBridgeCommand(input, session.prefix);
          const routed = await routeWhatsAppText({
            workspaceId: session.workspaceId,
            sessionId: session.sessionId,
            senderJid: session.phoneNumber ?? "admin-global-bridge",
            text: command,
            ...(quotedText ? { quotedText } : {}),
            ...(quotedMedia ? { media: quotedMedia } : {}),
            bridgeAuthorized: true,
          });
          const accepted = routed !== null;
          results.push({
            sessionName: session.sessionName,
            ok: accepted,
            output: accepted
              ? typeof routed === "string"
                ? routed
                : (routed?.text ?? routed?.caption ?? "Command completed without text output.")
              : "No recognized command was dispatched to this session.",
          });
        } catch (error) {
          results.push({
            sessionName: session.sessionName,
            ok: false,
            output: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await ctx.telegram
        .editMessageText(
          adminGlobalBridge.chatId,
          adminGlobalBridge.messageId,
          undefined,
          globalBridgeResultText(input, results, userId),
          {
            parse_mode: "HTML",
            reply_markup: keyboard([
              [btn("↻ Run Another Command", "admin:bridge:command", "primary")],
              [btn("‹ Admin Global Bridge", "admin:bridge")],
            ]),
          },
        )
        .catch(async () => {
          await ctx.reply(globalBridgeResultText(input, results, userId), {
            parse_mode: "HTML",
            reply_markup: keyboard([
              [btn("↻ Run Another Command", "admin:bridge:command", "primary")],
              [btn("‹ Admin Global Bridge", "admin:bridge")],
            ]),
          }).catch(() => undefined);
        });
      return;
    }
    const adminBridge = pendingAdminBridge.get(userId);
    if (adminBridge && !ctx.message.text.startsWith("/")) {
      pendingAdminBridge.delete(userId);
      if (!isAdmin(ctx)) return deny(ctx);
      const session = activeAllSessions().find(
        (item) =>
          item.workspaceId === adminBridge.workspaceId &&
          item.sessionId === adminBridge.sessionId,
      );
      if (!session) return;
      const input = ctx.message.text.trim();
      const quoted = ctx.message.reply_to_message;
      const quotedText = quoted
        ? "text" in quoted
          ? quoted.text
          : "caption" in quoted
            ? quoted.caption
            : undefined
        : undefined;
      const quotedMedia = await resolveTelegramQuotedMedia(ctx).catch(() => undefined);
      const command = normalizeBridgeCommand(input, session.prefix);
      try {
        const result = await routeWhatsAppText({
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          senderJid: session.phoneNumber ?? "admin-bridge",
          text: command,
          ...(quotedText ? { quotedText } : {}),
          ...(quotedMedia ? { media: quotedMedia } : {}),
          bridgeAuthorized: true,
        });
        const output =
          typeof result === "string"
            ? result
            : (result?.text ??
              result?.caption ??
              "Command completed without text output.");
        recordAudit({
          workspaceId: session.workspaceId,
          actorTelegramUserId: userId,
          action: "bridge.admin.command",
          success: true,
          metadata: {
            sessionId: session.sessionId,
            command: input.slice(0, 80),
          },
        });
        await ctx.telegram
          .editMessageText(
            adminBridge.chatId,
            adminBridge.messageId,
            undefined,
            pageText(
              "Admin Bridge",
              successResponse(
                "Command Completed",
                `<b>Telegram user:</b> <code>${escapeHtml(userId)}</code>\n<b>Session:</b> ${escapeHtml(session.sessionName)}\n<pre>${escapeHtml(output.slice(0, 3500))}</pre>`,
              ),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([
                [
                  btn(
                    "↻ Run Another Command",
                    `admin:bridge:command:${session.workspaceId}:${session.sessionId}`,
                  ),
                ],
                [btn("‹ Admin Bridge", "admin:bridge")],
              ]),
            },
          )
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordAudit({
          workspaceId: session.workspaceId,
          actorTelegramUserId: userId,
          action: "bridge.admin.command",
          success: false,
          metadata: {
            sessionId: session.sessionId,
            error: message.slice(0, 160),
          },
        });
        await ctx.telegram
          .editMessageText(
            adminBridge.chatId,
            adminBridge.messageId,
            undefined,
            pageText(
              "Admin Bridge",
              dangerResponse("Command Failed", escapeHtml(message)),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([[btn("‹ Admin Bridge", "admin:bridge")]]),
            },
          )
          .catch(() => undefined);
      }
      return;
    }
    const sessionBridge = pendingSessionBridge.get(userId);
    if (sessionBridge && !ctx.message.text.startsWith("/")) {
      pendingSessionBridge.delete(userId);
      const session = ownedSession(ctx, sessionBridge.sessionId);
      if (!session || session.workspaceId !== sessionBridge.workspaceId) return;
      const input = ctx.message.text.trim();
      const quoted = ctx.message.reply_to_message;
      const quotedText = quoted
        ? "text" in quoted
          ? quoted.text
          : "caption" in quoted
            ? quoted.caption
            : undefined
        : undefined;
      const quotedMedia = await resolveTelegramQuotedMedia(ctx).catch(() => undefined);
      if (input.toLowerCase() === "cancel") {
        await ctx.telegram
          .editMessageText(
            sessionBridge.chatId,
            sessionBridge.messageId,
            undefined,
            pageText(
              "Per-Session Bridge",
              infoResponse("Cancelled", "No WhatsApp command was sent."),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([
                [btn("‹ Session", `session:${session.sessionId}:menu`)],
              ]),
            },
          )
          .catch(() => undefined);
        return;
      }
      const command = normalizeBridgeCommand(input, session.prefix);
      try {
        const result = await routeWhatsAppText({
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          senderJid: session.phoneNumber ?? "telegram-bridge",
          text: command,
          ...(quotedText ? { quotedText } : {}),
          ...(quotedMedia ? { media: quotedMedia } : {}),
          bridgeAuthorized: true,
        });
        const output =
          typeof result === "string"
            ? result
            : (result?.text ??
              result?.caption ??
              "Command completed without text output.");
        recordAudit({
          workspaceId: session.workspaceId,
          actorTelegramUserId: userId,
          action: "bridge.session.command",
          success: true,
          metadata: {
            sessionId: session.sessionId,
            command: input.slice(0, 80),
          },
        });
        await ctx.telegram
          .editMessageText(
            sessionBridge.chatId,
            sessionBridge.messageId,
            undefined,
            pageText(
              "Per-Session Bridge",
              successResponse(
                "Command Completed",
                `<b>Telegram user:</b> <code>${escapeHtml(userId)}</code>\n<b>Session:</b> ${escapeHtml(session.sessionName)}\n<pre>${escapeHtml(output.slice(0, 3500))}</pre>`,
              ),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([
                [
                  btn(
                    "↻ Run Another Command",
                    `session:${session.sessionId}:bridge:command`,
                  ),
                ],
                [btn("‹ Session", `session:${session.sessionId}:menu`)],
              ]),
            },
          )
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordAudit({
          workspaceId: session.workspaceId,
          actorTelegramUserId: userId,
          action: "bridge.session.command",
          success: false,
          metadata: {
            sessionId: session.sessionId,
            error: message.slice(0, 160),
          },
        });
        await ctx.telegram
          .editMessageText(
            sessionBridge.chatId,
            sessionBridge.messageId,
            undefined,
            pageText(
              "Per-Session Bridge",
              dangerResponse("Command Failed", escapeHtml(message)),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([
                [
                  btn(
                    "↻ Try Again",
                    `session:${session.sessionId}:bridge:command`,
                  ),
                ],
                [btn("‹ Session", `session:${session.sessionId}:menu`)],
              ]),
            },
          )
          .catch(() => undefined);
      }
      return;
    }
    const liveCodeInput = pendingLiveJobCode.get(userId);
    if (liveCodeInput && !ctx.message.text.startsWith("/")) {
      pendingLiveJobCode.delete(userId);
      const input = ctx.message.text.trim();
      if (input.toLowerCase() === "cancel") {
        await ctx.telegram
          .editMessageText(
            liveCodeInput.chatId,
            liveCodeInput.messageId,
            undefined,
            pageText(
              "Live Show",
              infoResponse("Closed", "No job code was opened."),
            ),
            {
              parse_mode: "HTML",
              reply_markup: keyboard([[btn("‹ Back", "menu:main")]]),
            },
          )
          .catch(() => undefined);
        return;
      }
      const job = await getWorkerRuntime()?.getByCode(
        liveCodeInput.workspaceId,
        input.toUpperCase(),
      );
      await ctx.telegram
        .editMessageText(
          liveCodeInput.chatId,
          liveCodeInput.messageId,
          undefined,
          jobLiveText(job),
          { parse_mode: "HTML", reply_markup: jobLiveKeyboard(job) },
        )
        .catch(() => undefined);
      if (job)
        startJobLiveLoop(
          ctx,
          liveCodeInput.workspaceId,
          input.toUpperCase(),
          liveCodeInput.chatId,
          liveCodeInput.messageId,
        );
      return;
    }
    const supportReply = pendingSupportReply.get(userId);
    if (supportReply && !ctx.message.text.startsWith("/")) {
      await handleSupportReply(
        ctx,
        supportReply.ticketId,
        ctx.message.text.trim(),
      );
      return;
    }
    const adminInput = pendingAdminInput.get(userId);
    if (adminInput === "workload:name" && !ctx.message.text.startsWith("/")) {
      pendingAdminInput.delete(userId);
      const workerName = ctx.message.text.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,31}$/.test(workerName)) {
        await ctx.reply(pageText("Workload · Name Panel", dangerResponse("Invalid workload name", "Use 2–32 letters, numbers, spaces, hyphens, or underscores. Send the name again or use /cancel.")), { parse_mode: "HTML" });
        pendingAdminInput.set(userId, "workload:name");
        return;
      }
      await deliverWorkloadPairingCode(ctx, workerName);
      return;
    }
    if (adminInput === "forcejoin:target" && !ctx.message.text.startsWith("/")) {
      await handleForceJoinTargetInput(ctx, ctx.message.text.trim());
      return;
    }
    if (adminInput === "forcejoin:name" && !ctx.message.text.startsWith("/")) {
      await handleForceJoinNameInput(ctx, ctx.message.text.trim());
      return;
    }
    if (adminInput === "forcejoin:button" && !ctx.message.text.startsWith("/")) {
      await handleForceJoinButtonInput(ctx, ctx.message.text.trim());
      return;
    }
    if (adminInput === "menu:caption" && !ctx.message.text.startsWith("/")) {
      await handleMenuCaptionInput(ctx, ctx.message.text.trim());
      return;
    }
    if (
      adminInput === "broadcast:compose" &&
      !ctx.message.text.startsWith("/")
    ) {
      const quoted = ctx.message.reply_to_message;
      const quotedText = quoted
        ? "text" in quoted
          ? quoted.text
          : "caption" in quoted
            ? quoted.caption
            : undefined
        : undefined;
      const draft = [quotedText, ctx.message.text.trim()].filter(Boolean).join("\n");
      await handleAdminBroadcastDraft(ctx, draft);
      return;
    }
    const scheduleInput = pendingScheduleInput.get(userId);
    if (scheduleInput && !ctx.message.text.startsWith("/")) {
      await handleScheduleInput(ctx, scheduleInput, ctx.message.text.trim());
      return;
    }
    if (!ctx.message.text.startsWith("/")) {
      const urls = extractWhatsAppGroupInviteUrls(ctx.message.text);
      if (urls.length) {
        const user = resolveTelegramUser(ctx);
        const collection = await collectLinks({
          workspaceId: user.workspaceId,
          text: ctx.message.text,
          sourceUserId: user.telegramUserId,
        });
        const runtime = getWorkerRuntime();
        const validationJobs = runtime
          ? await enqueueValidatorJobs(
              runtime,
              user.workspaceId,
              collection.urls,
              user.telegramUserId,
            )
          : [];
        await ctx.reply(
          pageText(
            "Validator Hub",
            validationJobs.length
              ? successResponse(
                  "Imported · Validation Started",
                  `${collection.found} WhatsApp group invite link${collection.found === 1 ? "" : "s"} found; ${collection.added} new links added to Main. ${validationJobs.length} validation worker${validationJobs.length === 1 ? "" : "s"} started automatically.`,
                )
              : warningResponse(
                  "Imported · Validation Waiting",
                  `${collection.found} WhatsApp group invite link${collection.found === 1 ? "" : "s"} found; ${collection.added} new links added to Main. No active validation session is available yet; the links remain safe in Main.`,
                ),
          ),
          { parse_mode: "HTML" },
        );
        return;
      }
    }
    const pending = pendingGlobalCommand.get(userId);
    if (!pending || ctx.message.text.startsWith("/")) return;
    const user = resolveTelegramUser(ctx);
    if (user.workspaceId !== pending.workspaceId) return;
    const selected =
      globalBridgeSelections.get(String(ctx.from?.id ?? "")) ?? new Set<string>();
    const sessions = activeWorkspaceSessions(user.workspaceId).filter((session) =>
      selected.has(session.sessionId),
    );
    if (!sessions.length) {
      pendingGlobalCommand.delete(userId);
      await ctx.telegram
        .editMessageText(
          pending.chatId,
          pending.messageId,
          undefined,
          globalBridgeResultText(ctx.message.text, [
            { sessionName: "Bridge", ok: false, output: "No selected ACTIVE session is available; no command was dispatched." },
          ]),
          { parse_mode: "HTML", reply_markup: keyboard([[btn("‹ Global Command Desk", "bridge:global")]]) },
        )
        .catch(() => undefined);
      return;
    }
    await ctx.telegram.editMessageText(
      pending.chatId,
      pending.messageId,
      undefined,
      pageText("Global Bridge · Processing", infoResponse("Command dispatched", `<b>Targets:</b> ${sessions.length} ACTIVE session${sessions.length === 1 ? "" : "s"}\n\n⏳ Waiting for transport responses…`)),
      { parse_mode: "HTML", reply_markup: keyboard([[btn("✖ Close Bridge", "bridge:global")]]) },
    ).catch(() => undefined);
    const results = await Promise.all(
      sessions.map(async (session) => {
        try {
          const command = normalizeBridgeCommand(ctx.message.text, session.prefix);
          const routed = await routeWhatsAppText({
            workspaceId: user.workspaceId,
            sessionId: session.sessionId,
            senderJid: session.phoneNumber ?? "telegram-bridge",
            text: command,
            bridgeAuthorized: true,
          });
          const accepted = routed !== null;
          const output = accepted
            ? typeof routed === "string"
              ? routed
              : (routed?.text ?? routed?.caption ?? "Command completed without text output.")
            : "No recognized command was dispatched to this session.";
          return { sessionName: session.sessionName, ok: accepted, output };
        } catch (error) {
          return {
            sessionName: session.sessionName,
            ok: false,
            output: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    pendingGlobalCommand.delete(userId);
    await ctx.telegram
      .editMessageText(
        pending.chatId,
        pending.messageId,
        undefined,
        globalBridgeResultText(ctx.message.text, results),
        {
          parse_mode: "HTML",
          reply_markup: keyboard([
            [btn("↻ Run Another Command", "bridge:global:command")],
            [btn("‹ Global Command Desk", "bridge:global")],
          ]),
        },
      )
      .catch(() => undefined);
  });

  bot.on("document", async (ctx) => {
    const document = ctx.message.document;
    const userId = String(ctx.from.id);
    const autoPromote = pendingAutoPromote.get(userId);
    if (autoPromote?.stage === "payload") {
      const file = await ctx.telegram.getFileLink(document.file_id);
      const response = await fetch(file.href);
      const media = await persistJobMedia({
        workspaceId: autoPromote.workspaceId,
        kind: "document",
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: document.mime_type ?? "application/octet-stream",
        fileName: document.file_name ?? `autopromote-${document.file_unique_id}.bin`,
      });
      const caption = ctx.message.caption ?? "";
      pendingAutoPromote.set(userId, { ...autoPromote, payloadMedia: media, payloadText: caption, payloadCaption: caption, stage: "confirm" });
      await ctx.reply(pageText("Auto Promote · Confirm", autoPromoteWizardSummary({ ...autoPromote, payloadMedia: media, payloadText: caption })), { parse_mode: "HTML", reply_markup: autoPromoteConfirmKeyboard() });
      return;
    }
    const fileName = document.file_name ?? "document.txt";
    const mimeType = document.mime_type ?? "text/plain";
    const isTextFile =
      mimeType.startsWith("text/") ||
      [
        "application/json",
        "application/ndjson",
        "application/octet-stream",
        "application/xml",
        "text/csv",
      ].includes(mimeType.toLowerCase()) ||
      /\.(txt|text|csv|tsv|log|md|json|ndjson|list|links|xml|yaml|yml)$/i.test(
        fileName,
      );
    if (!isTextFile) {
      await ctx.reply(
        "Only text-based files (.txt, .csv, .log, or .md) are supported for link intake.",
      );
      return;
    }
    const progress = await ctx.reply(
      pageText(
        "Link Intake",
        infoResponse(
          "Reading File",
          `<code>${escapeHtml(fileName)}</code> is being scanned for links.`,
        ),
      ),
      { parse_mode: "HTML" },
    );
    void (async () => {
      try {
        const file = await ctx.telegram.getFileLink(document.file_id);
        const response = await fetch(file.href);
        if (!response.ok)
          throw new Error(
            `Telegram file download failed with ${response.status}.`,
          );
        if (!response.body)
          throw new Error("Telegram file download returned no readable body.");
        const user = resolveTelegramUser(ctx);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let totalBytes = 0;
        async function* chunks(): AsyncGenerator<string> {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              totalBytes += next.value.byteLength;
              if (totalBytes > 10 * 1024 * 1024)
                throw new Error("File exceeds the 10 MB link-intake limit.");
              const text = decoder.decode(next.value, { stream: true });
              if (text) yield text;
            }
            const finalText = decoder.decode();
            if (finalText) yield finalText;
          } finally {
            reader.releaseLock();
          }
        }
        const result = await collectLinksFromChunks({
          workspaceId: user.workspaceId,
          chunks: chunks(),
          sourceUserId: user.telegramUserId,
          originalUrl: fileName,
        });
        const runtime = getWorkerRuntime();
        const validationJobs = runtime
          ? await enqueueValidatorJobs(
              runtime,
              user.workspaceId,
              result.urls,
              user.telegramUserId,
            )
          : [];
        const validationMessage = validationJobs.length
          ? `${validationJobs.length} validation worker${validationJobs.length === 1 ? "" : "s"} started automatically. Open Live Log to watch progress.`
          : "No authenticated validation session is available yet; the links remain safely in Main and will be available for validation when a session is active.";
        await ctx.telegram.editMessageText(
          progress.chat.id,
          progress.message_id,
          undefined,
          pageText(
            "Link Intake",
            result.found
              ? validationJobs.length
                ? successResponse(
                    "Imported · Validation Started",
                    `${result.found} WhatsApp group links found; ${result.added} new links added to Main.\n\n${validationMessage}`,
                  )
                : warningResponse(
                    "Imported · Validation Waiting",
                    `${result.found} WhatsApp group links found; ${result.added} new links added to Main.\n\n${validationMessage}`,
                  )
              : warningResponse(
                  "No Links Found",
                  "The file was read successfully but contained no WhatsApp group invite links.",
                ),
          ),
          { parse_mode: "HTML" },
        );
      } catch (error) {
        await ctx.telegram
          .editMessageText(
            progress.chat.id,
            progress.message_id,
            undefined,
            pageText(
              "Link Intake",
              dangerResponse(
                "File Import Failed",
                escapeHtml(
                  error instanceof Error ? error.message : String(error),
                ),
              ),
            ),
            { parse_mode: "HTML" },
          )
          .catch(() => undefined);
      }
    })();
  });
  bot.on("photo", async (ctx) => {
    const userId = String(ctx.from.id);
    const autoPromote = pendingAutoPromote.get(userId);
    if (autoPromote?.stage === "payload") {
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;
      const file = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(file.href);
      const media = await persistJobMedia({
        workspaceId: autoPromote.workspaceId,
        kind: "image",
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: "image/jpeg",
        fileName: `autopromote-${photo.file_unique_id}.jpg`,
      });
      const caption = ctx.message.caption ?? "";
      pendingAutoPromote.set(userId, {
        ...autoPromote,
        payloadMedia: media,
        payloadText: caption,
        payloadCaption: caption,
        stage: "confirm",
      });
      await ctx.reply(pageText("Auto Promote · Confirm", autoPromoteWizardSummary({ ...autoPromote, payloadMedia: media, payloadText: caption })), { parse_mode: "HTML", reply_markup: autoPromoteConfirmKeyboard() });
      return;
    }
    const profilePicture = pendingProfilePicture.get(userId);
    if (profilePicture) {
      pendingProfilePicture.delete(userId);
      try {
        const photo = ctx.message.photo.at(-1);
        if (!photo)
          throw new Error("Telegram did not provide the uploaded image.");
        const file = await ctx.telegram.getFileLink(photo.file_id);
        const response = await fetch(file.href);
        if (!response.ok)
          throw new Error(
            `Telegram image download failed (${response.status}).`,
          );
        await updateProfilePicture(
          profilePicture.workspaceId,
          profilePicture.sessionId,
          Buffer.from(await response.arrayBuffer()),
        );
        return ctx.reply(
          pageText(
            "Profile Picture",
            successResponse(
              "Updated",
              "The uploaded image is now the WhatsApp profile picture.",
            ),
          ),
          { parse_mode: "HTML" },
        );
      } catch (error) {
        return ctx.reply(
          pageText(
            "Profile Picture",
            dangerResponse(
              "Update Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          { parse_mode: "HTML" },
        );
      }
    }
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(userId);
    if (kind !== "image")
      return ctx.reply("Open Admin Panel → Media → Add Image first.");
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const file = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(file.href);
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    const media = await uploadWhatsappMenuMedia({
      workspaceId,
      fileName: `whatsapp-menu-${photo.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
    selectWhatsappMenuMedia(workspaceId, media.mediaId);
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      pageText(
        "Media Uploaded",
        successResponse(
          "Ready for WhatsApp Menu",
          `<code>${escapeHtml(media.fileName)}</code> is now available in the workspace media library.`,
        ),
      ),
      { parse_mode: "HTML", reply_markup: mediaKeyboard() },
    );
  });

  bot.on("video", async (ctx) => {
    const userId = String(ctx.from.id);
    const autoPromote = pendingAutoPromote.get(userId);
    if (autoPromote?.stage === "payload") {
      const file = await ctx.telegram.getFileLink(ctx.message.video.file_id);
      const response = await fetch(file.href);
      const media = await persistJobMedia({
        workspaceId: autoPromote.workspaceId,
        kind: "video",
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: ctx.message.video.mime_type ?? "video/mp4",
        fileName: `autopromote-${ctx.message.video.file_unique_id}.mp4`,
      });
      const caption = ctx.message.caption ?? "";
      pendingAutoPromote.set(userId, { ...autoPromote, payloadMedia: media, payloadText: caption, payloadCaption: caption, stage: "confirm" });
      await ctx.reply(pageText("Auto Promote · Confirm", autoPromoteWizardSummary({ ...autoPromote, payloadMedia: media, payloadText: caption })), { parse_mode: "HTML", reply_markup: autoPromoteConfirmKeyboard() });
      return;
    }
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "video")
      return ctx.reply("Open Admin Panel → Media → Add Video first.");
    const file = await ctx.telegram.getFileLink(ctx.message.video.file_id);
    const response = await fetch(file.href);
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    const media = await uploadWhatsappMenuMedia({
      workspaceId,
      fileName: `whatsapp-menu-${ctx.message.video.file_unique_id}.mp4`,
      mimeType: ctx.message.video.mime_type ?? "video/mp4",
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
    selectWhatsappMenuMedia(workspaceId, media.mediaId);
    pendingMedia.delete(String(ctx.from.id));
    await ctx.reply(
      pageText(
        "Media Uploaded",
        successResponse(
          "Ready for WhatsApp Menu",
          `<code>${escapeHtml(media.fileName)}</code> is now available in the workspace media library.`,
        ),
      ),
      { parse_mode: "HTML", reply_markup: mediaKeyboard() },
    );
  });

  bot.on("audio", async (ctx) => {
    const userId = String(ctx.from.id);
    const autoPromote = pendingAutoPromote.get(userId);
    if (autoPromote?.stage === "payload") {
      const file = await ctx.telegram.getFileLink(ctx.message.audio.file_id);
      const response = await fetch(file.href);
      const media = await persistJobMedia({
        workspaceId: autoPromote.workspaceId,
        kind: "audio",
        bytes: Buffer.from(await response.arrayBuffer()),
        mimeType: ctx.message.audio.mime_type ?? "audio/mpeg",
        fileName: ctx.message.audio.file_name ?? `autopromote-${ctx.message.audio.file_unique_id}.audio`,
      });
      const caption = ctx.message.caption ?? "";
      pendingAutoPromote.set(userId, { ...autoPromote, payloadMedia: media, payloadText: caption, payloadCaption: caption, stage: "confirm" });
      await ctx.reply(pageText("Auto Promote · Confirm", autoPromoteWizardSummary({ ...autoPromote, payloadMedia: media, payloadText: caption })), { parse_mode: "HTML", reply_markup: autoPromoteConfirmKeyboard() });
      return;
    }
    await ctx.reply("Audio is accepted by Auto Promote only while its payload step is open.");
  });

  bot.action("menu:main", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(
      ctx,
      dashboardText(isAdmin(ctx)),
      dashboardKeyboard(isAdmin(ctx)),
    );
  });
  bot.action("home", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(
      ctx,
      dashboardText(isAdmin(ctx)),
      dashboardKeyboard(isAdmin(ctx)),
    );
  });
  bot.action("help:main", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, helpText(), keyboard([[btn(ui.back, "menu:main")]]));
  });
  bot.action("ui:help", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, helpText(), keyboard([[btn(ui.back, "menu:main")]]));
  });

  bot.action("session:new", async (ctx) => {
    await ctx.answerCbQuery();
    await beginPairingWizard(ctx);
  });
  bot.action(/^pair:workload:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const token = ctx.match[1] ?? "";
    const worker = /^\d{5}$/.test(token)
      ? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, token)
      : await getWorkspaceWorkloadWorkerByCode(user.workspaceId, token);
    if (!worker || !isWorkloadWorkerReady(worker)) {
      await edit(ctx, pageText("Pairing", dangerResponse("Workload is not ready", "Choose an ACTIVE workload with a fresh heartbeat.")), keyboard([[btn("◌ Workload", "workload:menu")], [btn(ui.back, "menu:main")]]));
      return;
    }
    const code = worker.workloadCode ?? worker.displayKey;
    preferredWorkloadWorker.set(String(ctx.from?.id ?? ""), { workspaceId: worker.workspaceId, workerId: worker.workerId, workloadCode: code, displayKey: worker.displayKey });
    await beginPairingWizard(ctx, true);
  });
  bot.action("pair:local", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    if (await getWorkloadMode(user.workspaceId) === "OFF") {
      await edit(ctx, pageText("Pairing", dangerResponse("Central workload is OFF", "Deploy or select an external panel workload to pair this WhatsApp session. Your existing sessions are preserved.")), keyboard([[btn("◌ Workload Panels", "workload:menu")], [btn(ui.back, "menu:main")]]));
      return;
    }
    preferredWorkloadWorker.delete(String(ctx.from?.id ?? ""));
    await beginPairingWizard(ctx, true);
  });
  bot.action(/^pair:number:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    savePendingPairing(String(ctx.from?.id ?? ""), {
      stage: "phone",
      chatId: ctx.chat?.id ?? 0,
      sessionId: session.sessionId,
    });
    await edit(
      ctx,
      pageText(
        "Phone Number",
        infoResponse(
          "Pairing Input",
          `Send the full WhatsApp number for <b>${escapeHtml(session.sessionName)}</b> in international format, for example <code>2348012345678</code>.`,
        ),
      ),
      keyboard([[btn(ui.back, `session:${session.sessionId}:menu`)]]),
    );
  });

  bot.action(/^sessions:list(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery();
    await sendSessions(ctx, Number(ctx.match[1] ?? 0));
  });
  bot.action(/^sessions:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await sendSessions(ctx, Number(ctx.match[1] ?? 0));
  });

  bot.action(/^session:([^:]+):groups(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery("Loading groups…");
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await showSessionGroups(ctx, session.sessionId, Number(ctx.match[2] ?? 0));
  });

  bot.action(/^session:([^:]+):menu$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      await renderSessionOverview(ctx, session),
      sessionKeyboard(session, isAdmin(ctx)),
    );
  });
  bot.action(
    /^session:([^:]+):section:(overview|tools|groups|bridge|validator|join|health|settings|access)$/,
    async (ctx) => {
      await ctx.answerCbQuery();
      const session = ownedSession(ctx, ctx.match[1] ?? "");
      if (!session) return deny(ctx);
      const section = ctx.match[2] ?? "overview";
      if (section === "overview")
        return edit(
          ctx,
          await renderSessionOverview(ctx, session),
          sessionKeyboard(session, isAdmin(ctx)),
        );
      if (section === "groups")
        return showSessionGroups(ctx, session.sessionId);
      if (section === "bridge")
        return showSessionBridge(ctx, session.sessionId);
      if (section === "join") return showJoinManager(ctx, session.sessionId);
      if (section === "health")
        return showSessionHealth(ctx, session.sessionId);
      if (section === "access") {
        if (!isAdmin(ctx)) return deny(ctx);
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · Access`,
            infoResponse(
              "Session Access Control",
              "Sudo identities are isolated to this WhatsApp session. Workspace owner/admin checks still apply to this panel.",
            ),
          ),
          sessionAccessKeyboard(session.sessionId),
        );
      }
      if (section === "validator")
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · Validator Hub`,
            infoResponse(
              "Automatic Link Pipeline",
              `<b>Collection:</b> automatic\n<b>Validation:</b> automatic\n<b>Collected:</b> ${session.collectedLinkCount ?? 0}\n<b>Validated:</b> ${session.validatedLinkCount ?? 0}\n\nOpen the workspace Hub for the live same-message validation dashboard.`,
            ),
          ),
          sessionValidatorKeyboard(session.sessionId),
        );
      if (section === "settings")
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · Settings`,
            infoResponse(
              "Session Runtime Settings",
              `<b>Auto-join:</b> ${session.autoJoinEnabled ? "ON" : "OFF"}\n<b>Prefix:</b> <code>${escapeHtml(session.prefix || "none")}</code>\n<b>Validator:</b> AUTO\n\nChanges here are applied in place and return to this session control plane.`,
            ),
          ),
          sessionSettingsKeyboard(session.sessionId, session.autoJoinEnabled),
        );
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Tools`,
          infoResponse(
            "WhatsApp Operations",
            "Profile, media, group creation, group picture, and identity controls are isolated to this session.",
          ),
        ),
        sessionToolsKeyboard(session.sessionId),
      );
    },
  );
  bot.action(/^session:view:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      await renderSessionOverview(ctx, session),
      sessionKeyboard(session, isAdmin(ctx)),
    );
  });
  bot.action(/^session:([^:]+):purge:confirm$/, async (ctx) => {
    await ctx.answerCbQuery("Purging session…");
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const user = resolveTelegramUser(ctx);
    try {
      const purged = await purgeWhatsAppSession(
        user.workspaceId,
        session.sessionId,
      );
      await recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "session.purge",
        success: true,
        metadata: {
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          jobs: purged.jobs,
          links: purged.links,
          traces: purged.traces,
        },
      });
      await edit(
        ctx,
        pageText(
          "Session Purged",
          successResponse(
            purged.remoteCleanup === "CONFIRMED" ? "Encrypted Auth Removed" : "Central Purge Completed",
            `Session <b>${escapeHtml(session.sessionName)}</b> was stopped and removed from the control plane.\n\n<b>Deleted:</b> ${purged.jobs} jobs · ${purged.links} collected links · ${purged.traces} message traces · ${purged.remoteCleanup === "CONFIRMED" ? "panel encrypted auth" : "central auth record"}\n\n${purged.remoteCleanup === "CONFIRMED" ? "Panel auth was confirmed removed." : "The panel was unreachable, so its auth directory could not be confirmed removed; the assignment was revoked and it cannot reconnect this session."}\n\nYou can create a new session from Sessions.`,
          ),
        ),
        keyboard([[btn("‹ Sessions", "sessions:list:0", "success")]]),
      );
    } catch (error) {
      await recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "session.purge",
        success: false,
        metadata: {
          sessionId: session.sessionId,
          error: String(error).slice(0, 240),
        },
      });
      await edit(
        ctx,
        pageText(
          "Purge Failed",
          dangerResponse(
            "Session Not Purged",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
      );
    }
  });
  bot.action(/^session:([^:]+):pfp:(get|remove|change)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const action = ctx.match[2] ?? "get";
    try {
      if (action === "get") {
        const url = await getProfilePictureUrl(
          session.workspaceId,
          session.sessionId,
        );
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · PFP`,
            infoResponse(
              "Current Profile Picture",
              url
                ? `<a href="${escapeHtml(url)}">Open profile picture</a>`
                : "No profile picture is set.",
            ),
          ),
          keyboard([
            [btn("✎ Change URL", `session:${session.sessionId}:pfp:change`)],
            [
              btn(
                "🗑 Remove",
                `session:${session.sessionId}:pfp:remove`,
                "danger",
              ),
            ],
            [btn("‹ Session", `session:${session.sessionId}:menu`)],
          ]),
        );
      }
      if (action === "remove") {
        await removeProfilePicture(session.workspaceId, session.sessionId);
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · PFP`,
            successResponse("Removed", "The profile picture was removed."),
          ),
          keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
        );
      }
      pendingProfilePicture.set(String(ctx.from?.id ?? ""), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
      });
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · PFP`,
          infoResponse(
            "Change Profile Picture",
            "Send the actual photo here. The next uploaded image updates this WhatsApp profile picture; an HTTPS image URL is supported only as a fallback.",
          ),
        ),
        keyboard([[btn("Cancel", `session:${session.sessionId}:action:pfp`)]]),
      );
    } catch (error) {
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · PFP`,
          dangerResponse(
            "Operation Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
      );
    }
  });
  bot.action(/^session:([^:]+):group:view:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    const index = Number(ctx.match[2] ?? -1);
    try {
      const group = await getSessionGroupAt(ctx, session.sessionId, index);
      if (!group) return showSessionGroups(ctx, session.sessionId);
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Group Detail`,
          infoResponse(
            "Group Control Surface",
            `<b>Subject:</b> ${escapeHtml(group.subject)}\n<b>JID:</b> <code>${escapeHtml(group.jid)}</code>\n<b>Members:</b> ${group.participantCount}\n\nChoose one action for this group.`,
          ),
        ),
        keyboard([
          [
            btn(
              "🔗 Invite Link",
              `session:${session.sessionId}:group:invite:${index}`,
            ),
            btn(
              "▣ Group Picture",
              `session:${session.sessionId}:group:picture:${index}`,
            ),
          ],
          [
            btn(
              "↪ Leave Group",
              `session:${session.sessionId}:group:leave:${index}`,
              "danger",
            ),
          ],
          [btn("‹ My Groups", `session:${session.sessionId}:section:groups`)],
        ]),
      );
    } catch (error) {
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Group Detail`,
          dangerResponse(
            "Group Read Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        keyboard([
          [btn("‹ My Groups", `session:${session.sessionId}:section:groups`)],
        ]),
      );
    }
  });
  bot.action(/^session:([^:]+):group:invite:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Resolving invite…");
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    const index = Number(ctx.match[2] ?? -1);
    try {
      const group = await getSessionGroupAt(ctx, session.sessionId, index);
      if (!group) return showSessionGroups(ctx, session.sessionId);
      const code = await getGroupInviteCode(
        session.workspaceId,
        session.sessionId,
        group.jid,
      );
      const link = `https://chat.whatsapp.com/${code}`;
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Invite Link`,
          successResponse(
            "Invite Ready",
            `<b>Group:</b> ${escapeHtml(group.subject)}\n<code>${escapeHtml(link)}</code>`,
          ),
        ),
        keyboard([
          [copyBtn("📋 Copy Invite Link", link, "success")],
          [
            btn(
              "‹ Group Detail",
              `session:${session.sessionId}:group:view:${index}`,
            ),
          ],
        ]),
      );
    } catch (error) {
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Invite Link`,
          dangerResponse(
            "Invite Unavailable",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        keyboard([
          [btn("‹ My Groups", `session:${session.sessionId}:section:groups`)],
        ]),
      );
    }
  });
  bot.action(/^session:([^:]+):group:picture:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    const index = Number(ctx.match[2] ?? -1);
    const group = await getSessionGroupAt(ctx, session.sessionId, index).catch(
      () => undefined,
    );
    if (!group) return showSessionGroups(ctx, session.sessionId);
    pendingGroupPicture.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      groupJid: group.jid,
    });
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Group Picture`,
        infoResponse(
          "Change Group Picture",
          `<b>Group:</b> ${escapeHtml(group.subject)}\nSend one HTTPS image URL. The original image bytes are sent to WhatsApp without bot-side cropping.`,
        ),
      ),
      keyboard([
        [btn("Cancel", `session:${session.sessionId}:group:view:${index}`)],
      ]),
    );
  });
  bot.action(/^session:([^:]+):group:leave:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    const index = Number(ctx.match[2] ?? -1);
    const group = await getSessionGroupAt(ctx, session.sessionId, index).catch(
      () => undefined,
    );
    if (!group) return showSessionGroups(ctx, session.sessionId);
    pendingGroupLeave.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      groupJid: group.jid,
    });
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Leave Group`,
        dangerResponse(
          "Confirm Destructive Action",
          `Leave <b>${escapeHtml(group.subject)}</b>?\n<code>${escapeHtml(group.jid)}</code>`,
        ),
      ),
      keyboard([
        [
          btn(
            "⚠ Confirm Leave",
            `session:${session.sessionId}:group:leave:confirm`,
            "danger",
          ),
        ],
        [btn("Cancel", `session:${session.sessionId}:group:view:${index}`)],
      ]),
    );
  });
  bot.action(/^session:([^:]+):group:leave:confirm$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    const actor = String(ctx.from?.id ?? "");
    const pending = pendingGroupLeave.get(actor);
    if (!pending?.groupJid || pending.sessionId !== session.sessionId)
      return deny(ctx);
    pendingGroupLeave.delete(actor);
    try {
      await leaveWhatsAppGroup(
        session.workspaceId,
        session.sessionId,
        pending.groupJid,
      );
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Groups`,
          successResponse(
            "Left Group",
            `<code>${escapeHtml(pending.groupJid)}</code>`,
          ),
        ),
        keyboard([
          [
            btn(
              "↻ Refresh Groups",
              `session:${session.sessionId}:action:groups`,
            ),
          ],
          [btn("‹ Session", `session:${session.sessionId}:menu`)],
        ]),
      );
    } catch (error) {
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Groups`,
          dangerResponse(
            "Leave Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
      );
    }
  });
  bot.action(/^session:([^:]+):group:leave$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, String(ctx.match[1] ?? ""));
    if (!session) return deny(ctx);
    pendingGroupLeave.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
    return edit(
      ctx,
      pageText(
        `${session.sessionName} · Leave Group`,
        infoResponse(
          "Select Group",
          "Send the group JID ending in <code>@g.us</code>. A confirmation step is required before leaving.",
        ),
      ),
      keyboard([[btn("Cancel", `session:${session.sessionId}:action:groups`)]]),
    );
  });
  bot.action(/^session:([^:]+):sudo:(list|add|remove)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return deny(ctx);
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const action = ctx.match[2] ?? "list";
    if (action === "list") {
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Sudo`,
          infoResponse(
            "Session Sudo",
            session.sudoList.length
              ? session.sudoList
                  .map((item) => `<code>${escapeHtml(item)}</code>`)
                  .join("\n")
              : "No session sudo identities are configured.",
          ),
        ),
        keyboard([
          [
            btn(
              "＋ Add Identity",
              `session:${session.sessionId}:sudo:add`,
              "success",
            ),
            btn(
              "− Remove Identity",
              `session:${session.sessionId}:sudo:remove`,
              "danger",
            ),
          ],
          [btn("↻ Refresh", `session:${session.sessionId}:sudo:list`)],
          [btn("‹ Session", `session:${session.sessionId}:menu`)],
        ]),
      );
    }
    pendingSessionSudo.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      action: action as "add" | "remove",
    });
    return edit(
      ctx,
      pageText(
        `${session.sessionName} · Sudo`,
        infoResponse(
          action === "add" ? "Add Sudo Identity" : "Remove Sudo Identity",
          "Send a WhatsApp identity/JID now, for example <code>2348012345678@s.whatsapp.net</code>.",
        ),
      ),
      keyboard([
        [btn("Cancel", `session:${session.sessionId}:sudo:list`)],
        [btn("‹ Session", `session:${session.sessionId}:menu`)],
      ]),
    );
  });
  bot.action(/^session:([^:]+):auto:(collect|validate)$/, async (ctx) => {
    await ctx.answerCbQuery("Automation is always ON");
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Validator Hub`,
        successResponse(
          "Automation Always ON",
          `<b>Link collection:</b> automatic\n<b>Link validation:</b> automatic\n<b>Collected:</b> ${session.collectedLinkCount ?? 0}\n<b>Validated:</b> ${session.validatedLinkCount ?? 0}`,
        ),
      ),
      sessionKeyboard(session, isAdmin(ctx)),
    );
  });
  bot.action(/^session:([^:]+):action:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const action = ctx.match[2] ?? "";
    if (action === "sudo" && !isAdmin(ctx)) return deny(ctx);
    if (action === "bridge") return showSessionBridge(ctx, session.sessionId);
    if (action === "reconnect") {
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Reconnect`,
          infoResponse(
            "Transport Recovery",
            "Stopping the current WhatsApp socket, reopening the persisted authentication, and waiting for a verified ACTIVE state. No session data is deleted.",
          ),
        ),
        keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
      );
      try {
        const ready = await restartWhatsAppSession(
          session.workspaceId,
          session.sessionId,
        );
        const refreshed = getSession(session.workspaceId, session.sessionId);
        return edit(
          ctx,
          pageText(
            `${refreshed.sessionName} · Reconnect`,
            ready
              ? successResponse(
                  "WhatsApp Reconnected",
                  `<b>Status:</b> ${escapeHtml(effectiveSessionStatus(refreshed))}\n<b>Auth:</b> ${escapeHtml(refreshed.authHealth ?? "UNKNOWN")}\n\nThe persisted session is online again and ready for transport-backed commands.`,
                )
              : dangerResponse(
                  "Recovery Still In Progress",
                  `The socket did not reach verified ACTIVE state within the recovery window. Saved authentication was preserved; the lifecycle supervisor will continue recovery.\n\n<b>Status:</b> ${escapeHtml(effectiveSessionStatus(refreshed))}\n<b>Reason:</b> ${escapeHtml(refreshed.disconnectReason ?? "transport recovery pending")}`,
                ),
          ),
          keyboard([
            [btn("↻ Try Reconnect Again", `session:${session.sessionId}:action:reconnect`, "primary")],
            [btn("‹ Session", `session:${session.sessionId}:menu`)],
          ]),
        );
      } catch (error) {
        return edit(
          ctx,
          pageText(
            `${session.sessionName} · Reconnect`,
            dangerResponse(
              "Recovery Request Failed",
              `The saved session was not purged. The transport supervisor may retry automatically.\n\n<code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code>`,
            ),
          ),
          keyboard([
            [btn("↻ Try Again", `session:${session.sessionId}:action:reconnect`, "primary")],
            [btn("‹ Session", `session:${session.sessionId}:menu`)],
          ]),
        );
      }
    }
    if (action === "join") return showJoinManager(ctx, session.sessionId);
    if (action === "groups") return showSessionGroups(ctx, session.sessionId);
    if (action === "health") return showSessionHealth(ctx, session.sessionId);
    if (action === "gpp") {
      pendingGroupPicture.set(String(ctx.from?.id ?? ""), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
      });
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Group Picture`,
          infoResponse(
            "Change Group Picture",
            "Send the group JID followed by an HTTPS image URL, separated by a space.",
          ),
        ),
        keyboard([[btn("Cancel", `session:${session.sessionId}:menu`)]]),
      );
    }
    if (action === "profile")
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Profile`,
          infoResponse(
            "Account Profile",
            `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Phone:</b> ${escapeHtml(session.phoneNumber ?? "not paired")}\n<b>Status:</b> ${escapeHtml(session.status)}\n<b>Prefix:</b> <code>${escapeHtml(session.prefix || "none")}</code>\n<b>Auto-join:</b> ${session.autoJoinEnabled ? "ON" : "OFF"}`,
          ),
        ),
        keyboard([
          [
            btn("PFP", `session:${session.sessionId}:action:pfp`),
            btn("Name", `session:${session.sessionId}:action:name`),
          ],
          [
            btn("Bio", `session:${session.sessionId}:action:bio`),
            btn("Prefix", `session:${session.sessionId}:action:prefix`),
          ],
          [btn("‹ Session", `session:${session.sessionId}:menu`)],
        ]),
      );
    if (["name", "bio", "prefix"].includes(action)) {
      pendingSessionSetting.set(String(ctx.from?.id ?? ""), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        action: action as "name" | "bio" | "prefix",
      });
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · ${action}`,
          infoResponse(
            "Send New Value",
            action === "prefix"
              ? "Send a prefix up to 3 characters, or <code>none</code> for prefixless mode."
              : `Send the new WhatsApp ${action}.`,
          ),
        ),
        keyboard([[btn("Cancel", `session:${session.sessionId}:menu`)]]),
      );
    }
    if (action === "autojoin") {
      const next = updateSession(session.workspaceId, session.sessionId, {
        autoJoinEnabled: !session.autoJoinEnabled,
      });
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Auto-join`,
          successResponse(
            "Setting Updated",
            `Automatic invite-link joining is now <b>${next.autoJoinEnabled ? "ON" : "OFF"}</b>.`,
          ),
        ),
        keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
      );
    }
    if (action === "sudo")
      return isAdmin(ctx)
        ? edit(
            ctx,
            pageText(
              `${session.sessionName} · Sudo`,
              infoResponse(
                "Session Sudo",
                "Manage the WhatsApp identities allowed to issue commands through this session.",
              ),
            ),
            keyboard([
              [
                btn("◉ List", `session:${session.sessionId}:sudo:list`),
                btn(
                  "＋ Add",
                  `session:${session.sessionId}:sudo:add`,
                  "success",
                ),
              ],
              [
                btn(
                  "− Remove",
                  `session:${session.sessionId}:sudo:remove`,
                  "danger",
                ),
              ],
              [btn("‹ Session", `session:${session.sessionId}:menu`)],
            ]),
          )
        : deny(ctx);
    if (action === "pfp")
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · PFP`,
          infoResponse(
            "Profile Picture Controls",
            "Get the current picture, send a real photo or HTTPS image URL to change it, or remove it.",
          ),
        ),
        keyboard([
          [
            btn("◉ Get", `session:${session.sessionId}:pfp:get`, "primary"),
            btn(
              "✎ Change",
              `session:${session.sessionId}:pfp:change`,
              "success",
            ),
          ],
          [
            btn(
              "🗑 Remove",
              `session:${session.sessionId}:pfp:remove`,
              "danger",
            ),
          ],
          [btn("‹ Session", `session:${session.sessionId}:menu`)],
        ]),
      );
    if (action === "creategroup") {
      pendingGroupCreate.set(String(ctx.from?.id ?? ""), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        stage: "subject",
      });
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Create Group`,
          infoResponse(
            "Group Composer",
            "Send the group name followed by optional participant JIDs separated by spaces.",
          ),
        ),
        keyboard([
          [
            btn("Cancel", `session:${session.sessionId}:menu`),
            btn("‹ Session", `session:${session.sessionId}:menu`),
          ],
        ]),
      );
    }
    if (action === "purge")
      return edit(
        ctx,
        pageText(
          `${session.sessionName} · Purge Session`,
          dangerResponse(
            "Permanent Session Removal",
            "This stops the WhatsApp connection, deletes this session’s encrypted authentication files, removes its durable record, and cannot be undone. Your other sessions are unaffected.",
          ),
        ),
        keyboard([
          [
            btn(
              "⚠ Confirm Purge Session",
              `session:${session.sessionId}:purge:confirm`,
              "danger",
            ),
          ],
          [btn("Cancel", `session:${session.sessionId}:menu`)],
        ]),
      );
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · ${action}`,
        infoResponse(
          "Session Action",
          `The <code>${escapeHtml(action)}</code> action is scoped to this session. Continue with the guided input or use the matching WhatsApp shortcut.`,
        ),
      ),
      keyboard([
        [btn("↻ Session", `session:${session.sessionId}:menu`)],
        [btn("‹ Sessions", "sessions:list:0")],
      ]),
    );
  });

  bot.action("bridge:global", async (ctx) => {
    await ctx.answerCbQuery();
    await showGlobalBridge(ctx);
  });
  bot.action("ui:bridge", async (ctx) => {
    await ctx.answerCbQuery();
    await showGlobalBridge(ctx);
  });
  bot.action("bridge:global:select", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const selected = globalBridgeSelections.get(String(ctx.from?.id ?? "")) ?? new Set<string>();
    await edit(
      ctx,
      pageText(
        "Global Bridge · Choose Sessions",
        infoResponse("Active Session Bridge", "Select the ACTIVE WhatsApp sessions that should receive the next command, then press Send Command."),
      ),
      bridgeSessionPicker(activeWorkspaceSessions(user.workspaceId), selected),
    );
  });
  bot.action("bridge:global:select:all", async (ctx) => {
    await ctx.answerCbQuery("All ACTIVE sessions selected");
    const user = resolveTelegramUser(ctx);
    const active = activeWorkspaceSessions(user.workspaceId);
    globalBridgeSelections.set(String(ctx.from?.id ?? ""), new Set(active.map((session) => session.sessionId)));
    await edit(
      ctx,
      pageText("Global Bridge · Choose Sessions", infoResponse("All ACTIVE Sessions Selected", `${active.length} ACTIVE session${active.length === 1 ? "" : "s"} selected.`)),
      bridgeSessionPicker(active, new Set(active.map((session) => session.sessionId))),
    );
  });
  bot.action(/^bridge:global:toggle:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session || !isBridgeReadySession(session)) {
      await ctx.answerCbQuery("Only ACTIVE sessions can be bridged.", { show_alert: true });
      return;
    }
    const selected = globalBridgeSelections.get(String(ctx.from?.id ?? "")) ?? new Set<string>();
    if (selected.has(session.sessionId)) selected.delete(session.sessionId);
    else selected.add(session.sessionId);
    globalBridgeSelections.set(String(ctx.from?.id ?? ""), selected);
    await edit(
      ctx,
      pageText("Global Bridge · Choose Sessions", infoResponse("Selection Updated", `${selected.size} ACTIVE session${selected.size === 1 ? "" : "s"} selected.`)),
      bridgeSessionPicker(activeWorkspaceSessions(user.workspaceId), selected),
    );
  });
  bot.action("bridge:global:clear", async (ctx) => {
    await ctx.answerCbQuery("Selection cleared");
    globalBridgeSelections.delete(String(ctx.from?.id ?? ""));
    await showGlobalBridge(ctx);
  });
  bot.action("bridge:global:command", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const active = activeWorkspaceSessions(user.workspaceId);
    const selected = globalBridgeSelections.get(String(ctx.from?.id ?? "")) ?? new Set<string>();
    for (const id of [...selected])
      if (!active.some((session) => session.sessionId === id)) selected.delete(id);
    if (!selected.size)
      return edit(ctx, globalBridgeText(0, false), bridgeSessionPicker(active, selected));
    const message = ctx.callbackQuery?.message;
    const chatId = ctx.chat?.id;
    if (!message || !("message_id" in message) || !chatId) return;
    pendingGlobalCommand.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
      chatId,
      messageId: message.message_id,
    });
    await edit(
      ctx,
      globalBridgeText(selected.size, true).replace("</blockquote>", "\n\n✍️ Send one WhatsApp command now.</blockquote>"),
      keyboard([[btn("✖ Close Bridge", "bridge:global")]]),
    );
  });
  // Compatibility routes for old messages: the new Bridge has no start/stop protocol.
  for (const action of ["bridge:global:toggle", "bridge:global:start", "bridge:global:stop"] as const) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      if (action === "bridge:global:stop") {
        globalBridgeSelections.delete(String(ctx.from?.id ?? ""));
        pendingGlobalCommand.delete(String(ctx.from?.id ?? ""));
      }
      await showGlobalBridge(ctx);
    });
  }

  bot.action("bucket:user:active", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(
      ctx,
      pageText(
        "Active Links",
        infoResponse(
          "Shared verified bucket",
          "These links are centrally validated and shared across Join Manager sessions. Choose a download format.",
        ),
      ),
      keyboard([
        [btn("⬇ Active · TXT", "bucket:user:download:active:txt")],
        [btn("⬇ Active · HTML", "bucket:user:download:active:html")],
        [btn(ui.back, "menu:main")],
      ]),
    );
  });
  bot.action(/^bucket:user:download:active:(txt|html)$/, async (ctx) => {
    await ctx.answerCbQuery("Preparing verified Active export…");
    const user = resolveTelegramUser(ctx);
    const format = (ctx.match[1] ?? "txt") as "txt" | "html";
    try {
      const exported = await exportBucket(user.workspaceId, "active", format);
      await ctx.replyWithDocument({
        source: Buffer.from(exported.content, "utf8"),
        filename: exported.fileName,
      });
    } catch (error) {
      await ctx.reply(
        pageText(
          "Active Links",
          dangerResponse(
            "Export Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        { parse_mode: "HTML" },
      );
    }
  });
  bot.action("bucket:status", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showValidatorHub(ctx);
  });
  bot.action("bucket:validate", async (ctx) => {
    await ctx.answerCbQuery("Starting centralized validation…");
    if (!requireAdmin(ctx)) return;
    try {
      await runValidatorSweepNow();
      await showValidatorHub(ctx);
    } catch (error) {
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          dangerResponse(
            "Validation Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        bucketKeyboard(),
      );
    }
  });

  bot.action("ui:validator", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showValidatorHub(ctx);
  });
  bot.action("bucket:live", async (ctx) => {
    await ctx.answerCbQuery("Opening live log…");
    if (!requireAdmin(ctx)) return;
    await showValidatorLiveLog(ctx, true);
  });
  bot.action("bucket:live:on", async (ctx) => {
    await ctx.answerCbQuery("Live log resumed");
    if (!requireAdmin(ctx)) return;
    await showValidatorLiveLog(ctx, true);
  });
  bot.action("bucket:live:off", async (ctx) => {
    await ctx.answerCbQuery("Live log stopped");
    if (!requireAdmin(ctx)) return;
    await showValidatorLiveLog(ctx, false);
  });
  bot.action("bucket:live:refresh", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showValidatorLiveLog(ctx, true);
  });
  bot.action("bucket:downloads", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await edit(
      ctx,
      pageText(
        "Validator Hub · Downloads",
        infoResponse(
          "Choose Bucket and Format",
          "Exports are generated from the current Redis-backed inventory.",
        ),
      ),
      keyboard([
        [
          btn("Main · TXT", "bucket:download:main:txt"),
          btn("Main · HTML", "bucket:download:main:html"),
        ],
        [
          btn("Validating · TXT", "bucket:download:validating:txt"),
          btn("Validating · HTML", "bucket:download:validating:html"),
        ],
        [
          btn("Active · TXT", "bucket:download:active:txt"),
          btn("Active · HTML", "bucket:download:active:html"),
        ],
        [
          btn("Dead · TXT", "bucket:download:dead:txt"),
          btn("Dead · HTML", "bucket:download:dead:html"),
        ],
        [
          btn("Error · TXT", "bucket:download:error:txt"),
          btn("Error · HTML", "bucket:download:error:html"),
        ],
        [btn("‹ Validator Hub", "bucket:status")],
      ]),
    );
  });
  bot.action(
    /^bucket:download:(main|validating|active|dead|error):(txt|html)$/,
    async (ctx) => {
      await ctx.answerCbQuery("Preparing export…");
      if (!requireAdmin(ctx)) return;
      const user = resolveTelegramUser(ctx);
      const bucket = (ctx.match[1] ?? "main") as ValidatorBucket;
      const format = (ctx.match[2] ?? "txt") as "txt" | "html";
      try {
        const exported = await exportBucket(user.workspaceId, bucket, format);
        await ctx.replyWithDocument({
          source: Buffer.from(exported.content, "utf8"),
          filename: exported.fileName,
        });
        recordAudit({
          workspaceId: user.workspaceId,
          actorTelegramUserId: String(ctx.from?.id ?? ""),
          action: "validator.bucket.export",
          success: true,
          metadata: { bucket, format },
        });
        await showValidatorHub(ctx);
      } catch (error) {
        recordAudit({
          workspaceId: user.workspaceId,
          actorTelegramUserId: String(ctx.from?.id ?? ""),
          action: "validator.bucket.export",
          success: false,
          metadata: { bucket, format, error: String(error).slice(0, 160) },
        });
        await edit(
          ctx,
          pageText(
            "Validator Hub",
            dangerResponse(
              "Export Failed",
              escapeHtml(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
          bucketKeyboard(),
        );
      }
    },
  );
  bot.action(/^bucket:view:(main|validating|active|dead|error)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const bucket = (ctx.match[1] ?? "main") as ValidatorBucket;
    try {
      const records = await listValidatorBucket(GLOBAL_VALIDATOR_SCOPE, bucket, 30);
      const body = records.length
        ? records
            .map(
              (record, index) =>
                `${index + 1}. <code>${escapeHtml(record.canonicalUrl.slice(0, 100))}</code>\n   <i>${escapeHtml(record.bucket)} · checked ${record.lastCheckedAt ? new Date(record.lastCheckedAt).toISOString() : "not checked"}</i>`,
            )
            .join("\n")
        : "This bucket is empty.";
      await edit(
        ctx,
        pageText(
          `Validator Hub · ${bucket}`,
          infoResponse(
            `${bucket.toUpperCase()} · ${records.length} shown`,
            body,
          ),
        ),
        keyboard([
          [
            btn("⬇ TXT", `bucket:download:${bucket}:txt`),
            btn("⬇ HTML", `bucket:download:${bucket}:html`),
          ],
          [btn("↻ Refresh", `bucket:view:${bucket}`)],
          [btn("‹ Validator Hub", "bucket:status")],
        ]),
      );
    } catch (error) {
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          dangerResponse(
            "Bucket Read Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        bucketKeyboard(),
      );
    }
  });
  bot.action("bucket:merge:main", async (ctx) => {
    await ctx.answerCbQuery("Merging active and error links…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    try {
      const moved = await mergeValidatorBuckets(user.workspaceId);
      recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "validator.bucket.merge",
        success: true,
        metadata: { moved },
      });
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          successResponse(
            "Merge Complete",
            `${moved} link${moved === 1 ? "" : "s"} moved into the shared Main bucket.`,
          ),
        ),
        bucketKeyboard(),
      );
    } catch (error) {
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          dangerResponse(
            "Merge Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        bucketKeyboard(),
      );
    }
  });
  bot.action(/^bucket:purge:(dead|error)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const bucket = ctx.match[1] ?? "dead";
    await edit(
      ctx,
      pageText(
        "Validator Hub",
        dangerResponse(
          "Confirm Purge",
          `This permanently removes every record in <b>${escapeHtml(bucket)}</b>. This cannot be undone.`,
        ),
      ),
      keyboard([
        [btn(`⚠ Purge ${bucket}`, `bucket:purge:confirm:${bucket}`, "danger")],
        [btn("Cancel", "bucket:status")],
      ]),
    );
  });
  bot.action(/^bucket:purge:confirm:(dead|error)$/, async (ctx) => {
    await ctx.answerCbQuery("Purging…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const bucket = (ctx.match[1] ?? "dead") as ValidatorBucket;
    try {
      const removed = await purgeValidatorBucket(user.workspaceId, bucket);
      recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "validator.bucket.purge",
        success: true,
        metadata: { bucket, removed },
      });
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          successResponse(
            "Purge Complete",
            `${removed} record${removed === 1 ? "" : "s"} removed from ${bucket}.`,
          ),
        ),
        bucketKeyboard(),
      );
    } catch (error) {
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          dangerResponse(
            "Purge Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        bucketKeyboard(),
      );
    }
  });

  bot.action(/^session:([^:]+):collect$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const snapshot = await getValidatorSnapshot(session.workspaceId);
    await edit(
      ctx,
      pageText(
        "Link Collection",
        infoResponse(
          "Session Collector",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Transport:</b> ${escapeHtml(session.status)}\n<b>Shared Main:</b> ${snapshot.counts.main} · <b>Active:</b> ${snapshot.counts.active}\n<b>Dead:</b> ${snapshot.counts.dead} · <b>Error:</b> ${snapshot.counts.error}\n\nThese are the shared admin-validator records collected from Telegram and WhatsApp inbound text.`,
        ),
      ),
      linkCollectionKeyboard(session.sessionId),
    );
  });
  bot.action(/^session:([^:]+):collect:live$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await showValidatorLiveLog(ctx, true);
  });

  bot.action("jobs:live:open", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const userId = String(ctx.from?.id ?? "");
    const message = ctx.callbackQuery?.message;
    const chatId =
      ctx.chat?.id ??
      (message && "chat" in message ? message.chat.id : undefined);
    const messageId =
      message && "message_id" in message ? message.message_id : undefined;
    if (!chatId || !messageId) return;
    pendingLiveJobCode.set(userId, {
      workspaceId: user.workspaceId,
      chatId,
      messageId,
    });
    await edit(
      ctx,
      pageText(
        "Live Show",
        infoResponse(
          "Paste a job code",
          "Send the short code from a Join Manager, Validator, or broadcast result. Type <code>cancel</code> to close this input.",
        ),
      ),
      keyboard([[btn("‹ Back", "menu:main")]]),
    );
  });
  bot.action(/^job:live:([A-Z0-9]+)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const code = String(ctx.match[1] ?? "").toUpperCase();
    const job = await getWorkerRuntime()?.getByCode(user.workspaceId, code);
    await edit(ctx, jobLiveText(job), jobLiveKeyboard(job));
    const message = ctx.callbackQuery?.message;
    const chatId =
      ctx.chat?.id ??
      (message && "chat" in message ? message.chat.id : undefined);
    const messageId =
      message && "message_id" in message ? message.message_id : undefined;
    if (job && chatId && messageId)
      startJobLiveLoop(ctx, user.workspaceId, code, chatId, messageId);
  });
  bot.action("jobs:list", async (ctx) => {
    await ctx.answerCbQuery();
    await showSchedulePanel(ctx);
  });
  bot.action("schedule:new:validation", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    pendingScheduleInput.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
    });
    await edit(
      ctx,
      pageText(
        "Scheduled Jobs · New",
        infoResponse(
          "Hourly Link Validation",
          "Send one or more WhatsApp group invite links from chat.whatsapp.com separated by new lines. The schedule will run hourly until disabled.",
        ),
      ),
      keyboard([[btn("Cancel", "jobs:list", "danger")]]),
    );
  });
  bot.action(/^schedule:disable:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Disabling…");
    await disableSchedule(ctx.match[1] ?? "");
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: "schedule.disable",
      success: true,
      metadata: { scheduleId: ctx.match[1] ?? "" },
    });
    await showSchedulePanel(ctx);
  });
  bot.action("settings:menu", async (ctx) => {
    await ctx.answerCbQuery();
    const settings = getWorkspaceDefaults(resolveTelegramUser(ctx).workspaceId);
    await edit(
      ctx,
      workspaceSettingsText(settings),
      workspaceSettingsKeyboard(settings),
    );
  });
  bot.action("settings:autojoin:toggle", async (ctx) => {
    await ctx.answerCbQuery("Applying to all sessions…");
    const user = resolveTelegramUser(ctx);
    const current = getWorkspaceDefaults(user.workspaceId);
    const next = updateWorkspaceDefaults(user.workspaceId, {
      defaultAutoJoinEnabled: !current.defaultAutoJoinEnabled,
    });
    await edit(
      ctx,
      workspaceSettingsText(next),
      workspaceSettingsKeyboard(next),
    );
  });
  bot.action("settings:broadcastdelay:set", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    pendingBroadcastDelay.set(String(ctx.from?.id ?? ""), user.workspaceId);
    await edit(
      ctx,
      pageText(
        "Broadcast Delay",
        infoResponse("Send exact delay", "Send a whole number from <b>1</b> to <b>60</b> seconds."),
      ),
      keyboard([[btn("Cancel", "settings:menu")]]),
    );
  });
  bot.action("settings:broadcastdelay:cycle", async (ctx) => {
    await ctx.answerCbQuery("Updating broadcast delay…");
    const user = resolveTelegramUser(ctx);
    const current = getWorkspaceDefaults(user.workspaceId);
    const values = [1000, 5000, 10000, 20000, 30000, 45000, 60000];
    const nextValue =
      values[(values.indexOf(current.defaultBroadcastDelayMs) + 1) % values.length] ??
      20000;
    const next = updateWorkspaceDefaults(user.workspaceId, {
      defaultBroadcastDelayMs: nextValue,
    });
    await edit(
      ctx,
      workspaceSettingsText(next),
      workspaceSettingsKeyboard(next),
    );
  });
  bot.action("settings:prefix:cycle", async (ctx) => {
    await ctx.answerCbQuery("Applying to all sessions…");
    const user = resolveTelegramUser(ctx);
    const current = getWorkspaceDefaults(user.workspaceId);
    const values = [".", "!", "/", ""];
    const nextValue =
      values[(values.indexOf(current.defaultPrefix) + 1) % values.length] ??
      ".";
    const next = updateWorkspaceDefaults(user.workspaceId, {
      defaultPrefix: nextValue,
    });
    await edit(
      ctx,
      workspaceSettingsText(next),
      workspaceSettingsKeyboard(next),
    );
  });
  bot.action("settings:delay:cycle", async (ctx) => {
    await ctx.answerCbQuery("Applying to all sessions…");
    const user = resolveTelegramUser(ctx);
    const current = getWorkspaceDefaults(user.workspaceId);
    const values = [0, 5000, 10000, 30000];
    const index = values.indexOf(current.defaultJoinDelayMs);
    const next = updateWorkspaceDefaults(user.workspaceId, {
      defaultJoinDelayMs: values[(index + 1) % values.length] ?? 5000,
    });
    await edit(
      ctx,
      workspaceSettingsText(next),
      workspaceSettingsKeyboard(next),
    );
  });
  bot.action("settings:joinmode:cycle", async (ctx) => {
    await ctx.answerCbQuery("Updating join mode…");
    const user = resolveTelegramUser(ctx);
    const current = getWorkspaceDefaults(user.workspaceId);
    const values = ["auto", "immediate", "request"] as const;
    const index = values.indexOf(current.defaultJoinMode ?? "auto");
    const next = updateWorkspaceDefaults(user.workspaceId, {
      defaultJoinMode: values[(index + 1) % values.length] ?? "auto",
    });
    await edit(
      ctx,
      workspaceSettingsText(next),
      workspaceSettingsKeyboard(next),
    );
  });
  bot.action("support:menu", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    pendingSupportInput.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
    });
    await edit(
      ctx,
      pageText(
        "Support Inbox",
        infoResponse(
          "New Support Request",
          "Describe the issue in one message. It will be stored in your workspace inbox for owner review.",
        ),
      ),
      keyboard([[btn("Cancel", "menu:main", "danger")]]),
    );
  });
  bot.action("admin:support", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showAdminSupport(ctx);
  });
  bot.action(/^admin:support:reply:([a-f0-9-]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingSupportReply.set(String(ctx.from?.id ?? ""), {
      ticketId: ctx.match[1] ?? "",
    });
    await edit(
      ctx,
      pageText(
        "Support Inbox · Reply",
        infoResponse(
          "Owner Reply",
          "Send the reply text now. It will be delivered to WhatsApp when routing metadata is available.",
        ),
      ),
      keyboard([[btn("Cancel", "admin:support", "danger")]]),
    );
  });
  bot.action(/^admin:support:close:([a-f0-9-]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await updateSupportTicket(ctx.match[1] ?? "", { status: "closed" });
    await showAdminSupport(ctx);
  });
  bot.action("ui:schedule", async (ctx) => {
    await ctx.answerCbQuery();
    await showSchedulePanel(ctx);
  });
  bot.action("ui:settings", async (ctx) => {
    await ctx.answerCbQuery();
    const settings = getWorkspaceDefaults(resolveTelegramUser(ctx).workspaceId);
    await edit(
      ctx,
      workspaceSettingsText(settings),
      workspaceSettingsKeyboard(settings),
    );
  });
  bot.action("ui:support", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    pendingSupportInput.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
    });
    await edit(
      ctx,
      pageText(
        "Support Inbox",
        infoResponse(
          "New Support Request",
          "Describe the issue in one message. It will be stored in your workspace inbox for owner review.",
        ),
      ),
      keyboard([[btn("Cancel", "menu:main", "danger")]]),
    );
  });
  bot.action("ui:join", async (ctx) => {
    await ctx.answerCbQuery();
    await sendSessions(ctx, 0);
  });

  bot.action(/^session:([^:]+):bridge:command$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const message = ctx.callbackQuery?.message;
    const chatId =
      ctx.chat?.id ??
      (message && "chat" in message ? message.chat.id : undefined);
    const messageId =
      message && "message_id" in message ? message.message_id : undefined;
    if (!chatId || !messageId) return;
    pendingSessionBridge.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      chatId,
      messageId,
    });
    await edit(
      ctx,
      pageText(
        "Per-Session Bridge",
        infoResponse(
          "Send One Command",
          `Send a WhatsApp command for <b>${escapeHtml(session.sessionName)}</b>, for example <code>ping</code> or <code>groups</code>. The message will be routed through this live session.`,
        ),
      ),
      keyboard([
        [btn("✖ Cancel Input", `session:${session.sessionId}:bridge:stop`)],
      ]),
    );
  });
  bot.action(/^session:([^:]+):bridge:(start|stop)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const operation = ctx.match[2] ?? "start";
    await edit(
      ctx,
      pageText(
        "Per-Session Bridge",
        operation === "start"
          ? successResponse(
              "Session Bridge Started",
              `<b>${escapeHtml(session.sessionName)}</b> is now the only WhatsApp session bound to this bridge.`,
            )
          : successResponse(
              "Session Bridge Stopped",
              `<b>${escapeHtml(session.sessionName)}</b> is no longer accepting bridge traffic.`,
            ),
      ),
      keyboard([
        [
          btn(
            operation === "start"
              ? "⏹ Stop Session Bridge"
              : "▶ Start Session Bridge",
            `session:${session.sessionId}:bridge:${operation === "start" ? "stop" : "start"}`,
            operation === "start" ? "danger" : "success",
          ),
        ],
        [btn(ui.back, `session:${session.sessionId}:menu`)],
      ]),
    );
  });

  bot.action(/^session:([^:]+):joinmgr$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showJoinManager(ctx, ctx.match[1] ?? "");
  });
  bot.action(
    /^session:([^:]+):join:edit:(target|delay|minDelay|maxDelay|batch|retry|retryBase|cooldown|restriction|concurrency|mode)$/,
    async (ctx) => {
      await ctx.answerCbQuery();
      const session = ownedSession(ctx, ctx.match[1] ?? "");
      if (!session) return deny(ctx);
      const field = ctx.match[2] as JoinSettingField;
      const message = ctx.callbackQuery?.message;
      const chatId = ctx.chat?.id ?? (message && "chat" in message ? message.chat.id : undefined);
      const messageId = message && "message_id" in message ? message.message_id : undefined;
      if (!chatId || !messageId) return;
      const current = getSessionJoinSettings(session.workspaceId, session.sessionId);
      const instructions: Record<JoinSettingField, string> = {
        target: `Send the target link count as a whole number from 1 to 10,000. Current: <code>${current.targetCount}</code>.`,
        delay: `Send the base delay in seconds from 0 to 600. Use 0 for Immediate mode. Current: <code>${Math.round(current.delayMs / 1000)}s</code>.`,
        minDelay: `Send the minimum delay in seconds from 0 to 600. It cannot exceed Max Delay (${Math.round(current.maxDelayMs / 1000)}s).`,
        maxDelay: `Send the maximum delay in seconds from 0 to 600. It cannot be below Min Delay (${Math.round(current.minDelayMs / 1000)}s).`,
        batch: `Send batch cycles as a whole number from 1 to 20. Current: <code>${current.batchCycles}</code>.`,
        retry: `Send retry attempts as a whole number from 0 to 5. Current: <code>${current.retryLimit}</code>.`,
        retryBase: `Send retry backoff in seconds from 1 to 600. Current: <code>${Math.round(current.retryBaseMs / 1000)}s</code>.`,
        cooldown: `Send session cooldown in seconds from 0 to 3,600. Current: <code>${Math.round(current.sessionCooldownMs / 1000)}s</code>.`,
        restriction: `Send the rate-limit stop threshold as a whole number from 1 to 20. Current: <code>${current.restrictionThreshold}</code>.`,
        concurrency: `Send worker concurrency as a whole number from 1 to 8. Current: <code>${current.maxConcurrency}</code>.`,
        mode: `Send one mode: <code>auto</code>, <code>immediate</code>, or <code>request</code>. Current: <code>${current.mode}</code>.`,
      };
      pendingJoinSettingInput.set(String(ctx.from?.id ?? ""), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        field,
        chatId,
        messageId,
      });
      await edit(
        ctx,
        pageText(
          `${session.sessionName} · Join Settings`,
          infoResponse(
            `Edit ${field}`,
            `${instructions[field]}\n\nThis setting belongs only to <b>${escapeHtml(session.sessionName)}</b>. Send <code>cancel</code> or press Cancel to leave it unchanged.`,
          ),
        ),
        keyboard([
          [btn("✖ Cancel", `session:${session.sessionId}:join:settings`)],
        ]),
      );
    },
  );
  bot.action(
    /^session:([^:]+):join:(start|pause|stop|settings|setlimit|setdelay|setmindelay|setmaxdelay|setbatch|setretry|setretrybase|setcooldown|setrestriction|setconcurrency|setmode)$/,
    async (ctx) => {
      await ctx.answerCbQuery();
      const session = ownedSession(ctx, ctx.match[1] ?? "");
      if (!session) return deny(ctx);
      const operation = ctx.match[2] ?? "start";
      const user = resolveTelegramUser(ctx);
      const key = `${user.workspaceId}:${session.sessionId}`;
      const runtime = getWorkerRuntime();
      if (operation === "start") {
        if (!runtime)
          return edit(
            ctx,
            pageText(
              "Join Manager",
              dangerResponse(
                "Worker unavailable",
                "The durable worker runtime is not online.",
              ),
            ),
            joinManagerKeyboard(session.sessionId, "stopped"),
          );
        const settings = getSessionJoinSettings(
          user.workspaceId,
          session.sessionId,
        );
        const activeLinks = await countValidatorBucket(GLOBAL_VALIDATOR_SCOPE, "active").catch(() => 0);
        if (activeLinks === 0) {
          joinStates.set(key, "idle");
          return edit(
            ctx,
            pageText(
              "Join Manager",
              infoResponse(
                "No Active Links",
                "The shared Validator Hub Active bucket is empty. Add or validate WhatsApp group invites first, then press Start again.",
              ),
            ),
            joinManagerKeyboard(session.sessionId, "idle"),
          );
        }
        const existing = (await runtime.listRecent(200)).find(
          (candidate) =>
            candidate.workspaceId === user.workspaceId &&
            candidate.sessionId === session.sessionId &&
            candidate.kind === "join-manager" &&
            ["QUEUED", "RUNNING", "PAUSED", "RETRYING"].includes(
              candidate.state,
            ),
        );
        if (existing) {
          joinJobs.set(key, existing.jobId);
          joinStates.set(key, jobStateToJoinStatus(existing.state));
          return showJoinManager(ctx, session.sessionId);
        }
        const job = await runtime.enqueue({
          workspaceId: user.workspaceId,
          sessionId: session.sessionId,
          kind: "join-manager",
          payload: {
            targetCount: settings.targetCount,
            delayMs: settings.delayMs,
            minDelayMs: settings.minDelayMs,
            maxDelayMs: settings.maxDelayMs,
            batchCycles: settings.batchCycles,
            maxConcurrency: settings.maxConcurrency,
            retryLimit: settings.retryLimit,
            retryBaseMs: settings.retryBaseMs,
            sessionCooldownMs: settings.sessionCooldownMs,
            restrictionThreshold: settings.restrictionThreshold,
            requestMode: settings.mode,
          },
          idempotencyKey: `join-manager:${user.workspaceId}:${session.sessionId}:${Date.now()}`,
        });
        joinJobs.set(key, job.jobId);
        joinStates.set(key, "running");
      } else if (operation === "pause") {
        const jobId = joinJobs.get(key);
        if (jobId) await runtime?.pause(jobId);
        joinStates.set(key, "paused");
      } else if (operation === "stop") {
        const jobId = joinJobs.get(key);
        if (jobId) await runtime?.cancel(jobId);
        joinStates.set(key, "stopped");
      }
      if (operation === "settings") {
        const current = getSessionJoinSettings(
          user.workspaceId,
          session.sessionId,
        );
        return edit(
          ctx,
          pageText(
            "Join Manager · Settings",
            infoResponse(
              "Durable Joining Settings",
              `<b>Target links:</b> ${current.targetCount}\n<b>Delay:</b> ${Math.round(current.delayMs / 1000)}s\n<b>Min / max delay:</b> ${Math.round(current.minDelayMs / 1000)}s / ${Math.round(current.maxDelayMs / 1000)}s\n<b>Batch cycles:</b> ${current.batchCycles}\n<b>Concurrency:</b> ${current.maxConcurrency}\n<b>Retry limit / backoff:</b> ${current.retryLimit} / ${Math.round(current.retryBaseMs / 1000)}s\n<b>Session cooldown:</b> ${Math.round(current.sessionCooldownMs / 1000)}s\n<b>Restriction stop:</b> ${current.restrictionThreshold} rate limits\n<b>Join mode:</b> ${escapeHtml(current.mode.toUpperCase())}`,
            ),
          ),
          keyboard([
            [
              btn("🎯 Edit Target", `session:${session.sessionId}:join:edit:target`),
              btn("⏱ Edit Delay", `session:${session.sessionId}:join:edit:delay`),
            ],
            [
              btn(
                "↘ Min Delay",
                `session:${session.sessionId}:join:edit:minDelay`,
              ),
              btn(
                "↗ Max Delay",
                `session:${session.sessionId}:join:edit:maxDelay`,
              ),
            ],
            [
              btn("🔁 Edit Batch", `session:${session.sessionId}:join:edit:batch`),
              btn("↻ Edit Retries", `session:${session.sessionId}:join:edit:retry`),
            ],
            [
              btn(
                "⏳ Retry Backoff",
                `session:${session.sessionId}:join:edit:retryBase`,
              ),
              btn(
                "❄ Cooldown",
                `session:${session.sessionId}:join:edit:cooldown`,
              ),
            ],
            [
              btn(
                "⚡ Concurrency",
                `session:${session.sessionId}:join:edit:concurrency`,
              ),
              btn(
                "⛔ Stop Threshold",
                `session:${session.sessionId}:join:edit:restriction`,
              ),
            ],
            [btn("⇄ Edit Join Mode", `session:${session.sessionId}:join:edit:mode`)],
            [btn("‹ Join Manager", `session:${session.sessionId}:joinmgr`)],
          ]),
        );
      }
      if (
        operation === "setlimit" ||
        operation === "setdelay" ||
        operation === "setmindelay" ||
        operation === "setmaxdelay" ||
        operation === "setbatch" ||
        operation === "setretry" ||
        operation === "setretrybase" ||
        operation === "setcooldown" ||
        operation === "setrestriction" ||
        operation === "setconcurrency" ||
        operation === "setmode"
      ) {
        const sessionCurrent = getSessionJoinSettings(
          user.workspaceId,
          session.sessionId,
        );
        const current = {
          defaultJoinTargetCount: sessionCurrent.targetCount,
          defaultJoinDelayMs: sessionCurrent.delayMs,
          defaultJoinMinDelayMs: sessionCurrent.minDelayMs,
          defaultJoinMaxDelayMs: sessionCurrent.maxDelayMs,
          defaultJoinBatchCycles: sessionCurrent.batchCycles,
          defaultJoinMaxConcurrency: sessionCurrent.maxConcurrency,
          defaultJoinRetryLimit: sessionCurrent.retryLimit,
          defaultJoinRetryBaseMs: sessionCurrent.retryBaseMs,
          defaultJoinSessionCooldownMs: sessionCurrent.sessionCooldownMs,
          defaultJoinRestrictionThreshold: sessionCurrent.restrictionThreshold,
          defaultJoinMode: sessionCurrent.mode,
        };
        const patch: Parameters<typeof updateWorkspaceDefaults>[1] =
          operation === "setlimit"
            ? {
                defaultJoinTargetCount:
                  [100, 250, 500, 1000][
                    ([100, 250, 500, 1000].indexOf(
                      current.defaultJoinTargetCount,
                    ) +
                      1) %
                      4
                  ] ?? 100,
              }
            : operation === "setdelay"
              ? {
                  defaultJoinDelayMs:
                      [0, 5000, 10000, 30000, 60000][
                      ([0, 5000, 10000, 30000, 60000].indexOf(
                        current.defaultJoinDelayMs,
                      ) +
                        1) %
                        5
                    ] ?? 5000,
                }
              : operation === "setmindelay"
                ? (() => {
                    const nextMin =
                      [0, 1000, 3000, 5000, 10000][
                        ([0, 1000, 3000, 5000, 10000].indexOf(
                          current.defaultJoinMinDelayMs,
                        ) +
                          1) %
                          5
                      ] ?? 5000;
                    return {
                      defaultJoinMinDelayMs: nextMin,
                      ...(nextMin > current.defaultJoinMaxDelayMs
                        ? { defaultJoinMaxDelayMs: nextMin }
                        : {}),
                    };
                  })()
                : operation === "setmaxdelay"
                  ? (() => {
                      const nextMax =
                        [0, 5000, 10000, 30000, 60000][
                          ([0, 5000, 10000, 30000, 60000].indexOf(
                            current.defaultJoinMaxDelayMs,
                          ) +
                            1) %
                            5
                        ] ?? 10000;
                      return {
                        defaultJoinMaxDelayMs: nextMax,
                        ...(nextMax < current.defaultJoinMinDelayMs
                          ? { defaultJoinMinDelayMs: nextMax }
                          : {}),
                      };
                    })()
                  : operation === "setbatch"
                    ? {
                        defaultJoinBatchCycles:
                          [1, 2, 5, 10][
                            ([1, 2, 5, 10].indexOf(
                              current.defaultJoinBatchCycles,
                            ) +
                              1) %
                              4
                          ] ?? 1,
                      }
                    : operation === "setretry"
                      ? {
                          defaultJoinRetryLimit:
                            [0, 1, 2, 3][
                              ([0, 1, 2, 3].indexOf(
                                current.defaultJoinRetryLimit,
                              ) +
                                1) %
                                4
                            ] ?? 2,
                        }
                      : operation === "setretrybase"
                        ? {
                            defaultJoinRetryBaseMs:
                              [1000, 5000, 10000, 30000][
                                ([1000, 5000, 10000, 30000].indexOf(
                                  current.defaultJoinRetryBaseMs,
                                ) +
                                  1) %
                                  4
                              ] ?? 5000,
                          }
                        : operation === "setcooldown"
                          ? {
                              defaultJoinSessionCooldownMs:
                                [0, 10000, 30000, 60000][
                                  ([0, 10000, 30000, 60000].indexOf(
                                    current.defaultJoinSessionCooldownMs,
                                  ) +
                                    1) %
                                    4
                                ] ?? 30000,
                            }
                          : operation === "setrestriction"
                            ? {
                                defaultJoinRestrictionThreshold:
                                  [3, 5, 8, 10][
                                    ([3, 5, 8, 10].indexOf(
                                      current.defaultJoinRestrictionThreshold,
                                    ) +
                                      1) %
                                      4
                                  ] ?? 5,
                              }
                            : operation === "setmode"
                              ? {
                                  defaultJoinMode:
                                    current.defaultJoinMode === "auto"
                                      ? "immediate"
                                      : current.defaultJoinMode === "immediate"
                                        ? "request"
                                        : "auto",
                                }
                              : {
                                  defaultJoinMaxConcurrency:
                                    [1, 2, 3, 5][
                                      ([1, 2, 3, 5].indexOf(
                                        current.defaultJoinMaxConcurrency,
                                      ) +
                                        1) %
                                        4
                                    ] ?? 2,
                                };
        const next = updateSessionJoinSettings(
          user.workspaceId,
          session.sessionId,
          {
            ...(patch.defaultJoinTargetCount !== undefined
              ? { targetCount: patch.defaultJoinTargetCount }
              : {}),
            ...(patch.defaultJoinDelayMs !== undefined
              ? { delayMs: patch.defaultJoinDelayMs }
              : {}),
            ...(patch.defaultJoinMinDelayMs !== undefined
              ? { minDelayMs: patch.defaultJoinMinDelayMs }
              : {}),
            ...(patch.defaultJoinMaxDelayMs !== undefined
              ? { maxDelayMs: patch.defaultJoinMaxDelayMs }
              : {}),
            ...(patch.defaultJoinBatchCycles !== undefined
              ? { batchCycles: patch.defaultJoinBatchCycles }
              : {}),
            ...(patch.defaultJoinMaxConcurrency !== undefined
              ? { maxConcurrency: patch.defaultJoinMaxConcurrency }
              : {}),
            ...(patch.defaultJoinRetryLimit !== undefined
              ? { retryLimit: patch.defaultJoinRetryLimit }
              : {}),
            ...(patch.defaultJoinRetryBaseMs !== undefined
              ? { retryBaseMs: patch.defaultJoinRetryBaseMs }
              : {}),
            ...(patch.defaultJoinSessionCooldownMs !== undefined
              ? { sessionCooldownMs: patch.defaultJoinSessionCooldownMs }
              : {}),
            ...(patch.defaultJoinRestrictionThreshold !== undefined
              ? { restrictionThreshold: patch.defaultJoinRestrictionThreshold }
              : {}),
            ...(patch.defaultJoinMode !== undefined
              ? { mode: patch.defaultJoinMode }
              : {}),
          },
        );
        const nextSettings = next.joinSettings;
        return edit(
          ctx,
          pageText(
            "Join Manager · Settings",
            successResponse(
              "Setting Updated",
              `<b>Target:</b> ${nextSettings?.targetCount} · <b>Delay:</b> ${Math.round((nextSettings?.delayMs ?? 0) / 1000)}s · <b>Min/Max:</b> ${Math.round((nextSettings?.minDelayMs ?? 0) / 1000)}s/${Math.round((nextSettings?.maxDelayMs ?? 0) / 1000)}s\n<b>Batch:</b> ${nextSettings?.batchCycles} · <b>Concurrency:</b> ${nextSettings?.maxConcurrency} · <b>Retries:</b> ${nextSettings?.retryLimit} · <b>Backoff:</b> ${Math.round((nextSettings?.retryBaseMs ?? 0) / 1000)}s\n<b>Cooldown:</b> ${Math.round((nextSettings?.sessionCooldownMs ?? 0) / 1000)}s · <b>Stop:</b> ${nextSettings?.restrictionThreshold} rate limits · <b>Mode:</b> ${escapeHtml((nextSettings?.mode ?? "auto").toUpperCase())}`,
            ),
          ),
          keyboard([
            [
              btn(
                "⚙ More Settings",
                `session:${session.sessionId}:join:settings`,
              ),
            ],
            [btn("‹ Join Manager", `session:${session.sessionId}:joinmgr`)],
          ]),
        );
      }
      await showJoinManager(ctx, session.sessionId);
    },
  );

  bot.action("autopromote:user", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    await showAutoPromoteDashboard(ctx, user.telegramUserId, user.workspaceId);
  });
  bot.action(/^session:([^:]+):autopromote$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    pendingAutoPromote.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      scope: "SESSION",
      sessionId: session.sessionId,
      stage: "command",
      chatId: ctx.chat?.id,
      messageId: ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : undefined,
    });
    await edit(
      ctx,
      pageText("Session Auto Promote", infoResponse("Choose Command", `<b>Session:</b> ${escapeHtml(session.sessionName)}\nThis configuration affects only this WhatsApp session.`)),
      autoPromoteCommandKeyboard(),
    );
  });
  bot.action("admin:autopromote", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showOwnerAutoPromoteDashboard(ctx);
  });
  bot.action("admin:autopromote:new", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const activeSessions = activeAllSessions();
    const targets = activeSessions.map((session) => session.sessionId);
    pendingAutoPromote.set(String(ctx.from?.id ?? ""), {
      workspaceId: user.workspaceId,
      scope: "GLOBAL",
      allFutureSessions: true,
      stage: "command",
      chatId: ctx.chat?.id,
      messageId: ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : undefined,
    });
    await edit(
      ctx,
      pageText(
        "Global Auto Promote",
        infoResponse(
          "Choose Command",
          `<b>Targets:</b> ${targets.length} ACTIVE session(s) selected by default. You can review them after choosing the command.\n\nThis owner configuration automatically follows future eligible sessions.`,
        ),
      ),
      autoPromoteCommandKeyboard(),
    );
  });
  bot.action("admin:autopromote:targets:refresh", async (ctx) => {
    await ctx.answerCbQuery("Refreshing ACTIVE sessions…");
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current || current.scope !== "GLOBAL") return;
    const activeSessions = activeAllSessions();
    const activeIds = new Set(activeSessions.map((session) => session.sessionId));
    const selected = current.allFutureSessions
      ? new Set(activeSessions.map((session) => session.sessionId))
      : new Set((current.targetSessionIds ?? []).filter((id) => activeIds.has(id)));
    pendingAutoPromote.set(userId, { ...current, targetSessionIds: current.allFutureSessions ? undefined : [...selected] });
    await edit(
      ctx,
      pageText("Global Auto Promote", infoResponse("Choose Target Sessions", `<b>Selected:</b> ${selected.size} active session(s)\n<b>Available:</b> ${activeSessions.length} ACTIVE session(s)`)),
      autoPromoteGlobalTargetsKeyboard(activeSessions, selected),
    );
  });
  bot.action(/^autopromote:global:toggle:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current || current.scope !== "GLOBAL") return;
    const selected = new Set(current.targetSessionIds ?? []);
    const sessionId = ctx.match[1] ?? "";
    if (selected.has(sessionId)) selected.delete(sessionId); else selected.add(sessionId);
    pendingAutoPromote.set(userId, { ...current, targetSessionIds: [...selected], allFutureSessions: false });
    const activeSessions = activeAllSessions();
    await edit(ctx, pageText("Global Auto Promote", infoResponse("Choose Target Sessions", `<b>Selected:</b> ${selected.size} active session(s)`)), autoPromoteGlobalTargetsKeyboard(activeSessions, selected));
  });
  bot.action("autopromote:global:all", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current || current.scope !== "GLOBAL") return;
    const activeSessions = activeAllSessions();
    const selected = activeSessions.map((session) => session.sessionId);
    pendingAutoPromote.set(userId, { ...current, targetSessionIds: undefined, allFutureSessions: true });
    await edit(ctx, pageText("Global Auto Promote", infoResponse("All ACTIVE + Future Sessions", "Newly paired ACTIVE sessions will be added automatically on the next scheduled occurrence.")), autoPromoteGlobalTargetsKeyboard(activeSessions, new Set(selected)));
  });
  bot.action("autopromote:global:ready", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current || current.scope !== "GLOBAL" || (!current.allFutureSessions && !(current.targetSessionIds?.length))) {
      await edit(
        ctx,
        pageText(
          "Global Auto Promote",
          infoResponse("Select at least one session", "Choose one or more ACTIVE sessions, then press Use Selected Sessions."),
        ),
        autoPromoteGlobalTargetsKeyboard(activeAllSessions(), new Set(current?.targetSessionIds ?? [])),
      );
      return;
    }
    pendingAutoPromote.set(userId, { ...current, stage: "days" });
    await edit(
      ctx,
      pageText(
        "Global Auto Promote",
        infoResponse(
          "Choose Duration",
          `<b>Targets:</b> ${current.allFutureSessions ? "ALL ACTIVE + FUTURE sessions" : `${current.targetSessionIds?.length ?? 0} selected ACTIVE session(s)`}\n\nChoose how many days this Global Auto Promote should run.`,
        ),
      ),
      autoPromoteDaysKeyboard(),
    );
  });
  bot.action(/^autopromote:scope:SESSION:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const current = pendingAutoPromote.get(String(ctx.from?.id ?? ""));
    if (!current) return;
    pendingAutoPromote.set(String(ctx.from?.id ?? ""), { ...current, scope: "SESSION", sessionId: session.sessionId, stage: "command" });
    await edit(ctx, pageText("Auto Promote", infoResponse("Choose Command", `<b>Session:</b> ${escapeHtml(session.sessionName)}`)), autoPromoteCommandKeyboard());
  });
  bot.action("autopromote:scope:USER", async (ctx) => {
    await ctx.answerCbQuery();
    const current = pendingAutoPromote.get(String(ctx.from?.id ?? ""));
    if (!current) return;
    pendingAutoPromote.set(String(ctx.from?.id ?? ""), { ...current, scope: "USER", sessionId: undefined, stage: "command" });
    await edit(ctx, pageText("Auto Promote", infoResponse("Choose Command", "This configuration targets all WhatsApp sessions owned by you.")), autoPromoteCommandKeyboard());
  });
  bot.action(/^autopromote:command:(allstatus|allchat|allstatusx)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current) return;
    const command = ctx.match[1] as AutoPromoteCommand;
    pendingAutoPromote.set(userId, { ...current, command, stage: current.scope === "GLOBAL" ? "scope" : "days" });
    if (current.scope === "GLOBAL") {
      const activeSessions = activeAllSessions();
      const selected = new Set(current.targetSessionIds ?? activeSessions.map((session) => session.sessionId));
      await edit(
        ctx,
        pageText(
          "Global Auto Promote",
          infoResponse(
            "Review Target Sessions",
            `<b>Command:</b> <code>${escapeHtml(command)}</code>\n<b>Selected:</b> ${current.allFutureSessions ? "ALL ACTIVE + FUTURE sessions" : `${selected.size} ACTIVE session(s)`}\n\nAdjust the selection if needed, then press Continue to Duration.`,
          ),
        ),
        autoPromoteGlobalTargetsKeyboard(activeSessions, selected),
      );
      return;
    }
    await edit(ctx, pageText("Auto Promote", infoResponse("Duration", "How many days should this Auto Promote job run? Choose 2–30 days.")), autoPromoteDaysKeyboard());
  });
  bot.action(/^autopromote:days:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    const days = Number(ctx.match[1]);
    if (!current || days < 2 || days > 30) return;
    pendingAutoPromote.set(userId, { ...current, days, stage: "times" });
    await edit(ctx, pageText("Auto Promote", infoResponse("Times Per Day", "How many times should the payload post each day?")), autoPromoteTimesKeyboard());
  });
  bot.action(/^autopromote:times:([1-5])$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    const timesPerDay = Number(ctx.match[1]);
    if (!current) return;
    const next = { ...current, timesPerDay, stage: current.command === "allstatusx" ? "posts" as const : "payload" as const };
    pendingAutoPromote.set(userId, next);
    await edit(ctx, pageText("Auto Promote", infoResponse(next.stage === "posts" ? "Posts Per Group" : "Payload", next.stage === "posts" ? "How many times should the payload be posted to each group before moving to the next group?" : "Send the original text, link, or caption payload now. It will be preserved exactly.")), next.stage === "posts" ? autoPromotePostsKeyboard() : keyboard([[btn("Cancel", "autopromote:cancel", "danger")]]));
  });
  bot.action(/^autopromote:posts:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    const posts = Number(ctx.match[1]);
    if (!current || posts < 1 || posts > 10) return;
    pendingAutoPromote.set(userId, { ...current, allstatusxPostsPerGroup: posts, stage: "payload" });
    await edit(ctx, pageText("Auto Promote", infoResponse("Payload", "Send the original text, link, or caption payload now. It will be preserved exactly.")), keyboard([[btn("Cancel", "autopromote:cancel", "danger")]]));
  });
  bot.action("autopromote:confirm", async (ctx) => {
    await ctx.answerCbQuery("Creating Auto Promote…");
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current?.command || !current.days || !current.timesPerDay || current.payloadText === undefined) return;
    const config = await createAutoPromoteConfig({
      scope: current.scope,
      ownerTelegramUserId: userId,
      ownerWorkspaceId: current.workspaceId,
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      ...(current.targetSessionIds ? { targetSessionIds: current.targetSessionIds } : {}),
      command: current.command,
      payload: {
        ...(current.payloadText !== undefined ? { text: current.payloadText } : {}),
        ...(current.payloadMedia ? { media: current.payloadMedia } : {}),
        ...(current.payloadCaption !== undefined ? { caption: current.payloadCaption } : {}),
        ...(current.payloadQuoted ? { quoted: current.payloadQuoted } : {}),
      },
      days: current.days,
      timesPerDay: current.timesPerDay,
      ...(current.allstatusxPostsPerGroup !== undefined ? { allstatusxPostsPerGroup: current.allstatusxPostsPerGroup } : {}),
    });
    pendingAutoPromote.delete(userId);
    recordAudit({ workspaceId: current.workspaceId, actorTelegramUserId: userId, action: "autopromote.create", success: true, metadata: { configId: config.id, scope: config.scope, command: config.command } });
    await showAutoPromoteDashboard(ctx, userId, current.workspaceId);
  });
  bot.action("autopromote:edit", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from?.id ?? "");
    const current = pendingAutoPromote.get(userId);
    if (!current) return;
    pendingAutoPromote.set(userId, { ...current, stage: "command" });
    await edit(ctx, pageText("Auto Promote", infoResponse("Choose Command", "Restart the wizard from the command step.")), autoPromoteCommandKeyboard());
  });
  bot.action("autopromote:cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled");
    pendingAutoPromote.delete(String(ctx.from?.id ?? ""));
    await edit(ctx, pageText("Auto Promote", infoResponse("Cancelled", "No Auto Promote configuration was created.")), keyboard([[btn(ui.back, "menu:main")]]));
  });
  bot.action("autopromote:new", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const userId = String(ctx.from?.id ?? "");
    pendingAutoPromote.set(userId, {
      workspaceId: user.workspaceId,
      scope: "USER",
      stage: "scope",
      chatId: ctx.chat?.id,
      messageId: ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.message_id
        : undefined,
    });
    const sessions = activeWorkspaceSessions(user.workspaceId);
    await edit(
      ctx,
      pageText("Auto Promote", infoResponse("Choose Scope", "Choose one WhatsApp session or apply the schedule to all your ACTIVE sessions.")),
      autoPromoteScopeKeyboard(undefined, sessions),
    );
  });
  bot.action(/^autopromote:view:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const config = await getAutoPromoteConfig(ctx.match[1] ?? "");
    const user = resolveTelegramUser(ctx);
    if (!config || (config.ownerTelegramUserId !== user.telegramUserId && !requireAdmin(ctx))) return deny(ctx);
    const runs = await listAutoPromoteRuns({ configId: config.id, limit: 20 });
    await edit(ctx, autoPromoteText([config], runs), keyboard([
      [btn(config.state === "PAUSED" ? "▶ Resume" : "Ⅱ Pause", `autopromote:${config.state === "PAUSED" ? "resume" : "pause"}:${config.id}`, config.state === "PAUSED" ? "success" : "primary")],
      [btn(config.enabled ? "■ Cancel Job" : "□ Disabled", `autopromote:disable:${config.id}`, "danger")],
      [btn("🗑 Delete Job", `autopromote:delete:${config.id}`, "danger")],
      [btn(ui.back, "autopromote:user")],
    ]));
  });
  bot.action(/^autopromote:(pause|resume):([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const configId = ctx.match[2] ?? "";
    const config = await getAutoPromoteConfig(configId);
    const user = resolveTelegramUser(ctx);
    if (!config || (config.ownerTelegramUserId !== user.telegramUserId && !requireAdmin(ctx))) return deny(ctx);
    const runs = await listAutoPromoteRuns({ configId, limit: 100 });
    const runtime = getWorkerRuntime();
    if (ctx.match[1] === "pause") {
      await pauseAutoPromoteConfig(configId);
      for (const run of runs) if (run.jobId) await runtime?.pause(run.jobId).catch(() => undefined);
    } else {
      await resumeAutoPromoteConfig(configId);
      for (const run of runs) if (run.jobId) await runtime?.resume(run.jobId).catch(() => undefined);
    }
    await showAutoPromoteDashboard(ctx, user.telegramUserId, user.workspaceId);
  });
  bot.action(/^autopromote:disable:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Cancelling…");
    const configId = ctx.match[1] ?? "";
    const config = await getAutoPromoteConfig(configId);
    const user = resolveTelegramUser(ctx);
    if (!config || (config.ownerTelegramUserId !== user.telegramUserId && !requireAdmin(ctx))) return deny(ctx);
    await cancelAutoPromoteConfig(configId);
    const runtime = getWorkerRuntime();
    const runs = await listAutoPromoteRuns({ configId, limit: 100 });
    for (const run of runs) if (run.jobId) await runtime?.cancel(run.jobId).catch(() => undefined);
    await showAutoPromoteDashboard(ctx, user.telegramUserId, user.workspaceId);
  });
  bot.action(/^autopromote:delete:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const configId = ctx.match[1] ?? "";
    const config = await getAutoPromoteConfig(configId);
    const user = resolveTelegramUser(ctx);
    if (!config || (config.ownerTelegramUserId !== user.telegramUserId && !requireAdmin(ctx))) return deny(ctx);
    const runs = await listAutoPromoteRuns({ configId, limit: 100 });
    await edit(
      ctx,
      pageText(
        "Auto Promote · Delete",
        warningResponse(
          "Permanent deletion",
          `<b>Job:</b> <code>${escapeHtml(config.id.slice(0, 12))}</code>\n<b>Runs:</b> ${runs.length}\n\nThis removes the schedule and all stored runs. Active child jobs will be cancelled first. This cannot be undone.`,
        ),
      ),
      keyboard([
        [btn("🗑 Confirm Delete", `autopromote:delete:confirm:${config.id}`, "danger")],
        [btn("‹ Keep Job", `autopromote:view:${config.id}`)],
      ]),
    );
  });
  bot.action(/^autopromote:delete:confirm:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Deleting…");
    const configId = ctx.match[1] ?? "";
    const config = await getAutoPromoteConfig(configId);
    const user = resolveTelegramUser(ctx);
    if (!config || (config.ownerTelegramUserId !== user.telegramUserId && !requireAdmin(ctx))) return deny(ctx);
    await deleteAutoPromoteConfig(configId, getWorkerRuntime());
    recordAudit({
      workspaceId: user.workspaceId,
      actorTelegramUserId: user.telegramUserId,
      action: "autopromote.delete",
      success: true,
      metadata: { configId: config.id, scope: config.scope, command: config.command },
    });
    await showAutoPromoteDashboard(ctx, user.telegramUserId, user.workspaceId);
  });

  bot.action("workload:menu", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const [mode, workers] = await Promise.all([
      getWorkloadMode(user.workspaceId),
      listWorkspaceWorkloadWorkers(user.workspaceId),
    ]);
    await edit(ctx, workloadText(mode, workers), workloadKeyboard(workers.length > 0));
  });
  bot.action("workload:status", async (ctx) => {
    await ctx.answerCbQuery("Checking panel status…");
    const user = resolveTelegramUser(ctx);
    const [mode, workers] = await Promise.all([
      getWorkloadMode(user.workspaceId),
      listWorkspaceWorkloadWorkers(user.workspaceId),
    ]);
    await edit(ctx, workloadText(mode, workers), workloadKeyboard(workers.length > 0));
  });
  bot.action("workload:list", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const workers = await listWorkspaceWorkloadWorkers(user.workspaceId);
    if (!workers.length) {
      await edit(ctx, workloadText(await getWorkloadMode(user.workspaceId), []), workloadKeyboard(false));
      return;
    }
    await edit(
      ctx,
      workloadText(await getWorkloadMode(user.workspaceId), workers),
      keyboard([
        ...workers.map((worker) => {
          const code = worker.workloadCode ?? worker.displayKey;
          return [btn(`▣ ${worker.workerName ?? "Panel"} · ${code} · ${worker.status}`, `workload:select:${code}`)];
        }),
        [btn("➕ Add Workload", "workload:add", "success")],
        [btn(ui.back, "workload:menu")],
      ]),
    );
  });
  bot.action("workload:add", async (ctx) => {
    await ctx.answerCbQuery("Choose a panel name first…");
    const userId = String(ctx.from?.id ?? "");
    pendingAdminInput.set(userId, "workload:name");
    await edit(
      ctx,
      pageText(
        "Workload · Name Panel",
        infoResponse("Choose a permanent panel name", "Send a short name for this panel, for example <code>paddy</code>, <code>marketing-01</code>, or <code>home-panel</code>. Telegram will then create a code in the form <code>name-random</code>.\n\nUse /cancel to close this request."),
      ),
      keyboard([[btn(ui.close, "workload:menu", "danger")]]),
    );
  });
  bot.action("workload:enroll", async (ctx) => {
    await ctx.answerCbQuery("Opening Add Workload…");
    await edit(ctx, pageText("Workload · Add Workload", infoResponse("Use the new pairing flow", "Tap <b>Add Workload</b>. Telegram will create a copyable pairing code, send <code>index.js</code>, and show the exact steps for your panel.")), keyboard([[btn("➕ Add Workload", "workload:add", "success")], [btn(ui.back, "workload:menu")]]));
  });
  bot.action("workload:guide", async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, workloadGuideText(env.WORKLOAD_CONTROL_URL), keyboard([[btn("➕ Add Workload", "workload:add", "success")], [btn(ui.back, "workload:menu")]]));
  });
  bot.action("workload:download", async (ctx) => {
    await ctx.answerCbQuery("Use Add Workload to receive the panel file.");
    await edit(ctx, pageText("Workload · Add Workload", infoResponse("Files are sent only with Add Workload", "Tap <b>Add Workload</b>, choose your permanent panel name, and Telegram will send the current <code>index.js</code> only after creating the pairing enrollment.")), keyboard([[btn("➕ Add Workload", "workload:add", "success")], [btn("📖 Open Setup Guide", "workload:guide")], [btn(ui.back, "workload:menu")]]));
  });
  bot.action(/^workload:select:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const token = ctx.match[1] ?? "";
    const worker = /^\d{5}$/.test(token)
      ? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, token)
      : await getWorkspaceWorkloadWorkerByCode(user.workspaceId, token);
    if (!worker) {
      await edit(ctx, pageText("Workload", dangerResponse("Workload not found", "Refresh your workload list and try again.")), workloadKeyboard(false));
      return;
    }
    await edit(ctx, workloadPanelText(worker), workloadPanelKeyboard(worker.workloadCode ?? worker.displayKey));
  });
  bot.action(/^workload:logger:(refresh:)?(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Refreshing logger…");
    const user = resolveTelegramUser(ctx);
    const token = ctx.match[2] ?? "";
    const worker = /^\d{5}$/.test(token)
      ? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, token)
      : await getWorkspaceWorkloadWorkerByCode(user.workspaceId, token);
    if (!worker) {
      await edit(ctx, pageText("Workload · Logger", dangerResponse("Panel not found", "Refresh Workload and open Logger again.")), keyboard([[btn(ui.back, "workload:list")] ]));
      return;
    }
    try {
      const snapshot = await getWorkloadLoggerSnapshot(user.workspaceId, worker.workerId);
      await edit(ctx, workloadLoggerText(snapshot), workloadLoggerKeyboard(worker.workloadCode ?? worker.displayKey));
    } catch (error) {
      await edit(ctx, pageText("Workload · Logger", dangerResponse("Logger unavailable", escapeHtml(error instanceof Error ? error.message : String(error)))), keyboard([[btn("↻ Retry Logger", `workload:logger:${token}`)], [btn(ui.back, "workload:list")]]));
    }
  });
  bot.action(/^workload:use:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const token = ctx.match[1] ?? "";
    const worker = /^\d{5}$/.test(token)
      ? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, token)
      : await getWorkspaceWorkloadWorkerByCode(user.workspaceId, token);
    if (!worker || !isWorkloadWorkerReady(worker)) {
      await edit(ctx, pageText("Workload", dangerResponse("Workload is not ready", "Only an ACTIVE, compatible workload with a fresh heartbeat can host a session.")), workloadKeyboard(Boolean(worker)));
      return;
    }
    const code = worker.workloadCode ?? worker.displayKey;
    preferredWorkloadWorker.set(String(ctx.from?.id ?? ""), { workspaceId: worker.workspaceId, workerId: worker.workerId, workloadCode: code, displayKey: worker.displayKey });
    await edit(ctx, pageText("Workload", successResponse("Workload selected", `New pairing will use <code>${escapeHtml(code)}</code>. Tap Pair Number when ready.`)), keyboard([[btn("⚡ Pair Number", "session:new", "success")], [btn(ui.back, "workload:menu")]]));
  });
  bot.action(/^workload:remove:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Removing workload…");
    const user = resolveTelegramUser(ctx);
    const token = ctx.match[1] ?? "";
    const worker = /^\d{5}$/.test(token)
      ? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, token)
      : await getWorkspaceWorkloadWorkerByCode(user.workspaceId, token);
    if (worker) await revokeWorkloadWorker(worker.workerId);
    preferredWorkloadWorker.delete(String(ctx.from?.id ?? ""));
    await edit(ctx, pageText("Workload", successResponse("Workload removed", "The workload credential and code were deleted immediately. Existing session metadata and WhatsApp auth are preserved.")), workloadKeyboard(false));
  });
  bot.action("admin:workload", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const [mode, workers] = await Promise.all([getWorkloadMode(user.workspaceId), listWorkspaceWorkloadWorkers(user.workspaceId)]);
    await edit(ctx, adminWorkloadText(mode, workers), adminWorkloadKeyboard(mode, workers));
  });
  bot.action("admin:workload:toggle", async (ctx) => {
    await ctx.answerCbQuery("Updating workload mode…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const current = await getWorkloadMode(user.workspaceId);
    const next = current === "ON" ? "OFF" : "ON";
    await setWorkloadMode(user.workspaceId, next);
    recordAudit({ workspaceId: user.workspaceId, actorTelegramUserId: user.telegramUserId, action: "admin.workload.mode", success: true, metadata: { previous: current, next } });
    const workers = await listWorkspaceWorkloadWorkers(user.workspaceId);
    await edit(ctx, adminWorkloadText(next, workers), adminWorkloadKeyboard(next, workers));
  });
  bot.action(/^admin:workload:worker:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const worker = (await listWorkspaceWorkloadWorkers(user.workspaceId)).find((item) => item.workerId === ctx.match[1]);
    if (!worker) {
      await edit(ctx, pageText("Admin · Workload", dangerResponse("Worker not found", "Refresh the registry and try again.")), keyboard([[btn(ui.back, "admin:workload")]]));
      return;
    }
    await edit(ctx, adminWorkloadWorkerText(worker), adminWorkloadWorkerKeyboard(worker.workerId, worker.status === "DISABLED"));
  });
  bot.action(/^admin:workload:worker:toggle:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Updating worker…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const worker = (await listWorkspaceWorkloadWorkers(user.workspaceId)).find((item) => item.workerId === ctx.match[1]);
    if (!worker) return;
    const updated = await toggleWorkloadWorker(worker.workerId);
    recordAudit({ workspaceId: user.workspaceId, actorTelegramUserId: user.telegramUserId, action: "admin.workload.worker.toggle", success: true, metadata: { workerId: worker.workerId, status: updated.status } });
    await edit(ctx, adminWorkloadWorkerText(updated), adminWorkloadWorkerKeyboard(updated.workerId, updated.status === "DISABLED"));
  });
  bot.action(/^admin:workload:worker:check:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Refreshing worker state…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const worker = (await listWorkspaceWorkloadWorkers(user.workspaceId)).find((item) => item.workerId === ctx.match[1]);
    if (!worker) return;
    await edit(ctx, adminWorkloadWorkerText(worker), adminWorkloadWorkerKeyboard(worker.workerId, worker.status === "DISABLED"));
  });
  bot.action("admin:panel", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await edit(
      ctx,
      pageText(
        "Admin Control Plane",
        infoResponse(
          "Owner Only",
          "Platform-wide operations, media management, audit, force-join, emergency mode, and global operations are restricted to the owner.",
        ),
      ),
      adminKeyboard(),
    );
  });
  bot.action("admin:inceptor", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await edit(ctx, adminInceptorText(getInceptorSnapshot()), adminInceptorKeyboard());
  });
  bot.action("admin:inceptor:run", async (ctx) => {
    await ctx.answerCbQuery("Inceptor sweep running…");
    if (!requireAdmin(ctx)) return;
    const snapshot = await runInceptorSweep();
    const user = resolveTelegramUser(ctx);
    recordAudit({
      workspaceId: user.workspaceId,
      actorTelegramUserId: user.telegramUserId,
      action: "admin.inceptor.sweep",
      success: Boolean(snapshot),
      metadata: snapshot
        ? { scanned: snapshot.scanned, recovered: snapshot.recovered, flushed: snapshot.flushedDeadSessionJobs, flushedMissing: snapshot.flushedMissingSessionJobs, flushedStuck: snapshot.flushedStuckJobs, pruned: snapshot.prunedTerminalJobs }
        : { unavailable: true },
    });
    await edit(ctx, adminInceptorText(snapshot), adminInceptorKeyboard());
  });
  bot.action("admin:home", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await edit(
      ctx,
      pageText(
        "Admin Control Plane",
        infoResponse(
          "Owner Only",
          "Platform-wide operations are restricted to the owner.",
        ),
      ),
      adminKeyboard(),
    );
  });
  bot.action(/^admin:users(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showAdminUsers(ctx, Number(ctx.match?.[1] ?? 0));
  });
  bot.action(/^admin:user:(ban|unban):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const action = ctx.match[1] === "ban" ? "ban" : "unban";
    const telegramUserId = ctx.match[2] ?? "";
    const nextStatus = action === "ban" ? "banned" : "active";
    const changed = await setUserStatus(telegramUserId, nextStatus);
    setUserStatusLocal(telegramUserId, nextStatus);
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: `admin.user.${action}`,
      success: changed,
      metadata: { telegramUserId },
    });
    await showAdminUsers(ctx, 0);
  });
  bot.action("admin:bucket", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const snapshot = await getValidatorSnapshot(
      resolveTelegramUser(ctx).workspaceId,
    );
    await edit(ctx, adminBucketText(snapshot), adminBucketKeyboard());
  });
  bot.action("admin:bridge", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    pendingAdminGlobalBridge.delete(userId);
    pendingAdminBridge.delete(userId);
    const sessions = activeAllSessions();
    const selected = adminBridgeSelections.get(String(ctx.from?.id ?? "")) ?? new Set<string>();
    await edit(ctx, adminBridgeText(sessions), adminBridgeKeyboard(sessions, selected));
  });
  bot.action("admin:bridge:clear", async (ctx) => {
    await ctx.answerCbQuery("Selection cleared");
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    adminBridgeSelections.delete(userId);
    await edit(
      ctx,
      adminBridgeText(activeAllSessions()),
      adminBridgeKeyboard(activeAllSessions()),
    );
  });
  bot.action("admin:bridge:all", async (ctx) => {
    await ctx.answerCbQuery("All ACTIVE sessions selected");
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const active = activeAllSessions();
    const selected = new Set(active.map((session) => adminBridgeTargetToken(session.workspaceId, session.sessionId)));
    adminBridgeSelections.set(userId, selected);
    await edit(
      ctx,
      adminBridgeText(active),
      adminBridgeKeyboard(active, selected),
    );
  });
  bot.action(/^admin:bridge:toggle:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const token = String(ctx.match[1] ?? "").toUpperCase();
    const session = activeAllSessions().find(
      (item) => adminBridgeTargetToken(item.workspaceId, item.sessionId) === token,
    );
    if (!session) {
      await ctx.answerCbQuery("Session target is no longer available.", { show_alert: true });
      return;
    }
    const selected = adminBridgeSelections.get(userId) ?? new Set<string>();
    if (selected.has(token)) selected.delete(token);
    else selected.add(token);
    adminBridgeSelections.set(userId, selected);
    await edit(
      ctx,
      adminBridgeText(activeAllSessions()),
      adminBridgeKeyboard(activeAllSessions(), selected),
    );
  });
  bot.action("admin:bridge:command", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const selected = adminBridgeSelections.get(userId) ?? new Set<string>();
    const targets = activeAllSessions().filter((item) =>
      selected.has(adminBridgeTargetToken(item.workspaceId, item.sessionId)),
    );
    if (!targets.length) {
      await edit(
        ctx,
        pageText(
          "Admin · Global Bridge",
          warningResponse("Select at least one session", "Choose one or more session targets before sending a command."),
        ),
        adminBridgeKeyboard(activeAllSessions(), selected),
      );
      return;
    }
    const message = ctx.callbackQuery?.message;
    const chatId = ctx.chat?.id ?? (message && "chat" in message ? message.chat.id : undefined);
    const messageId = message && "message_id" in message ? message.message_id : undefined;
    if (!chatId || !messageId) return;
    pendingAdminGlobalBridge.set(userId, { chatId, messageId });
    await edit(
      ctx,
      pageText(
        "Admin · Global Bridge",
        infoResponse(
          "Send One Command",
          `<b>Targets:</b> ${targets.length}\nSend a command such as <code>ping</code> or <code>health</code>. Send <code>cancel</code> to close this input without routing anything.`,
        ),
      ),
      keyboard([[btn("✖ Cancel Input", "admin:bridge")]]),
    );
  });
  bot.action(/^admin:bridge:open:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const token = String(ctx.match[1] ?? "").toUpperCase();
    const session = activeAllSessions().find(
      (item) => adminBridgeTargetToken(item.workspaceId, item.sessionId) === token,
    );
    if (!session) return deny(ctx);
    await edit(
      ctx,
      pageText(
        "Admin · Session Bridge",
        infoResponse(
          "Explicit Target Selected",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Workspace:</b> <code>${escapeHtml(session.workspaceId)}</code>\n<b>Status:</b> ${escapeHtml(session.status)}\n\nThis is the single-session command surface. Use Global Bridge to select multiple targets.`,
        ),
      ),
      keyboard([
        [btn("✉ Send Command", `admin:bridge:send:${token}`, "success")],
        [btn("‹ Admin Global Bridge", "admin:bridge", "primary")],
      ]),
    );
  });
  bot.action(/^admin:bridge:send:([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const token = String(ctx.match[1] ?? "").toUpperCase();
    const session = activeAllSessions().find(
      (item) => adminBridgeTargetToken(item.workspaceId, item.sessionId) === token,
    );
    if (!session) return deny(ctx);
    const message = ctx.callbackQuery?.message;
    const chatId = ctx.chat?.id ?? (message && "chat" in message ? message.chat.id : undefined);
    const messageId = message && "message_id" in message ? message.message_id : undefined;
    if (!chatId || !messageId) return;
    pendingAdminBridge.set(String(ctx.from?.id ?? ""), {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      chatId,
      messageId,
    });
    await edit(
      ctx,
      pageText(
        "Admin Bridge",
        infoResponse(
          "Send One Command",
          `Send a command for <b>${escapeHtml(session.sessionName)}</b>, such as <code>ping</code> or <code>health</code>. Send <code>cancel</code> to close this input.`,
        ),
      ),
      keyboard([[btn("✖ Cancel", "admin:bridge")]]),
    );
  });
  bot.action(/^admin:bridge:command:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const workspaceId = ctx.match[1] ?? "";
    const sessionId = ctx.match[2] ?? "";
    const session = activeAllSessions().find(
      (item) =>
        item.workspaceId === workspaceId && item.sessionId === sessionId,
    );
    if (!session) return deny(ctx);
    const message = ctx.callbackQuery?.message;
    const chatId =
      ctx.chat?.id ??
      (message && "chat" in message ? message.chat.id : undefined);
    const messageId =
      message && "message_id" in message ? message.message_id : undefined;
    if (!chatId || !messageId) return;
    pendingAdminBridge.set(String(ctx.from?.id ?? ""), {
      workspaceId,
      sessionId,
      chatId,
      messageId,
    });
    await edit(
      ctx,
      pageText(
        "Admin Bridge",
        infoResponse(
          "Send One Command",
          `Send a command for <b>${escapeHtml(session.sessionName)}</b>, for example <code>ping</code> or <code>health</code>.`,
        ),
      ),
      keyboard([[btn("✖ Cancel", "admin:bridge")]]),
    );
  });
  bot.action(/^admin:bridge:session:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const workspaceId = ctx.match[1] ?? "";
    const sessionId = ctx.match[2] ?? "";
    const session = activeAllSessions().find(
      (item) =>
        item.workspaceId === workspaceId && item.sessionId === sessionId,
    );
    if (!session) return deny(ctx);
    recordAudit({
      workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: "admin.bridge.session.open",
      success: true,
      metadata: { sessionId },
    });
    await edit(
      ctx,
      pageText(
        "Admin · Session Bridge",
        infoResponse(
          "Explicit Target Selected",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Workspace:</b> <code>${escapeHtml(workspaceId)}</code>\n<b>Status:</b> ${escapeHtml(session.status)}\n\nThis target is selected for inspection. Start/cancel operations remain subject to the same bounded queue and audit policies as user operations.`,
        ),
      ),
      keyboard([
        [
          btn(
            "✉️ Send Command",
            `admin:bridge:command:${workspaceId}:${sessionId}`,
            "success",
          ),
        ],
        [btn("↻ Back to Global Bridge", "admin:bridge", "primary")],
      ]),
    );
  });
  bot.action("admin:audit", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const events = listAuditEvents(resolveTelegramUser(ctx).workspaceId, 100);
    await edit(ctx, adminAuditText(events), adminAuditKeyboard());
  });
  bot.action("admin:forcejoin", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    pendingAdminInput.delete(userId);
    pendingForceJoin.delete(userId);
    await showAdminForceJoin(ctx);
  });
  bot.action("admin:forcejoin:add", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    pendingForceJoin.set(userId, {
      workspaceId: resolveTelegramUser(ctx).workspaceId,
    });
    pendingAdminInput.set(userId, "forcejoin:target");
    await edit(
      ctx,
      pageText(
        "Admin · Force Join",
        infoResponse(
          "Step 1 of 3 · Channel or Group",
          "Send the Telegram channel or group link now. Public forms such as <code>@mychannel</code>, <code>https://t.me/mychannel</code>, or a numeric chat ID can be checked automatically. You may prefix it with <code>channel | </code> or <code>group | </code> when the type is not obvious.",
        ),
      ),
      keyboard([[btn("Cancel", "admin:forcejoin", "danger")]]),
    );
  });
  bot.action(/^admin:forcejoin:toggle:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const targetId = ctx.match[1] ?? "";
    const targets = await listForceJoinTargets();
    const target = targets.find((item) => item.targetId === targetId);
    if (target) await setForceJoinTargetEnabled(targetId, !target.enabled);
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: "admin.forcejoin.toggle",
      success: Boolean(target),
      metadata: {
        targetId,
        ...(target ? { enabled: !target.enabled } : {}),
      },
    });
    await showAdminForceJoin(ctx);
  });
  bot.action(/^admin:forcejoin:remove:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Target removed");
    if (!requireAdmin(ctx)) return;
    const targetId = ctx.match[1] ?? "";
    const removed = await removeForceJoinTarget(targetId);
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: "admin.forcejoin.remove",
      success: removed,
      metadata: { targetId },
    });
    await showAdminForceJoin(ctx);
  });
  bot.action(/^forcejoin:open:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const target = (await listForceJoinTargets()).find(
      (item) => item.targetId === (ctx.match[1] ?? ""),
    );
    if (!target) return;
    await edit(
      ctx,
      pageText(
        "Force Join Target",
        infoResponse(
          target.displayName,
          `<code>${escapeHtml(target.usernameOrLink)}</code>\n\nOpen the target, join it, then return and press Check Membership.`,
        ),
      ),
      forceJoinKeyboard([target]),
    );
  });
  bot.action("forcejoin:status", async (ctx) => {
    await ctx.answerCbQuery();
    const gate = await getForceJoinGate(ctx);
    if (!gate.targets.length)
      return edit(
        ctx,
        pageText(
          "Membership Gate",
          infoResponse("No policy is active", "The owner has not configured a required channel or group yet."),
        ),
        keyboard([[btn(ui.back, "menu:main")]]),
      );
    await edit(ctx, forceJoinText(gate.targets, gate.passed), forceJoinKeyboard(gate.targets));
  });
  bot.action("forcejoin:check", async (ctx) => {
    await ctx.answerCbQuery();
    const gate = await getForceJoinGate(ctx);
    if (!gate.allowed)
      return edit(
        ctx,
        forceJoinText(gate.targets, gate.passed),
        forceJoinKeyboard(gate.targets),
      );
    await edit(ctx, dashboardText(false), dashboardKeyboard(false));
  });
  bot.action("admin:media", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await sendAdminMedia(ctx);
  });
  bot.action("admin:jobs", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showAdminJobs(ctx);
  });
  bot.action("admin:jobs:refresh", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showAdminJobs(ctx);
  });
  bot.action("admin:jobs:clear", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await edit(
      ctx,
      pageText(
        "Clear All Jobs",
        dangerResponse(
          "Destructive queue action",
          "This will cancel active Pappy jobs and remove queued, delayed, completed, failed, live-code, idempotency, recovery, and broadcast-marker records. WhatsApp sessions, Validator Hub links, Join Manager result data, and persistent storage are preserved.",
        ),
      ),
      keyboard([
        [btn("🗑 Confirm Clear All Jobs", "admin:jobs:clear:confirm", "danger")],
        [btn("Cancel", "admin:jobs")],
      ]),
    );
  });
  bot.action("admin:jobs:clear:confirm", async (ctx) => {
    await ctx.answerCbQuery("Clearing Pappy jobs…");
    if (!requireAdmin(ctx)) return;
    const user = resolveTelegramUser(ctx);
    const runtime = getWorkerRuntime();
    if (!runtime) {
      await edit(
        ctx,
        pageText("Clear All Jobs", dangerResponse("Unavailable", "The Pappy worker runtime is not available.")),
        keyboard([[btn("‹ Admin Panel", "admin:panel")]]),
      );
      return;
    }
    const removed = await runtime.clearAllJobs();
    recordAudit({
      workspaceId: user.workspaceId,
      actorTelegramUserId: user.telegramUserId,
      action: "admin.jobs.clear_all",
      success: true,
      metadata: { removed },
    });
    await edit(
      ctx,
      pageText(
        "Jobs Cleared",
        successResponse(
          "Pappy queue cleared",
          `${removed} durable Pappy job record(s) were removed. Sessions, Validator Hub data, Join Manager result data, and persistent storage were preserved.`,
        ),
      ),
      keyboard([
        [btn("↻ View Jobs", "admin:jobs", "primary")],
        [btn("‹ Admin Panel", "admin:panel")],
      ]),
    );
  });
  bot.action(/^admin:jobs:cancel:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Cancellation requested");
    if (!requireAdmin(ctx)) return;
    const runtime = getWorkerRuntime();
    const jobId = ctx.match[1] ?? "";
    const cancelled = runtime ? await runtime.cancel(jobId) : undefined;
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
      action: "admin.job.cancel",
      success: Boolean(cancelled),
      metadata: { jobId },
    });
    await showAdminJobs(ctx);
  });
  bot.action(/^admin:media:add:(image|video)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingMedia.set(
      String(ctx.from?.id ?? ""),
      ctx.match[1] as "image" | "video",
    );
    await edit(
      ctx,
      pageText(
        "Admin Media Upload",
        infoResponse(
          "Upload Requested",
          `Upload the next ${ctx.match[1]} file in this chat. It will be stored in the owner workspace media catalog.`,
        ),
      ),
      keyboard([[btn(ui.back, "admin:media")]]),
    );
  });
  bot.action("admin:safe", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const actor = String(ctx.from?.id ?? "");
    const current = getEmergencyState();
    const next = setEmergencyState(actor, {
      enabled: !current.enabled,
      pauseMassSends: !current.enabled,
      pauseJoins: !current.enabled,
      pauseBroadcasts: !current.enabled,
      pauseScheduler: !current.enabled,
      disablePairing: !current.enabled,
    });
    recordAudit({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      actorTelegramUserId: actor,
      action: next.enabled ? "emergency.enabled" : "emergency.disabled",
      success: true,
      metadata: { ...next },
    });
    await edit(
      ctx,
      pageText(
        "Emergency Mode",
        next.enabled
          ? dangerResponse(
              "Safe Mode Enabled",
              "Mass sends, joins, broadcasts, scheduling, and pairing are blocked until Safe Mode is disabled.",
            )
          : successResponse(
              "Safe Mode Disabled",
              "Normal operations are allowed again, subject to quotas and per-operation checks.",
            ),
      ),
      keyboard([
        [
          btn(
            next.enabled ? "✅ Disable Safe Mode" : "⚠ Enable Safe Mode",
            "admin:safe",
            next.enabled ? "success" : "danger",
          ),
        ],
        [btn(ui.back, "admin:panel")],
      ]),
    );
  });
  bot.action("admin:media:select", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    const settings = getWhatsappMenuSettings(workspaceId);
    const items = listMenuMedia(workspaceId);
    await edit(
      ctx,
      pageText(
        "WhatsApp Menu Media",
        infoResponse(
          "Choose the shared attachment",
          items.length
            ? `${getAdminMediaOverview(workspaceId)}\n\nTap one item to attach it to every user’s WhatsApp <code>.menu</code> in this workspace.`
            : "No uploaded image or video is available yet. Use Add Image or Add Video first.",
        ),
      ),
      menuMediaPickerKeyboard(items, settings.whatsappMenuMediaId),
    );
  });
  bot.action(/^admin:media:pick:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery("Menu media attached");
    if (!requireAdmin(ctx)) return;
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    try {
      selectWhatsappMenuMedia(workspaceId, ctx.match[1] ?? "");
      await sendAdminMedia(ctx);
    } catch (error) {
      await edit(
        ctx,
        pageText(
          "Admin Media",
          dangerResponse(
            "Selection Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        mediaKeyboard(),
      );
    }
  });
  bot.action("admin:media:clear", async (ctx) => {
    await ctx.answerCbQuery("Menu media cleared");
    if (!requireAdmin(ctx)) return;
    clearWhatsappMenuMedia(resolveTelegramUser(ctx).workspaceId);
    await sendAdminMedia(ctx);
  });
  bot.action("admin:media:caption", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    pendingAdminInput.set(userId, "menu:caption");
    await edit(
      ctx,
      pageText(
        "Admin · Menu Caption",
        infoResponse(
          "Set the shared caption",
          "Send the caption that should appear above the menu for every workspace user. Send <code>clear</code> to restore the default caption.",
        ),
      ),
      keyboard([[btn("Cancel", "admin:media", "danger")]]),
    );
  });
  bot.action("admin:broadcast", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingAdminInput.set(String(ctx.from?.id ?? ""), "broadcast:compose");
    await edit(
      ctx,
      pageText(
        "Admin · Broadcast",
        infoResponse(
          "Compose Owner Broadcast",
          "Send the message text now. The next screen is a preview; no user will receive anything until you confirm.",
        ),
      ),
      keyboard([[btn("Cancel", "admin:panel", "danger")]]),
    );
  });
  bot.action("admin:broadcast:cancel", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingAdminBroadcasts.delete(String(ctx.from?.id ?? ""));
    pendingAdminInput.delete(String(ctx.from?.id ?? ""));
    await showAdminPanel(ctx);
  });
  bot.action("admin:broadcast:confirm", async (ctx) => {
    await ctx.answerCbQuery("Broadcasting…");
    if (!requireAdmin(ctx)) return;
    const actorId = String(ctx.from?.id ?? "");
    const draft = pendingAdminBroadcasts.get(actorId);
    if (!draft) return showAdminPanel(ctx);
    const recipients = (await listUsers(1000)).filter(
      (user) => user.status === "active",
    );
    let success = 0;
    let failed = 0;
    for (const recipient of recipients) {
      try {
        await ctx.telegram.sendMessage(recipient.telegramUserId, draft.text);
        success += 1;
      } catch {
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    recordAudit({
      workspaceId: draft.workspaceId,
      actorTelegramUserId: actorId,
      action: "admin.broadcast.execute",
      success: failed === 0,
      metadata: { recipients: recipients.length, delivered: success, failed },
    });
    pendingAdminBroadcasts.delete(actorId);
    pendingAdminInput.delete(actorId);
    await edit(
      ctx,
      pageText(
        "Admin · Broadcast Result",
        successResponse(
          "Broadcast Complete",
          `<b>Recipients:</b> ${recipients.length}\n<b>Delivered:</b> ${success}\n<b>Failed:</b> ${failed}`,
        ),
      ),
      keyboard([[btn("‹ Admin Panel", "admin:panel")]]),
    );
  });

  bot.catch((error, ctx) =>
    console.error(`[telegram] update ${ctx.updateType} failed`, error),
  );
  return bot;
}

function savePendingPairing(
  telegramUserId: string,
  state: {
    stage: "label" | "phone";
    chatId: number;
    messageId?: number;
    sessionId?: string;
  },
): void {
  pendingPairing.set(telegramUserId, state);
  void savePairingRequest({
    ...state,
    telegramUserId,
    updatedAt: Date.now(),
  }).catch(() => undefined);
}

function clearPendingPairing(telegramUserId: string): void {
  pendingPairing.delete(telegramUserId);
  void deletePairingRequest(telegramUserId).catch(() => undefined);
}

async function startPairing(
  ctx: Context,
  requestedName: string,
): Promise<void> {
  if (!requestedName.trim()) return beginPairingWizard(ctx);
  const user = resolveTelegramUser(ctx);
  const userId = String(ctx.from?.id ?? "");
  const workloadMode = await getWorkloadMode(user.workspaceId);
  const preferred = preferredWorkloadWorker.get(userId);
  if (workloadMode === "OFF" && !preferred) {
    await sendOrEdit(ctx, pageText("Pairing", warningResponse("Central workload is OFF", "New WhatsApp sessions cannot use your VPS while Admin Workload is OFF. Deploy or select an external panel workload instead. Existing sessions are preserved.")), keyboard([[btn("▣ Workload Panels", "workload:menu")], [btn(ui.back, "menu:main")]]));
    return;
  }
  let targetWorker = preferred
    ? await getWorkspaceWorkloadWorkerByCode(user.workspaceId, preferred.workloadCode)
      ?? await getWorkspaceWorkloadWorkerByDisplayKey(user.workspaceId, preferred.displayKey)
    : undefined;
  if (preferred && (!targetWorker || !isWorkloadWorkerReady(targetWorker))) {
    preferredWorkloadWorker.delete(userId);
    targetWorker = undefined;
    await sendOrEdit(ctx, pageText("Pairing", dangerResponse("Selected panel is offline", "Check the panel status or choose another panel before pairing.")), keyboard([[btn("◌ Workload", "workload:menu")], [btn(ui.back, "menu:main")]]));
    return;
  }
  const normalizedName = requestedName.trim().replace(/\s+/g, "-");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,47}$/.test(normalizedName)) {
    await sendOrEdit(
      ctx,
      pageText(
        "Pairing Request",
        dangerResponse(
          "Invalid Session Label",
          "Use 2–48 letters, numbers, hyphens, or underscores, beginning with a letter or number.",
        ),
      ),
      keyboard([[btn(ui.back, "menu:main")]]),
    );
    return;
  }
  const session = createSession({
    workspaceId: user.workspaceId,
    sessionName: normalizedName,
  });
  if (targetWorker) {
    try {
      await assignWorkloadSession(user.workspaceId, session.sessionId, targetWorker.workerId);
    } catch (error) {
      await purgeWhatsAppSession(user.workspaceId, session.sessionId).catch(() => undefined);
      await sendOrEdit(ctx, pageText("Pairing", dangerResponse("Panel assignment failed", escapeHtml(error instanceof Error ? error.message : String(error)))), keyboard([[btn("◌ Workload", "workload:menu")], [btn(ui.back, "menu:main")]]));
      return;
    }
  }
  savePendingPairing(String(ctx.from?.id ?? ""), {
    stage: "phone",
    chatId: ctx.chat?.id ?? 0,
    sessionId: session.sessionId,
  });
  await sendOrEdit(
    ctx,
    pageText(
      "Pairing · Phone Number",
      infoResponse(
        "Session Created",
        `<b>${escapeHtml(session.sessionName)}</b> is ready. Send the full WhatsApp number in country-code format, for example <code>2348012345678</code>.`,
      ),
    ),
    keyboard([[btn(ui.close, "menu:main", "danger")]]),
  );
}

async function beginPairingWizard(ctx: Context, workloadSelected = false): Promise<void> {
  const user = resolveTelegramUser(ctx);
  if (!workloadSelected) {
    const workloadMode = await getWorkloadMode(user.workspaceId);
    const workers = await listWorkspaceWorkloadWorkers(user.workspaceId);
    const readyWorkers = workers.filter((worker) => isWorkloadWorkerReady(worker));
    const rows = readyWorkers.map((worker) => {
      const code = worker.workloadCode ?? worker.displayKey;
      return [btn(`▣ ${worker.workerName ?? "Panel"} · ${code}`, `pair:workload:${code}`, "success")];
    });
    if (workloadMode === "ON") rows.push([btn("▣ Use Central Workload", "pair:local")]);
    if (!rows.length) {
      await sendOrEdit(ctx, workloadGuideText(env.WORKLOAD_CONTROL_URL), keyboard([[btn("➕ Add Workload", "workload:add", "success")], [btn("⬇ Download Panel Worker", "workload:download")], [btn(ui.back, "menu:main")]]));
      return;
    }
    rows.push([btn(ui.close, "menu:main", "danger")]);
    await sendOrEdit(ctx, pageText("Pairing · Choose Workload", infoResponse("Where should this new WhatsApp session run?", "Choose one of your ACTIVE workloads. Your choice applies only to this new pairing.")), keyboard(rows));
    return;
  }
  const message = ctx.callbackQuery?.message;
  const chatId =
    ctx.chat?.id ?? (message && "chat" in message ? message.chat.id : 0);
  const messageId =
    message && "message_id" in message ? message.message_id : undefined;
  savePendingPairing(String(ctx.from?.id ?? ""), {
    stage: "label",
    chatId,
    ...(messageId ? { messageId } : {}),
  });
  await sendOrEdit(
    ctx,
    pageText(
      "New WhatsApp Session",
      infoResponse(
        "Step 1 of 2 · Session Label",
        "Send a short label such as <code>main</code>, <code>business</code>, or <code>support-1</code>. You will then enter the WhatsApp number.",
      ),
    ),
    keyboard([[btn(ui.close, "menu:main", "danger")]]),
  );
}

async function handlePairingText(
  ctx: Context,
  pending: {
    stage: "label" | "phone";
    chatId: number;
    messageId?: number;
    sessionId?: string;
  },
  text: string,
): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  if (!text) return;
  if (pending.stage === "label") {
    clearPendingPairing(userId);
    await startPairing(ctx, text);
    return;
  }
  const sessionId = pending.sessionId;
  if (!sessionId) {
    clearPendingPairing(userId);
    await beginPairingWizard(ctx);
    return;
  }
  const normalizedPhone = text.replace(/[^0-9]/g, "");
  if (!/^[1-9][0-9]{6,14}$/.test(normalizedPhone)) {
    await sendOrEdit(
      ctx,
      pageText(
        "Pairing · Phone Number",
        dangerResponse(
          "Invalid Number",
          "Send digits only in international country-code format, for example <code>2348012345678</code>.",
        ),
      ),
      keyboard([[btn(ui.close, "menu:main", "danger")]]),
    );
    return;
  }
  const workspaceId = resolveTelegramUser(ctx).workspaceId;
  const session = getSession(workspaceId, sessionId);
  try {
    updateSession(workspaceId, sessionId, {
      phoneNumber: normalizedPhone,
      status: "PAIRING",
    });
    clearPendingPairing(userId);
    const code = await requestWhatsAppPairingCode(
      session.workspaceId,
      session.sessionId,
      normalizedPhone,
      undefined,
      ctx.chat?.id,
    );
    preferredWorkloadWorker.delete(userId);
    await sendOrEdit(
      ctx,
      pageText(
        "Pairing · Code Ready",
        successResponse(
          "Enter This Code in WhatsApp",
          `<b>${escapeHtml(session.sessionName)}</b> is waiting for pairing.\n\n<code>${escapeHtml(code)}</code>\n\nOpen WhatsApp → Linked Devices → Link a Device → Link with phone number, then enter the code. This screen will remain recoverable if the network is temporarily unavailable.`,
        ),
      ),
      keyboard([
        [copyBtn("📋 Copy pairing code", code, "success")],
        [btn("↻ Session Status", `session:${session.sessionId}:menu`)],
        [btn(ui.back, "sessions:list:0")],
      ]),
    );
  } catch (error) {
    updateSession(workspaceId, sessionId, {
      status: "ERROR",
      disconnectReason:
        `pairing failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          240,
        ),
    });
    await sendOrEdit(
      ctx,
      pageText(
        "Pairing · Could Not Start",
        dangerResponse(
          "Pairing Unavailable",
          escapeHtml(error instanceof Error ? error.message : String(error)),
        ),
      ),
      keyboard([
        [btn("↻ Retry Phone Number", `pair:number:${sessionId}`, "success")],
        [
          btn(
            "🗑 Purge Failed Session",
            `session:${sessionId}:action:purge`,
            "danger",
          ),
        ],
        [btn(ui.back, "sessions:list:0")],
      ]),
    );
  }
}

async function sendSessions(ctx: Context, page: number): Promise<void> {
  const user = resolveTelegramUser(ctx);
  const sessions = listVisibleSessions(user.workspaceId);
  const body = pageText(
    "Your WhatsApp Sessions",
    sessions.length
      ? infoResponse(
          "Session Registry",
          "Select one of your isolated sessions. The per-session Bridge and Join Manager never operate outside the selected session.",
        )
      : infoResponse(
          "No Sessions Yet",
          "Start pairing to create your first isolated WhatsApp session.",
        ),
  );
  await sendOrEdit(
    ctx,
    body,
    sessionsKeyboard(sessions, page, 5, isAdmin(ctx)),
  );
}

async function showAdminPanel(ctx: Context): Promise<void> {
  await edit(
    ctx,
    pageText(
      "Admin Control Plane",
      infoResponse(
        "Owner Only",
        "Platform-wide operations, media management, audit, force-join, emergency mode, and global operations are restricted to the owner.",
      ),
    ),
    adminKeyboard(),
  );
}

async function showAdminUsers(ctx: Context, page: number): Promise<void> {
  const users = await listUsers(20, Math.max(0, page) * 20);
  const views = users.map((user) => ({
    telegramUserId: user.telegramUserId,
    ...(user.username ? { username: user.username } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    status: user.status,
    workspaceId: user.workspaceId,
    lastSeenAt: user.lastSeenAt,
    sessionCount: listSessions(user.workspaceId).length,
  }));
  await edit(
    ctx,
    adminUsersText(views, Math.max(0, page)),
    adminUsersKeyboard(views, Math.max(0, page)),
  );
}

async function showAdminForceJoin(ctx: Context): Promise<void> {
  const targets = await listForceJoinTargets();
  await edit(ctx, adminForceJoinText(targets), adminForceJoinKeyboard(targets));
}

function inferForceJoinType(
  raw: string,
): { target: string; targetType: "channel" | "group" } {
  const explicit = raw.match(/^(channel|group)\s*\|\s*(.+)$/i);
  if (explicit?.[2])
    return {
      target: explicit[2].trim(),
      targetType: explicit[1]!.toLowerCase() as "channel" | "group",
    };
  const target = raw.trim();
  const targetType = /(?:joinchat|t\.me\/\+|chat\.whatsapp\.com)/i.test(target)
    ? "group"
    : "channel";
  return { target, targetType };
}

async function handleForceJoinTargetInput(
  ctx: Context,
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  const draft = pendingForceJoin.get(actorId);
  if (!draft || !text || text.length > 300) {
    await edit(
      ctx,
      pageText(
        "Admin · Force Join",
        dangerResponse("Invalid Target", "Send one valid Telegram channel or group link, username, or chat ID."),
      ),
      keyboard([[btn("↻ Try Target Again", "admin:forcejoin:add", "success")]]),
    );
    return;
  }
  const inferred = inferForceJoinType(text);
  pendingForceJoin.set(actorId, { ...draft, ...inferred });
  pendingAdminInput.set(actorId, "forcejoin:name");
  await edit(
    ctx,
    pageText(
      "Admin · Force Join",
      infoResponse(
        "Step 2 of 3 · Display Name",
        `<b>Target:</b> <code>${escapeHtml(inferred.target)}</code>\n<b>Type:</b> ${inferred.targetType}\n\nSend the friendly name users should see, for example <code>Official Updates</code>.`,
      ),
    ),
    keyboard([[btn("Cancel", "admin:forcejoin", "danger")]]),
  );
}

async function handleForceJoinNameInput(
  ctx: Context,
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  const draft = pendingForceJoin.get(actorId);
  if (!draft || !text || text.length > 120) {
    await edit(
      ctx,
      pageText("Admin · Force Join", dangerResponse("Invalid Name", "Send a display name between 1 and 120 characters.")),
      keyboard([[btn("↻ Try Name Again", "admin:forcejoin:add", "success")]]),
    );
    return;
  }
  pendingForceJoin.set(actorId, { ...draft, displayName: text });
  pendingAdminInput.set(actorId, "forcejoin:button");
  await edit(
    ctx,
    pageText(
      "Admin · Force Join",
      infoResponse(
        "Step 3 of 3 · Button Text",
        `Send the label users should tap, for example <code>Join Official Updates</code>. The target will be saved immediately after this step.`,
      ),
    ),
    keyboard([[btn("Cancel", "admin:forcejoin", "danger")]]),
  );
}

async function handleForceJoinButtonInput(
  ctx: Context,
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  const draft = pendingForceJoin.get(actorId);
  if (!draft?.target || !draft.targetType || !draft.displayName || !text || text.length > 80) {
    await edit(
      ctx,
      pageText("Admin · Force Join", dangerResponse("Invalid Button Text", "Send a button label between 1 and 80 characters.")),
      keyboard([[btn("↻ Try Button Again", "admin:forcejoin:add", "success")]]),
    );
    return;
  }
  await upsertForceJoinTarget({
    targetType: draft.targetType,
    usernameOrLink: draft.target,
    displayName: draft.displayName,
    buttonText: text,
  });
  pendingAdminInput.delete(actorId);
  pendingForceJoin.delete(actorId);
  recordAudit({
    workspaceId: draft.workspaceId,
    actorTelegramUserId: actorId,
    action: "admin.forcejoin.add",
    success: true,
    metadata: {
      targetType: draft.targetType,
      target: draft.target.slice(0, 120),
      displayName: draft.displayName,
      buttonText: text,
    },
  });
  await edit(
    ctx,
    pageText(
      "Admin · Force Join",
      successResponse("Policy Saved", `${escapeHtml(draft.displayName)} is now required for users. The user Membership Gate button will show it immediately.`),
    ),
    adminForceJoinKeyboard(await listForceJoinTargets()),
  );
}

async function handleMenuCaptionInput(ctx: Context, text: string): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  pendingAdminInput.delete(actorId);
  const workspaceId = resolveTelegramUser(ctx).workspaceId;
  const caption = text.toLowerCase() === "clear" ? "Choose a session and send a command." : text;
  if (!caption || caption.length > 1024) {
    await edit(
      ctx,
      pageText("Admin · Menu Caption", dangerResponse("Invalid Caption", "Send 1–1024 characters or <code>clear</code>.")),
      keyboard([[btn("↻ Try Again", "admin:media:caption", "success")]]),
    );
    return;
  }
  updateWhatsappMenuCaption(workspaceId, caption);
  await edit(
    ctx,
    pageText("Admin · Menu Caption", successResponse("Shared Caption Saved", "Every workspace user’s next WhatsApp <code>.menu</code> will use this caption.")),
    mediaKeyboard(),
  );
}

async function showSessionHealth(
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return deny(ctx);
  const jobs = (await getWorkerRuntime()?.listRecent(100)) ?? [];
  const activeJobs = jobs.filter(
    (job) =>
      job.workspaceId === session.workspaceId &&
      job.sessionId === session.sessionId &&
      ["RUNNING", "RETRYING"].includes(job.state),
  );
  await edit(
    ctx,
    pageText(
      `${session.sessionName} · Health`,
      infoResponse(
        "Session Diagnostics",
        `<b>Status:</b> ${escapeHtml(effectiveSessionStatus(session))}\n<b>Auth:</b> ${escapeHtml(session.authHealth ?? "UNKNOWN")}\n<b>Phone:</b> ${escapeHtml(session.phoneNumber ?? "not paired")}\n<b>Prefix:</b> <code>${escapeHtml(session.prefix || "none")}</code>\n<b>Connected:</b> ${session.connectedAt ? new Date(session.connectedAt).toLocaleString() : "not recorded"}\n<b>Last healthy:</b> ${session.lastHealthyAt ? new Date(session.lastHealthyAt).toLocaleString() : "not recorded"}\n<b>Last inbound:</b> ${session.lastMessageReceivedAt ? new Date(session.lastMessageReceivedAt).toLocaleString() : "none"}\n<b>Last outbound:</b> ${session.lastOutboundMessageAt ? new Date(session.lastOutboundMessageAt).toLocaleString() : "none"}\n<b>Active jobs:</b> ${activeJobs.length}\n<b>Reconnect note:</b> ${escapeHtml(session.disconnectReason ?? "none")}`,
      ),
    ),
    keyboard([
      [
        btn(
          "↻ Refresh Health",
          `session:${session.sessionId}:action:health`,
          "primary",
        ),
      ],
      [btn("‹ Session", `session:${session.sessionId}:menu`)],
    ]),
  );
}

async function getSessionGroupAt(
  ctx: Context,
  sessionId: string,
  index: number,
): Promise<Awaited<ReturnType<typeof listGroups>>[number] | undefined> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return undefined;
  const groups = await listGroups(session.workspaceId, session.sessionId);
  return groups[index];
}

async function showSessionGroups(
  ctx: Context,
  sessionId: string,
  page = 0,
): Promise<void> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return deny(ctx);
  try {
    const groups = await listGroups(session.workspaceId, session.sessionId);
    const pageSize = 20;
    const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
    const safePage = Math.max(0, Math.min(pageCount - 1, Math.floor(page)));
    const start = safePage * pageSize;
    const visible = groups.slice(start, start + pageSize);
    const body = visible.length
      ? visible
          .map(
            (group, index) =>
              `<b>${start + index + 1}. ${escapeHtml(group.subject || "Unnamed group")}</b> · ${group.participantCount} participants`,
          )
          .join("\n")
      : "No groups were returned by the connected WhatsApp session.";
    const groupRows = visible.map((group, index) => [
      btn(
        `${String(start + index + 1).padStart(2, "0")} · ${(group.subject || "Unnamed group").replace(/\s+/g, " ").slice(0, 28)}`,
        `session:${session.sessionId}:group:view:${start + index}`,
      ),
    ]);
    const pageControls: Array<ReturnType<typeof btn>> = [];
    if (safePage > 0)
      pageControls.push(btn("‹ Previous", `session:${session.sessionId}:groups:${safePage - 1}`));
    if (safePage + 1 < pageCount)
      pageControls.push(btn("Next ›", `session:${session.sessionId}:groups:${safePage + 1}`));
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · My Groups`,
        infoResponse(
          "Selectable Group Inventory",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Groups:</b> ${groups.length}\n<b>Page:</b> ${safePage + 1}/${pageCount}\n\n${body}\n\nSelect a group to open its detail submenu.`,
        ),
      ),
      keyboard([
        ...groupRows,
        ...(pageControls.length ? [pageControls] : []),
        [
          btn(
            "＋ Create Group",
            `session:${session.sessionId}:action:creategroup`,
            "success",
          ),
          btn(
            "↪ Leave by JID",
            `session:${session.sessionId}:group:leave`,
            "danger",
          ),
        ],
        [
          btn(
            "↻ Refresh Groups",
            `session:${session.sessionId}:groups:${safePage}`,
            "primary",
          ),
        ],
        [btn("‹ Session Control", `session:${session.sessionId}:menu`)],
      ]),
    );
  } catch (error) {
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Groups`,
        dangerResponse(
          "Group Inventory Unavailable",
          `${escapeHtml(error instanceof Error ? error.message : String(error))}\n\nThe WhatsApp session may still be loading its group inventory.`,
        ),
      ),
      keyboard([
        [btn("↻ Retry Groups", `session:${session.sessionId}:groups:0`, "primary")],
        [btn("‹ Session", `session:${session.sessionId}:menu`)],
      ]),
    );
  }
}

async function showSchedulePanel(ctx: Context): Promise<void> {
  const user = resolveTelegramUser(ctx);
  const schedules = await listSchedules(user.workspaceId);
  const rows = schedules.length
    ? schedules
        .map(
          (schedule) =>
            `<b>${escapeHtml(schedule.kind)}</b> · <code>${escapeHtml(schedule.scheduleId.slice(0, 8))}</code>\n` +
            `<b>Status:</b> ${schedule.enabled ? "ACTIVE" : "DISABLED"} · <b>Timezone:</b> ${escapeHtml(schedule.timezone)}\n` +
            `<b>Next:</b> ${new Date(schedule.nextRunAt).toLocaleString()}${schedule.enabled ? "" : ""}`,
        )
        .join("\n\n")
    : "No schedules have been created for this workspace.";
  const buttons = schedules
    .filter((schedule) => schedule.enabled)
    .map((schedule) => [
      btn(
        `■ Disable ${schedule.kind}`,
        `schedule:disable:${schedule.scheduleId}`,
        "danger",
      ),
    ]);
  await edit(
    ctx,
    pageText(
      "Scheduled Jobs",
      infoResponse(
        "Workspace Scheduler",
        `${rows}\n\nSchedules are persisted, claimed atomically, and dispatched through the bounded worker queue.`,
      ),
    ),
    keyboard([
      [btn("＋ Hourly Link Validation", "schedule:new:validation", "primary")],
      ...buttons,
      [btn(ui.back, "menu:main")],
    ]),
  );
}

async function handleScheduleInput(
  ctx: Context,
  pending: { workspaceId: string },
  text: string,
): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  pendingScheduleInput.delete(userId);
  const urls = extractWhatsAppGroupInviteUrls(text).slice(0, 100);
  if (!urls.length || urls.some((url) => !isWhatsAppGroupInviteUrl(url))) {
    await edit(
      ctx,
      pageText(
        "Scheduled Jobs · Invalid Input",
        dangerResponse(
          "No WhatsApp Group Links",
          "Send WhatsApp group invite links from chat.whatsapp.com, one per line.",
        ),
      ),
      keyboard([[btn("↻ Try Again", "schedule:new:validation", "primary")]]),
    );
    return;
  }
  const scheduleId = randomUUID();
  await saveSchedule({
    scheduleId,
    workspaceId: pending.workspaceId,
    kind: "link-validation",
    payload: { urls, sourceUserId: userId },
    timezone: getWorkspaceDefaults(pending.workspaceId).timezone,
    nextRunAt: Date.now() + 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
    enabled: true,
    updatedAt: Date.now(),
  });
  recordAudit({
    workspaceId: pending.workspaceId,
    actorTelegramUserId: userId,
    action: "schedule.create",
    success: true,
    metadata: { scheduleId, kind: "link-validation", urls: urls.length },
  });
  await showSchedulePanel(ctx);
}

async function handleSupportInput(
  ctx: Context,
  pending: { workspaceId: string },
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  pendingSupportInput.delete(actorId);
  if (!text || text.length > 4000) {
    await edit(
      ctx,
      pageText(
        "Support Inbox",
        dangerResponse(
          "Invalid Request",
          "Send between 1 and 4000 characters.",
        ),
      ),
      keyboard([[btn("Try Again", "support:menu", "primary")]]),
    );
    return;
  }
  const now = Date.now();
  const ticketId = randomUUID();
  await createSupportTicket({
    ticketId,
    workspaceId: pending.workspaceId,
    requesterTelegramUserId: actorId,
    message: text,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  recordAudit({
    workspaceId: pending.workspaceId,
    actorTelegramUserId: actorId,
    action: "support.ticket.create",
    success: true,
    metadata: { ticketId },
  });
  await edit(
    ctx,
    pageText(
      "Support Inbox",
      successResponse(
        "Request Stored",
        `<b>Ticket:</b> <code>${ticketId}</code>\nThe owner can review it from Admin Panel → Support Inbox.`,
      ),
    ),
    keyboard([[btn("‹ Dashboard", "menu:main")]]),
  );
}

async function showAdminSupport(ctx: Context): Promise<void> {
  const workspaceId = resolveTelegramUser(ctx).workspaceId;
  const tickets = await listSupportTickets(workspaceId);
  const body = tickets.length
    ? tickets
        .map(
          (ticket) =>
            `<b>${ticket.status === "open" ? "🟡" : ticket.status === "answered" ? "✅" : "⛔"} ${escapeHtml(ticket.ticketId.slice(0, 8))}</b> · ${escapeHtml(ticket.status)}\n<i>${new Date(ticket.updatedAt).toLocaleString()}</i>\n${escapeHtml(ticket.message.slice(0, 500))}${ticket.lastReply ? `\n↳ <i>${escapeHtml(ticket.lastReply.slice(0, 300))}</i>` : ""}`,
        )
        .join("\n\n")
    : "No support tickets are currently stored.";
  const rows = tickets.flatMap((ticket) => {
    const controls =
      ticket.status === "closed"
        ? []
        : [
            btn("↩ Reply", `admin:support:reply:${ticket.ticketId}`, "success"),
            btn("Close", `admin:support:close:${ticket.ticketId}`, "danger"),
          ];
    return controls.length ? [controls] : [];
  });
  rows.push(
    [btn("↻ Refresh", "admin:support", "primary")],
    [btn(ui.back, "admin:panel")],
  );
  await edit(
    ctx,
    pageText("Admin · Support Inbox", infoResponse("Workspace Tickets", body)),
    keyboard(rows),
  );
}

async function handleSupportReply(
  ctx: Context,
  ticketId: string,
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  pendingSupportReply.delete(actorId);
  const workspaceId = resolveTelegramUser(ctx).workspaceId;
  const ticket = (await listSupportTickets(workspaceId)).find(
    (item) => item.ticketId === ticketId,
  );
  if (!ticket) return showAdminSupport(ctx);
  if (!text || text.length > 4000) {
    await edit(
      ctx,
      pageText(
        "Support Inbox · Reply",
        dangerResponse("Invalid Reply", "Send between 1 and 4000 characters."),
      ),
      keyboard([
        [btn("Try Again", `admin:support:reply:${ticketId}`, "primary")],
      ]),
    );
    return;
  }
  let routed = false;
  let routeError = "";
  if (ticket.sessionId && ticket.senderJid) {
    try {
      await sendDirectText(
        workspaceId,
        ticket.sessionId,
        ticket.senderJid,
        text,
      );
      routed = true;
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error);
    }
  }
  await updateSupportTicket(ticketId, {
    status: routed ? "answered" : "open",
    lastReply: text,
  });
  recordAudit({
    workspaceId,
    actorTelegramUserId: actorId,
    action: "support.ticket.reply",
    success: routed,
    metadata: { ticketId, routed, routeError: routeError.slice(0, 160) },
  });
  await edit(
    ctx,
    pageText(
      "Admin · Support Inbox",
      routed
        ? successResponse(
            "Reply Delivered",
            "The response was sent to the WhatsApp sender.",
          )
        : infoResponse(
            "Reply Saved",
            `The reply is stored, but this ticket has no routable WhatsApp session/sender metadata.${routeError ? `\n<code>${escapeHtml(routeError.slice(0, 200))}</code>` : ""}`,
          ),
    ),
    keyboard([[btn("‹ Support Inbox", "admin:support")]]),
  );
}

async function handleAdminBroadcastDraft(
  ctx: Context,
  text: string,
): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  pendingAdminInput.delete(actorId);
  if (!text || text.length > 4096) {
    await edit(
      ctx,
      pageText(
        "Admin · Broadcast",
        dangerResponse(
          "Invalid Broadcast",
          "Send between 1 and 4096 characters.",
        ),
      ),
      keyboard([[btn("↻ Compose Again", "admin:broadcast", "primary")]]),
    );
    return;
  }
  const workspaceId = resolveTelegramUser(ctx).workspaceId;
  pendingAdminBroadcasts.set(actorId, { text, workspaceId });
  const recipients = (await listUsers(1000)).filter(
    (user) => user.status === "active",
  );
  await edit(
    ctx,
    pageText(
      "Admin · Broadcast Preview",
      infoResponse(
        "Confirm Before Sending",
        `<b>Recipients:</b> ${recipients.length}\n<b>Length:</b> ${text.length} characters\n\n<blockquote>${escapeHtml(text)}</blockquote>\n\nNo delivery has occurred yet.`,
      ),
    ),
    keyboard([
      [btn("✅ Confirm Broadcast", "admin:broadcast:confirm", "danger")],
      [btn("✎ Edit", "admin:broadcast", "primary")],
      [btn("Cancel", "admin:broadcast:cancel", "danger")],
    ]),
  );
}

async function getForceJoinGate(ctx: Context): Promise<{
  allowed: boolean;
  targets: ForceJoinTargetRecord[];
  passed: string[];
}> {
  const targets = await listForceJoinTargets(true);
  if (!targets.length) return { allowed: true, targets, passed: [] };
  const passed: string[] = [];
  for (const target of targets) {
    const chatRef = telegramChatReference(target.usernameOrLink);
    if (!chatRef || !ctx.from) continue;
    try {
      const member = await ctx.telegram.getChatMember(chatRef, ctx.from.id);
      if (
        member.status === "creator" ||
        member.status === "administrator" ||
        member.status === "member" ||
        (member.status === "restricted" && member.is_member)
      )
        passed.push(target.targetId);
    } catch {
      // Keep the target required and visible when Telegram cannot verify it.
    }
  }
  return {
    allowed: passed.length === targets.length,
    targets,
    passed,
  };
}

function telegramChatReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("@")) return trimmed;
  const match = trimmed.match(/t\.me\/(?!joinchat|\+)([A-Za-z0-9_]+)/i);
  return match?.[1] ? `@${match[1]}` : undefined;
}

async function showAdminJobs(ctx: Context): Promise<void> {
  const jobs = (await getWorkerRuntime()?.listRecent(100)) ?? [];
  await edit(ctx, adminJobsText(jobs), adminJobsKeyboard(jobs));
}

async function showValidatorHub(ctx: Context): Promise<void> {
  const user = resolveTelegramUser(ctx);
  validatorLiveStates.set(user.workspaceId, false);
  stopValidatorLiveLoops(user.workspaceId);
  const snapshot = await getValidatorSnapshot(user.workspaceId);
  await edit(ctx, validatorDashboardText(snapshot), bucketKeyboard());
}

type ValidatorSessionSummaryBase = {
  capturedAt: number;
  sample: Array<{ sessionId: string; sessionName: string; status: string; authHealth?: string }>;
  totalSessions: number;
  eligibleSessions: number;
  retiredSessions: number;
};

const validatorSessionSummaryCache = new Map<string, ValidatorSessionSummaryBase>();

function validatorSessionView(
  ctx: Context,
  jobs: Array<{ sessionId?: string }>,
  leaseSessionIds: string[] = [],
): {
  sample: Array<{ sessionId: string; sessionName: string; status: string; authHealth?: string }>;
  summary: {
    totalSessions: number;
    eligibleSessions: number;
    leasedSessions: number;
    retiredSessions: number;
  };
} {
  const scope = isAdmin(ctx) ? "__admin__" : resolveTelegramUser(ctx).workspaceId;
  const now = Date.now();
  let base = validatorSessionSummaryCache.get(scope);
  if (!base || now - base.capturedAt > 5_000) {
    const sessions = isAdmin(ctx) ? listAllSessions() : listSessions(scope);
    base = {
      capturedAt: now,
      sample: sessions.slice(0, 12).map((session) => ({
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        status: effectiveSessionStatus(session),
        ...(session.authHealth ? { authHealth: session.authHealth } : {}),
      })),
      totalSessions: sessions.length,
      eligibleSessions: sessions.filter(
        (session) =>
          session.status === "ACTIVE" &&
          session.authHealth !== "INVALID" &&
          (session.validatorRetiredUntil ?? 0) <= now,
      ).length,
      retiredSessions: sessions.filter(
        (session) => (session.validatorRetiredUntil ?? 0) > now,
      ).length,
    };
    validatorSessionSummaryCache.set(scope, base);
  }
  const leasedSessions = new Set([
    ...jobs
      .map((job) => job.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ...leaseSessionIds,
  ]).size;
  return {
    sample: base.sample,
    summary: {
      totalSessions: base.totalSessions,
      eligibleSessions: base.eligibleSessions,
      leasedSessions,
      retiredSessions: base.retiredSessions,
    },
  };
}

async function showValidatorLiveLog(
  ctx: Context,
  active: boolean,
): Promise<void> {
  const user = resolveTelegramUser(ctx);
  validatorLiveStates.set(user.workspaceId, active);
  if (!active) stopValidatorLiveLoops(user.workspaceId);
  const snapshot = await getValidatorSnapshot(user.workspaceId);
  const jobs = ((await getWorkerRuntime()?.listRecent(1000)) ?? []).filter(
    (job) =>
      job.kind === "link-validation" &&
      ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
  );
  const validationSessionView = validatorSessionView(
    ctx,
    jobs,
    snapshot.recent
      .filter((record) => record.bucket === "validating" && record.sourceSessionId)
      .map((record) => record.sourceSessionId as string),
  );
  await edit(
    ctx,
    validatorLiveText(snapshot, active, jobs, validationSessionView.sample, validationSessionView.summary),
    validatorLiveKeyboard(active),
  );
  const message = ctx.callbackQuery?.message;
  const chatId =
    ctx.chat?.id ??
    (message && "chat" in message ? message.chat.id : undefined);
  const messageId =
    message && "message_id" in message ? message.message_id : undefined;
  if (!active || !chatId || !messageId) return;
  const loopKey = `validator-live:${user.workspaceId}:${chatId}:${messageId}`;
  const previous = liveLoops.get(loopKey);
  if (previous) clearInterval(previous);
  const interval = setInterval(() => {
    if (validatorLiveStates.get(user.workspaceId) !== true) {
      stopValidatorLiveLoops(user.workspaceId);
      return;
    }
    void Promise.all([
      getValidatorSnapshot(user.workspaceId),
      getWorkerRuntime()
        ?.listRecent(1000)
        .then((jobs) =>
          jobs.filter(
            (job) =>
              job.kind === "link-validation" &&
              ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
          ),
        ) ?? Promise.resolve([]),
    ])
      .then(([nextSnapshot, nextJobs]) => {
        const nextValidationSessionView = validatorSessionView(
          ctx,
          nextJobs,
          nextSnapshot.recent
            .filter((record) => record.bucket === "validating" && record.sourceSessionId)
            .map((record) => record.sourceSessionId as string),
        );
        void ctx.telegram
          .editMessageText(
            chatId,
            messageId,
            undefined,
            validatorLiveText(nextSnapshot, true, nextJobs, nextValidationSessionView.sample, nextValidationSessionView.summary),
            { parse_mode: "HTML", reply_markup: validatorLiveKeyboard(true) },
          )
          .catch(() => {
            const current = liveLoops.get(loopKey);
            if (current) clearInterval(current);
            liveLoops.delete(loopKey);
          });
      })
      .catch(() => undefined);
  }, 2500);
  liveLoops.set(loopKey, interval);
  setTimeout(() => {
    const current = liveLoops.get(loopKey);
    if (current === interval) {
      clearInterval(interval);
      liveLoops.delete(loopKey);
    }
  }, 120000);
}

function stopValidatorLiveLoops(workspaceId: string): void {
  for (const [key, interval] of liveLoops) {
    if (key.startsWith(`validator-live:${workspaceId}:`)) {
      clearInterval(interval);
      liveLoops.delete(key);
    }
  }
}

async function showGlobalBridge(ctx: Context): Promise<void> {
  const user = resolveTelegramUser(ctx);
  pendingGlobalCommand.delete(String(ctx.from?.id ?? ""));
  globalBridgeActive.delete(user.workspaceId);
  await edit(
    ctx,
    pageText(
      "Global Bridge",
      infoResponse(
        "Active Session Command Bridge",
        "Select ACTIVE WhatsApp sessions, then press Send Command. The Bridge listens only while the command input view is open; closing it stops routing immediately.",
      ),
    ),
    globalBridgeKeyboard(activeWorkspaceSessions(user.workspaceId).length),
  );
}

async function showSessionBridge(
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return deny(ctx);
  await edit(
    ctx,
    pageText(
      "Per-Session Bridge",
      infoResponse(
        "Session-Bound Bridge",
        `<b>Session:</b> ${escapeHtml(session.sessionName)}\n\nThis bridge is bound only to this WhatsApp session. It is separate from the general workspace Global Bridge.`,
      ),
    ),
    keyboard([
      [
        btn(
          "▶ Start Session Bridge",
          `session:${session.sessionId}:bridge:start`,
          "success",
        ),
        btn(
          "✉️ Send Command",
          `session:${session.sessionId}:bridge:command`,
          "primary",
        ),
      ],
      [
        btn(
          "⏹ Stop Session Bridge",
          `session:${session.sessionId}:bridge:stop`,
          "danger",
        ),
      ],
      [btn(ui.back, `session:${session.sessionId}:menu`)],
    ]),
  );
}

async function showJoinManager(ctx: Context, sessionId: string): Promise<void> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return deny(ctx);
  const user = resolveTelegramUser(ctx);
  const key = `${user.workspaceId}:${session.sessionId}`;
  const runtime = getWorkerRuntime();
  let totalGroups: number | undefined;
  let activeLinks: number | undefined;
  const inventoryPromise = Promise.all([
    countValidatorBucket(GLOBAL_VALIDATOR_SCOPE, "active").catch(() => undefined),
    listGroups(session.workspaceId, session.sessionId).catch(() => undefined),
  ]).then(([count, groups]) => {
    activeLinks = count;
    totalGroups = groups?.length;
  });
  const jobId = joinJobs.get(key);
  const job = jobId ? await runtime?.get(jobId) : undefined;
  const status = job
    ? jobStateToJoinStatus(job.state)
    : (joinStates.get(key) ?? "idle");
  const render = (currentJob = job) => {
    const progress = currentJob?.progress;
    const payload = (currentJob?.payload ?? {}) as Record<string, unknown>;
    const target =
      typeof payload.targetCount === "number" ? payload.targetCount : "all";
    const delayMs =
      typeof payload.delayMs === "number" ? `${payload.delayMs}ms` : "default";
    const mode =
      typeof payload.requestMode === "string"
        ? payload.requestMode.toUpperCase()
        : "AUTO";
    const code = currentJob?.jobCode ?? currentJob?.jobId?.slice(0, 8) ?? "—";
    const resolvedTarget = typeof target === "number" ? target : undefined;
    const total = progress?.total ?? (activeLinks !== undefined
      ? Math.min(activeLinks, resolvedTarget ?? activeLinks)
      : target);
    const joined = progress?.joined ?? progress?.success ?? 0;
    const requested = progress?.requested ?? 0;
    const alreadyMember = progress?.alreadyMember ?? 0;
    const deadLinks = progress?.deadLinks ?? 0;
    const rateLimits = progress?.rateLimitHits ?? 0;
    const details = [
      `<b>Session:</b> ${escapeHtml(session.sessionName)}`,
      `<b>Transport:</b> ${escapeHtml(effectiveSessionStatus(session))} · <b>Groups online:</b> ${totalGroups ?? "loading"}`,
      `<b>Active links available:</b> ${activeLinks ?? "loading"}${activeLinks === 0 ? " · <i>No links to join; collect or validate WhatsApp group invites first.</i>" : ""}`,
      `<b>Socket:</b> <code>${escapeHtml(session.sessionId.slice(0, 12))}</code> · generation ${escapeHtml(String(session.socketGeneration ?? "—"))}`,
      `<b>Mode:</b> ${escapeHtml(mode)} · <b>Target:</b> ${escapeHtml(String(target))} · <b>Delay:</b> ${escapeHtml(delayMs)}`,
      `<b>Selection:</b> shuffled across the full shared Active bucket`,
      `<b>Cursor:</b> ${progress?.completed ?? 0}/${escapeHtml(String(total))} · <b>Job:</b> <code>${escapeHtml(code)}</code>`,
      `<b>Joined:</b> ${joined} · <b>Requested:</b> ${requested} · <b>Already member:</b> ${alreadyMember}`,
      `<b>Dead returned to Main:</b> ${deadLinks} · <b>Failed:</b> ${progress?.failed ?? 0} · <b>Retrying:</b> ${progress?.retrying ?? 0}`,
      `<b>Rate limits:</b> ${rateLimits}/5 · <b>Skipped:</b> ${progress?.skipped ?? 0} · <b>Rate:</b> ${(progress?.rate ?? 0).toFixed(2)}/s`,
      `<b>Current link:</b> <code>${escapeHtml(progress?.currentLink ?? "waiting")}</code>`,
      `<b>Action:</b> ${escapeHtml(progress?.currentAction ?? "idle")}`,
      `<b>Last result:</b> ${escapeHtml(progress?.lastResult ?? "No attempt yet.")}`,
      `<b>Worker:</b> ${escapeHtml(currentJob?.state ?? status)}`,
    ].join("\n");
    return pageText(
      "Join Manager · Live",
      infoResponse(
        "Transport-backed Join Control",
        `${details}\n\n<i>Refresh edits this message. Back keeps the worker alive; Stop requests cancellation.</i>`,
      ),
    );
  };
  await edit(ctx, render(), joinManagerKeyboard(session.sessionId, status));
  const message = ctx.callbackQuery?.message;
  const chatId =
    ctx.chat?.id ??
    (message && "chat" in message ? message.chat.id : undefined);
  const messageId =
    message && "message_id" in message ? message.message_id : undefined;
  if (!chatId || !messageId) return;
  if (!jobId || !runtime) {
    void inventoryPromise.then(() =>
      ctx.telegram
        .editMessageText(
          chatId,
          messageId,
          undefined,
          render(),
          { parse_mode: "HTML", reply_markup: joinManagerKeyboard(session.sessionId, status) },
        )
        .catch(() => undefined),
    );
    return;
  }
  const loopKey = `join:${chatId}:${messageId}`;
  const previous = liveLoops.get(loopKey);
  if (previous) clearInterval(previous);
  const interval = setInterval(() => {
    void Promise.all([
      runtime.get(jobId),
      countValidatorBucket(GLOBAL_VALIDATOR_SCOPE, "active").catch(() => undefined),
      listGroups(session.workspaceId, session.sessionId).catch(() => undefined),
    ]).then(([nextJob, nextActiveLinks, nextGroups]) => {
        activeLinks = nextActiveLinks;
        totalGroups = nextGroups?.length;
        if (!nextJob) return;
        const nextStatus = jobStateToJoinStatus(nextJob.state);
        void ctx.telegram
          .editMessageText(
            chatId,
            messageId,
            undefined,
            render(nextJob).replace(
              `Status:</b> ${status}`,
              `Status:</b> ${nextStatus}`,
            ),
            {
              parse_mode: "HTML",
              reply_markup: joinManagerKeyboard(session.sessionId, nextStatus),
            },
          )
          .catch(() => {
            const active = liveLoops.get(loopKey);
            if (active) clearInterval(active);
            liveLoops.delete(loopKey);
          });
        if (
          ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(
            nextJob.state,
          )
        ) {
          clearInterval(interval);
          liveLoops.delete(loopKey);
        }
      })
      .catch(() => undefined);
  }, 1500);
  liveLoops.set(loopKey, interval);
}

function jobStateToJoinStatus(
  state: string,
): "idle" | "running" | "paused" | "stopped" {
  if (state === "PAUSED") return "paused";
  if (["RUNNING", "QUEUED", "RETRYING"].includes(state)) return "running";
  if (["CANCELLED", "FAILED", "COMPLETED", "PARTIAL"].includes(state))
    return "stopped";
  return "idle";
}

async function sendAdminMedia(ctx: Context): Promise<void> {
  await sendOrEdit(
    ctx,
    pageText(
      "Admin Media",
      getAdminMediaOverview(resolveTelegramUser(ctx).workspaceId),
    ),
    mediaKeyboard(),
  );
}

async function showFeature(
  ctx: Context,
  title: string,
  body: string,
): Promise<void> {
  await ctx.answerCbQuery();
  await edit(
    ctx,
    featureText(title, body),
    keyboard([[btn(ui.back, "menu:main")]]),
  );
}

async function deliverWorkloadPairingCode(ctx: Context, workerName: string): Promise<void> {
  const user = resolveTelegramUser(ctx);
  try {
    const pairing = await createWorkloadPairingCode(user.workspaceId, user.telegramUserId, workerName);
    recordAudit({ workspaceId: user.workspaceId, actorTelegramUserId: user.telegramUserId, action: "workload.pairing.create", success: true, metadata: { enrollmentId: pairing.enrollmentId, expiresAt: pairing.expiresAt, workerName } });
    const pairingCode = pairing.pairingCode;
    await edit(
      ctx,
      pageText(
        "Workload · Add Workload",
        successResponse(
          "Pairing code ready",
          `<blockquote><b>Name:</b> <code>${escapeHtml(workerName.trim())}</code>\n<b>1.</b> Tap the copy button below and save this code.\n<b>2.</b> Save the <code>index.js</code> file Telegram sends next.\n<b>3.</b> Upload it to your Node.js panel. Rename it to exactly <code>index.js</code> if necessary.\n<b>4.</b> Click <b>Start</b>. The panel will ask for this code. Paste it in the panel console.\n<b>5.</b> Return here and tap <b>Refresh Status</b>.\n\nThe final workload code will be <code>${escapeHtml(workerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "panel")}-&lt;random&gt;</code>. This pairing code expires after ${Math.round((pairing.expiresAt - Date.now()) / 60_000)} minutes and can be used once.</blockquote>`,
        ),
      ),
      keyboard([
        [copyBtn("📋 Copy Pairing Code", pairingCode, "success")],
        [btn("↻ Refresh Registration", "workload:status")],
        [btn(ui.back, "workload:menu")],
      ]),
    );
    const { readWorkloadPackageDocuments } = await import("../workload/package.js");
    for (const document of await readWorkloadPackageDocuments()) await ctx.replyWithDocument(document);
  } catch (error) {
    await edit(ctx, pageText("Workload · Add Workload", dangerResponse("Could not create pairing code", escapeHtml(error instanceof Error ? error.message : String(error)))), keyboard([[btn(ui.back, "workload:menu")]]));
  }
}

async function sendOrEdit(
  ctx: Context,
  text: string,
  markup: ReturnType<typeof keyboard>,
): Promise<void> {
  if (ctx.callbackQuery) return edit(ctx, text, markup);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
}

async function edit(
  ctx: Context,
  text: string,
  markup: ReturnType<typeof keyboard>,
): Promise<void> {
  const callbackData =
    ctx.callbackQuery && "data" in ctx.callbackQuery
      ? ctx.callbackQuery.data
      : undefined;
  if (typeof callbackData === "string" && callbackData.startsWith("bucket:")) {
    const actor = ctx.from;
    if (actor)
      stopValidatorLiveLoops(resolveUser(String(actor.id)).workspaceId);
  }
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: markup,
    });
  } catch (error) {
    if (ctx.callbackQuery) {
      console.warn(
        `[pappy-omega-mini] Telegram callback view edit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await ctx
      .reply(text, { parse_mode: "HTML", reply_markup: markup })
      .catch(() => undefined);
  }
}

async function resolveTelegramQuotedMedia(
  ctx: Context,
): Promise<WhatsAppMediaPayload | undefined> {
  const quoted = ctx.message && "reply_to_message" in ctx.message
    ? ctx.message.reply_to_message
    : undefined;
  if (!quoted || typeof quoted !== "object") return undefined;
  const source = quoted as unknown as Record<string, unknown>;
  let kind: WhatsAppMediaPayload["kind"] | undefined;
  let fileId: string | undefined;
  let fileName: string | undefined;
  let mimeType: string | undefined;
  let ptt: boolean | undefined;
  const photo = Array.isArray(source.photo)
    ? (source.photo.at(-1) as Record<string, unknown> | undefined)
    : undefined;
  const video = source.video as Record<string, unknown> | undefined;
  const document = source.document as Record<string, unknown> | undefined;
  const audio = source.audio as Record<string, unknown> | undefined;
  const sticker = source.sticker as Record<string, unknown> | undefined;
  if (photo) {
    kind = "image";
    fileId = typeof photo.file_id === "string" ? photo.file_id : undefined;
    mimeType = "image/jpeg";
  } else if (video) {
    kind = "video";
    fileId = typeof video.file_id === "string" ? video.file_id : undefined;
    mimeType = typeof video.mime_type === "string" ? video.mime_type : "video/mp4";
  } else if (document) {
    kind = "document";
    fileId = typeof document.file_id === "string" ? document.file_id : undefined;
    fileName = typeof document.file_name === "string" ? document.file_name : undefined;
    mimeType = typeof document.mime_type === "string" ? document.mime_type : undefined;
  } else if (audio) {
    kind = "audio";
    fileId = typeof audio.file_id === "string" ? audio.file_id : undefined;
    fileName = typeof audio.file_name === "string" ? audio.file_name : undefined;
    mimeType = typeof audio.mime_type === "string" ? audio.mime_type : "audio/mpeg";
    ptt = audio.voice === true;
  } else if (sticker) {
    kind = "sticker";
    fileId = typeof sticker.file_id === "string" ? sticker.file_id : undefined;
    mimeType = typeof sticker.is_animated === "boolean" && sticker.is_animated ? "application/x-tgsticker" : "image/webp";
  }
  if (!kind || !fileId) return undefined;
  const file = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(file.href);
  if (!response.ok) throw new Error(`Telegram quoted media download failed with ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const caption = typeof source.caption === "string" ? source.caption : undefined;
  return {
    kind,
    bytes,
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
    ...(ptt !== undefined ? { ptt } : {}),
  };
}

function resolveTelegramUser(ctx: Context) {
  if (!ctx.from) throw new Error("Telegram actor is required.");
  return resolveUser(
    String(ctx.from.id),
    ctx.from.first_name,
    ctx.from.username,
  );
}

function ownedSession(ctx: Context, sessionId: string) {
  try {
    return getSession(resolveTelegramUser(ctx).workspaceId, sessionId);
  } catch {
    return undefined;
  }
}

function isBridgeReadySession(session: ReturnType<typeof listAllSessions>[number]): boolean {
  return session.status === "ACTIVE";
}

function normalizeBridgeCommand(input: string, sessionPrefix: string): string {
  const trimmed = input.trim();
  const prefix = sessionPrefix || ".";
  const body = trimmed.startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : trimmed.startsWith(".")
      ? trimmed.slice(1)
      : trimmed;
  return `${prefix}${body}`;
}

function activeWorkspaceSessions(workspaceId: string) {
  return listSessions(workspaceId).filter(isBridgeReadySession);
}

function activeAllSessions() {
  return listAllSessions().filter(isBridgeReadySession);
}

function isAdmin(ctx: Context): boolean {
  return Boolean(ctx.from && ownerTelegramIds.has(String(ctx.from.id)));
}

function requireAdmin(ctx: Context): boolean {
  if (isAdmin(ctx)) return true;
  if (ctx.callbackQuery) {
    void ctx.answerCbQuery("Owner only.", { show_alert: true });
  } else {
    void ctx.reply("Owner-only operation.").catch(() => undefined);
  }
  return false;
}

function deny(ctx: Context): void {
  if (ctx.callbackQuery) {
    void ctx.answerCbQuery("This action is not available for your workspace.", {
      show_alert: true,
    });
  } else {
    void ctx.reply("This action is not available for your workspace.").catch(() => undefined);
  }
}

function parseJoinSetting(
  field: JoinSettingField,
  raw: string,
  current: SessionJoinSettings,
): { patch?: Partial<SessionJoinSettings>; error?: string } {
  const value = raw.trim();
  const wholeNumber = (min: number, max: number): number | undefined => {
    if (!/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max
      ? parsed
      : undefined;
  };
  const seconds = (min: number, max: number): number | undefined => {
    const parsed = wholeNumber(min, max);
    return parsed === undefined ? undefined : parsed * 1000;
  };
  switch (field) {
    case "target": {
      const parsed = wholeNumber(1, 10000);
      return parsed === undefined
        ? { error: "Target must be a whole number from 1 to 10,000." }
        : { patch: { targetCount: parsed } };
    }
    case "delay": {
      const parsed = seconds(0, 600);
      return parsed === undefined
        ? { error: "Delay must be whole seconds from 0 to 600." }
        : { patch: { delayMs: parsed } };
    }
    case "minDelay": {
      const parsed = seconds(0, 600);
      if (parsed === undefined) return { error: "Minimum delay must be whole seconds from 0 to 600." };
      if (parsed > current.maxDelayMs) return { error: "Minimum delay cannot exceed maximum delay." };
      return { patch: { minDelayMs: parsed } };
    }
    case "maxDelay": {
      const parsed = seconds(0, 600);
      if (parsed === undefined) return { error: "Maximum delay must be whole seconds from 0 to 600." };
      if (parsed < current.minDelayMs) return { error: "Maximum delay cannot be below minimum delay." };
      return { patch: { maxDelayMs: parsed } };
    }
    case "batch": {
      const parsed = wholeNumber(1, 20);
      return parsed === undefined
        ? { error: "Batch cycles must be a whole number from 1 to 20." }
        : { patch: { batchCycles: parsed } };
    }
    case "retry": {
      const parsed = wholeNumber(0, 5);
      return parsed === undefined
        ? { error: "Retry attempts must be a whole number from 0 to 5." }
        : { patch: { retryLimit: parsed } };
    }
    case "retryBase": {
      const parsed = seconds(1, 600);
      return parsed === undefined
        ? { error: "Retry backoff must be whole seconds from 1 to 600." }
        : { patch: { retryBaseMs: parsed } };
    }
    case "cooldown": {
      const parsed = seconds(0, 3600);
      return parsed === undefined
        ? { error: "Cooldown must be whole seconds from 0 to 3,600." }
        : { patch: { sessionCooldownMs: parsed } };
    }
    case "restriction": {
      const parsed = wholeNumber(1, 20);
      return parsed === undefined
        ? { error: "Restriction threshold must be a whole number from 1 to 20." }
        : { patch: { restrictionThreshold: parsed } };
    }
    case "concurrency": {
      const parsed = wholeNumber(1, 8);
      return parsed === undefined
        ? { error: "Concurrency must be a whole number from 1 to 8." }
        : { patch: { maxConcurrency: parsed } };
    }
    case "mode": {
      const normalized = value.toLowerCase();
      return normalized === "auto" || normalized === "immediate" || normalized === "request"
        ? { patch: { mode: normalized } }
        : { error: "Mode must be auto, immediate, or request." };
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function enqueueValidatorJobs(
  _runtime: NonNullable<ReturnType<typeof getWorkerRuntime>>,
  _workspaceId: string,
  urls: string[],
  _sourceUserId: string,
): Promise<JobRecord[]> {
  if (!urls.length) return [];
  await runValidatorSweepNow();
  return (await getWorkerRuntime()?.listRecent(1000) ?? []).filter(
    (job) =>
      job.kind === "link-validation" &&
      ["QUEUED", "RUNNING", "RETRYING"].includes(job.state),
  );
}


async function showOwnerAutoPromoteDashboard(ctx: Context): Promise<void> {
  const [configs, runs] = await Promise.all([
    listAutoPromoteConfigs({ limit: 200 }),
    listAutoPromoteRuns({ limit: 50 }),
  ]);
  await edit(ctx, autoPromoteText(configs, runs), autoPromoteDashboardKeyboard(configs, "admin:autopromote:new", "admin:panel"));
}

async function showAutoPromoteDashboard(
  ctx: Context,
  ownerTelegramUserId: string,
  workspaceId: string,
): Promise<void> {
  const [configs, runs] = await Promise.all([
    listAutoPromoteConfigs({ ownerTelegramUserId, limit: 100 }),
    listAutoPromoteRuns({ ownerTelegramUserId, limit: 20 }),
  ]);
  await edit(ctx, autoPromoteText(configs, runs), autoPromoteDashboardKeyboard(configs));
}

function autoPromoteWizardSummary(state: AutoPromoteWizard): string {
  const slots = state.timesPerDay
    ? state.timesPerDay === 1
      ? "Evening"
      : state.timesPerDay === 2
        ? "Morning · Evening"
        : state.timesPerDay === 3
          ? "Morning · Afternoon · Evening"
          : state.timesPerDay === 4
            ? "Morning · Afternoon · Evening · Night"
            : "Morning · Afternoon · Evening · Night · Late Night"
    : "—";
  return infoResponse(
    "Review Before Creation",
    `<b>Scope:</b> ${escapeHtml(state.scope)}\n` +
      `<b>Command:</b> ${escapeHtml(state.command?.toUpperCase() ?? "—")}\n` +
      `<b>Duration:</b> ${state.days ?? "—"} days\n` +
      `<b>Times/day:</b> ${state.timesPerDay ?? "—"}\n` +
      (state.command === "allstatusx" ? `<b>Posts/group:</b> ${state.allstatusxPostsPerGroup ?? "—"}\n` : "") +
      `<b>Timezone:</b> Africa/Lagos\n` +
      `<b>Schedule:</b> ${slots}\n` +
      `<b>Payload:</b> <blockquote>${escapeHtml(state.payloadText ?? "")}</blockquote>`,
  );
}


async function renderSessionOverview(
  ctx: Context,
  session: ReturnType<typeof getSession> extends infer T ? Exclude<T, undefined> : never,
): Promise<string> {
  const user = resolveTelegramUser(ctx);
  const [configs, runs] = await Promise.all([
    listAutoPromoteConfigs({ limit: 500 }),
    listAutoPromoteRuns({ sessionId: session.sessionId, limit: 200 }),
  ]);
  const sessionConfig = configs.find(
    (config) => config.scope === "SESSION" && config.sessionId === session.sessionId,
  );
  const userConfig = configs.find(
    (config) => config.scope === "USER" && config.ownerTelegramUserId === user.telegramUserId,
  );
  const globalConfig = configs.find(
    (config) => config.scope === "GLOBAL" && (config.targetSessionIds ?? []).includes(session.sessionId),
  );
  const stateFor = (config: typeof sessionConfig): string => {
    if (!config) return "NONE";
    const run = runs.find((item) => item.configId === config.id && ["RUNNING", "QUEUED", "COOLDOWN"].includes(item.status));
    return run?.status ?? config.state;
  };
  const relevantRuns = runs.filter((run) => [sessionConfig?.id, userConfig?.id, globalConfig?.id].includes(run.configId));
  const nextExecution = relevantRuns
    .filter((run) => run.status === "SCHEDULED" || run.status === "WAITING_FOR_SESSION")
    .map((run) => run.scheduledAt)
    .sort((a, b) => a - b)[0];
  const cooldownUntil = relevantRuns
    .filter((run) => run.status === "COOLDOWN" && run.cooldownUntil)
    .map((run) => run.cooldownUntil as number)
    .sort((a, b) => b - a)[0];
  return sessionText(session, {
    sessionState: stateFor(sessionConfig),
    userState: stateFor(userConfig),
    globalState: stateFor(globalConfig),
    ...(nextExecution ? { nextExecution } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
  });
}
