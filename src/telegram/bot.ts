import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { env, ownerTelegramIds } from "../config/env.js";
import {
  resolveUser,
  listSessions,
  listAllSessions,
  createSession,
  getSession,
  updateSession,
  setUserStatusLocal,
  getWorkspaceDefaults,
  updateWorkspaceDefaults,
} from "../core/session-registry.js";
import {
  getAdminMediaOverview,
  uploadWhatsappMenuMedia,
} from "../admin/media-actions.js";
import { getWorkerRuntime } from "../jobs/runtime.js";
import {
  getEmergencyState,
  listAuditEvents,
  recordAudit,
  setEmergencyState,
} from "../core/control-plane.js";
import { getValidatorSnapshot } from "../links/validator-snapshot.js";
import { exportBucket } from "../links/link-export.js";
import { randomUUID } from "node:crypto";
import {
  deletePairingRequest,
  disableSchedule,
  getPairingRequest,
  listForceJoinTargets,
  listSchedules,
  listUsers,
  removeForceJoinTarget,
  savePairingRequest,
  saveSchedule,
  setForceJoinTargetEnabled,
  setUserStatus,
  upsertForceJoinTarget,
  type ForceJoinTargetRecord,
} from "../persistence/mongo.js";
import { requestWhatsAppPairingCode } from "../whatsapp/session-manager.js";
import { listGroups } from "../whatsapp/transport-adapter.js";
import {
  createCommandRegistry,
  executeCommand,
} from "../whatsapp/command-registry.js";
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
  adminBridgeKeyboard,
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
  featureText,
  globalBridgeKeyboard,
  globalBridgeText,
  globalBridgeResultText,
  validatorLiveKeyboard,
  validatorLiveText,
  helpText,
  joinManagerKeyboard,
  linkCollectionKeyboard,
  mediaKeyboard,
  pageText,
  sessionKeyboard,
  sessionText,
  sessionsKeyboard,
  btn,
  keyboard,
  ui,
} from "./ui.js";
import {
  dangerResponse,
  infoResponse,
  successResponse,
  warningResponse,
} from "./renderer.js";

const pendingMedia = new Map<string, "image" | "video">();
const globalBridgeSelections = new Map<string, Set<string>>();
const globalBridgeActive = new Set<string>();
const joinStates = new Map<string, "idle" | "running" | "paused" | "stopped">();
const joinJobs = new Map<string, string>();
const liveLoops = new Map<string, ReturnType<typeof setInterval>>();
const validatorLiveStates = new Map<string, boolean>();
const pendingAdminInput = new Map<
  string,
  "forcejoin:add" | "broadcast:compose"
>();
const pendingAdminBroadcasts = new Map<
  string,
  { text: string; workspaceId: string }
>();
const pendingScheduleInput = new Map<string, { workspaceId: string }>();
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

export function createTelegramBot(): Telegraf<Context> {
  if (!env.TELEGRAM_BOT_TOKEN)
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const bot = new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN);

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

  bot.command("help", async (ctx) =>
    ctx.reply(helpText(), {
      parse_mode: "HTML",
      reply_markup: keyboard([[btn(ui.back, "menu:main")]]),
    }),
  );
  bot.command("pair", async (ctx) =>
    startPairing(ctx, ctx.message.text.split(/\s+/).slice(1).join(" ").trim()),
  );
  bot.command("sessions", async (ctx) => sendSessions(ctx, 0));
  bot.command("adminmedia", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await sendAdminMedia(ctx);
  });

  bot.on("text", async (ctx) => {
    const userId = String(ctx.from.id);
    const pairing =
      pendingPairing.get(userId) ??
      (await getPairingRequest(userId).catch(() => undefined));
    if (pairing && !ctx.message.text.startsWith("/")) {
      await handlePairingText(ctx, pairing, ctx.message.text.trim());
      return;
    }
    const adminInput = pendingAdminInput.get(userId);
    if (adminInput === "forcejoin:add" && !ctx.message.text.startsWith("/")) {
      await handleForceJoinAdminInput(ctx, ctx.message.text.trim());
      return;
    }
    if (
      adminInput === "broadcast:compose" &&
      !ctx.message.text.startsWith("/")
    ) {
      await handleAdminBroadcastDraft(ctx, ctx.message.text.trim());
      return;
    }
    const scheduleInput = pendingScheduleInput.get(userId);
    if (scheduleInput && !ctx.message.text.startsWith("/")) {
      await handleScheduleInput(ctx, scheduleInput, ctx.message.text.trim());
      return;
    }
    const pending = pendingGlobalCommand.get(userId);
    if (!pending || ctx.message.text.startsWith("/")) return;
    const user = resolveTelegramUser(ctx);
    if (user.workspaceId !== pending.workspaceId) return;
    const selected =
      globalBridgeSelections.get(user.workspaceId) ?? new Set<string>();
    const sessions = listSessions(user.workspaceId).filter((session) =>
      selected.has(session.sessionId),
    );
    const registry = createCommandRegistry();
    const results = await Promise.all(
      sessions.map(async (session) => {
        try {
          const output = await executeCommand(registry, ctx.message.text, {
            workspaceId: user.workspaceId,
            sessionId: session.sessionId,
            isOwner: isAdmin(ctx),
            args: [],
          });
          return { sessionName: session.sessionName, ok: true, output };
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

  bot.on("photo", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "image")
      return ctx.reply("Open Admin Panel → Media → Add Image first.");
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const file = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(file.href);
    const media = await uploadWhatsappMenuMedia({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      fileName: `whatsapp-menu-${photo.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
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
    if (!requireAdmin(ctx)) return;
    const kind = pendingMedia.get(String(ctx.from.id));
    if (kind !== "video")
      return ctx.reply("Open Admin Panel → Media → Add Video first.");
    const file = await ctx.telegram.getFileLink(ctx.message.video.file_id);
    const response = await fetch(file.href);
    const media = await uploadWhatsappMenuMedia({
      workspaceId: resolveTelegramUser(ctx).workspaceId,
      fileName: `whatsapp-menu-${ctx.message.video.file_unique_id}.mp4`,
      mimeType: ctx.message.video.mime_type ?? "video/mp4",
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
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

  bot.action(/^session:([^:]+):menu$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      sessionText(session),
      sessionKeyboard(session, isAdmin(ctx)),
    );
  });
  bot.action(/^session:view:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      sessionText(session),
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
    if (action === "join") return showJoinManager(ctx, session.sessionId);
    if (action === "groups") return showSessionGroups(ctx, session.sessionId);
    if (action === "health") return showSessionHealth(ctx, session.sessionId);
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
    const selected =
      globalBridgeSelections.get(user.workspaceId) ?? new Set<string>();
    await edit(
      ctx,
      pageText(
        "Global Bridge · Choose Sessions",
        infoResponse(
          "Workspace Bridge",
          "Select any owned sessions for one general bridge. This is separate from each session’s own Bridge control.",
        ),
      ),
      bridgeSessionPicker(listSessions(user.workspaceId), selected),
    );
  });
  bot.action(/^bridge:global:toggle:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    const selected =
      globalBridgeSelections.get(user.workspaceId) ?? new Set<string>();
    if (selected.has(session.sessionId)) selected.delete(session.sessionId);
    else selected.add(session.sessionId);
    globalBridgeSelections.set(user.workspaceId, selected);
    await edit(
      ctx,
      pageText(
        "Global Bridge · Choose Sessions",
        infoResponse(
          "Selection Updated",
          `${selected.size} session${selected.size === 1 ? "" : "s"} selected.`,
        ),
      ),
      bridgeSessionPicker(listSessions(user.workspaceId), selected),
    );
  });
  bot.action("bridge:global:clear", async (ctx) => {
    await ctx.answerCbQuery("Selection cleared");
    globalBridgeSelections.delete(resolveTelegramUser(ctx).workspaceId);
    await showGlobalBridge(ctx);
  });
  bot.action("bridge:global:command", async (ctx) => {
    await ctx.answerCbQuery();
    const user = resolveTelegramUser(ctx);
    const selected =
      globalBridgeSelections.get(user.workspaceId) ?? new Set<string>();
    if (!selected.size)
      return edit(
        ctx,
        globalBridgeText(0, false),
        bridgeSessionPicker(listSessions(user.workspaceId), selected),
      );
    if (!globalBridgeActive.has(user.workspaceId))
      return edit(
        ctx,
        globalBridgeText(selected.size, false).replace(
          "</blockquote>",
          "\n\n⚠️ Turn Fan-Out ON before sending a command.</blockquote>",
        ),
        globalBridgeKeyboard(listSessions(user.workspaceId).length, false),
      );
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
      globalBridgeText(selected.size, true).replace(
        "</blockquote>",
        "\n\n✍️ Send one WhatsApp command now, for example <code>ping</code> or <code>autojoin on</code>.</blockquote>",
      ),
      keyboard([[btn("✖ Cancel Input", "bridge:global")]]),
    );
  });
  bot.action("bridge:global:toggle", async (ctx) => {
    await ctx.answerCbQuery();
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    const selected =
      globalBridgeSelections.get(workspaceId) ?? new Set<string>();
    if (!selected.size)
      return edit(
        ctx,
        globalBridgeText(0, false),
        bridgeSessionPicker(listSessions(workspaceId), selected),
      );
    if (globalBridgeActive.has(workspaceId))
      globalBridgeActive.delete(workspaceId);
    else globalBridgeActive.add(workspaceId);
    await edit(
      ctx,
      globalBridgeText(selected.size, globalBridgeActive.has(workspaceId)),
      globalBridgeKeyboard(
        listSessions(workspaceId).length,
        globalBridgeActive.has(workspaceId),
      ),
    );
  });
  bot.action("bridge:global:start", async (ctx) => {
    await ctx.answerCbQuery();
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    if (!globalBridgeSelections.get(workspaceId)?.size)
      return edit(
        ctx,
        globalBridgeText(0, false),
        bridgeSessionPicker(listSessions(workspaceId), new Set<string>()),
      );
    globalBridgeActive.add(workspaceId);
    await edit(
      ctx,
      globalBridgeText(
        globalBridgeSelections.get(workspaceId)?.size ?? 0,
        true,
      ),
      globalBridgeKeyboard(listSessions(workspaceId).length, true),
    );
  });
  bot.action("bridge:global:stop", async (ctx) => {
    await ctx.answerCbQuery();
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    globalBridgeActive.delete(workspaceId);
    pendingGlobalCommand.delete(String(ctx.from?.id ?? ""));
    await edit(
      ctx,
      globalBridgeText(
        globalBridgeSelections.get(workspaceId)?.size ?? 0,
        false,
      ),
      globalBridgeKeyboard(listSessions(workspaceId).length, false),
    );
  });

  bot.action("bucket:status", async (ctx) => {
    await ctx.answerCbQuery();
    await showValidatorHub(ctx);
  });
  bot.action("ui:validator", async (ctx) => {
    await ctx.answerCbQuery();
    await showValidatorHub(ctx);
  });
  bot.action("bucket:live", async (ctx) => {
    await ctx.answerCbQuery();
    await showValidatorLiveLog(ctx, false);
  });
  bot.action("bucket:live:on", async (ctx) => {
    await ctx.answerCbQuery("Live log enabled");
    await showValidatorLiveLog(ctx, true);
  });
  bot.action("bucket:live:off", async (ctx) => {
    await ctx.answerCbQuery("Live log stopped");
    await showValidatorLiveLog(ctx, false);
  });
  bot.action("bucket:live:refresh", async (ctx) => {
    await ctx.answerCbQuery();
    const workspaceId = resolveTelegramUser(ctx).workspaceId;
    await showValidatorLiveLog(
      ctx,
      validatorLiveStates.get(workspaceId) === true,
    );
  });
  bot.action("bucket:downloads", async (ctx) => {
    await ctx.answerCbQuery("Preparing exports…");
    const user = resolveTelegramUser(ctx);
    try {
      const [txt, html] = await Promise.all([
        exportBucket(user.workspaceId, "master", "txt"),
        exportBucket(user.workspaceId, "master", "html"),
      ]);
      await ctx.replyWithDocument({
        source: Buffer.from(txt.content, "utf8"),
        filename: txt.fileName,
      });
      await ctx.replyWithDocument({
        source: Buffer.from(html.content, "utf8"),
        filename: html.fileName,
      });
      recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "validator.bucket.export",
        success: true,
        metadata: { bucket: "master", formats: "txt,html" },
      });
      await showValidatorHub(ctx);
    } catch (error) {
      recordAudit({
        workspaceId: user.workspaceId,
        actorTelegramUserId: String(ctx.from?.id ?? ""),
        action: "validator.bucket.export",
        success: false,
        metadata: {
          error:
            error instanceof Error
              ? error.message.slice(0, 120)
              : String(error),
        },
      });
      await edit(
        ctx,
        pageText(
          "Validator Hub",
          dangerResponse(
            "Export Failed",
            escapeHtml(error instanceof Error ? error.message : String(error)),
          ),
        ),
        bucketKeyboard(),
      );
    }
  });
  bot.action(/^bucket:(view|purge|merge)/, async (ctx) => {
    await ctx.answerCbQuery();
    await edit(
      ctx,
      pageText(
        "Validator Hub",
        infoResponse(
          "Worker Operation",
          `The requested bucket operation <code>${escapeHtml(ctx.match[0] ?? "operation")}</code> is workspace-scoped and protected by confirmation where destructive.`,
        ),
      ),
      bucketKeyboard(),
    );
  });

  bot.action(/^session:([^:]+):collect$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      pageText(
        "Link Collection",
        infoResponse(
          "Session Collector",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Mode:</b> always-on collection into this workspace’s validation queue\n<b>Status:</b> ready for bounded collection`,
        ),
      ),
      linkCollectionKeyboard(session.sessionId),
    );
  });
  bot.action(/^session:([^:]+):collect:live$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = ownedSession(ctx, ctx.match[1] ?? "");
    if (!session) return deny(ctx);
    await edit(
      ctx,
      pageText(
        "Link Collection · Live",
        infoResponse(
          "Live Feed",
          `Watching link collection for <b>${escapeHtml(session.sessionName)}</b>. The feed is isolated to this session and its workspace.`,
        ),
      ),
      linkCollectionKeyboard(session.sessionId),
    );
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
          "Send one or more HTTP, HTTPS, or WhatsApp invite links separated by new lines. The schedule will run hourly until disabled.",
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
  bot.action("support:menu", async (ctx) =>
    showFeature(
      ctx,
      "Support",
      "Support requests are workspace-aware and never expose another user’s session data.",
    ),
  );
  bot.action("ui:schedule", async (ctx) =>
    showFeature(
      ctx,
      "Scheduled Jobs",
      "Create timezone-aware jobs for owned sessions.",
    ),
  );
  bot.action("ui:settings", async (ctx) => {
    await ctx.answerCbQuery();
    const settings = getWorkspaceDefaults(resolveTelegramUser(ctx).workspaceId);
    await edit(
      ctx,
      workspaceSettingsText(settings),
      workspaceSettingsKeyboard(settings),
    );
  });
  bot.action("ui:support", async (ctx) =>
    showFeature(ctx, "Support", "Workspace-aware support requests."),
  );
  bot.action("ui:join", async (ctx) =>
    showFeature(
      ctx,
      "Join Manager",
      "Open a session first. Join Manager is permanently bound to the selected WhatsApp session and uses the Active bucket.",
    ),
  );

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
    /^session:([^:]+):join:(start|pause|stop|setlimit|setdelay|setbatch)$/,
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
        const settings = getWorkspaceDefaults(user.workspaceId);
        const job = await runtime.enqueue({
          workspaceId: user.workspaceId,
          sessionId: session.sessionId,
          kind: "join-manager",
          payload: { targetCount: 100, delayMs: settings.defaultJoinDelayMs },
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
      if (operation.startsWith("set"))
        return edit(
          ctx,
          pageText(
            "Join Manager · Configure",
            infoResponse(
              "Session-Bound Setting",
              "Use Workspace Settings to change the default delay and auto-join behavior for all owned sessions. This selected session remains the worker target.",
            ),
          ),
          keyboard([[btn(ui.back, `session:${session.sessionId}:joinmgr`)]]),
        );
      await showJoinManager(ctx, session.sessionId);
    },
  );

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
    const sessions = listAllSessions();
    await edit(ctx, adminBridgeText(sessions), adminBridgeKeyboard(sessions));
  });
  bot.action(/^admin:bridge:session:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const workspaceId = ctx.match[1] ?? "";
    const sessionId = ctx.match[2] ?? "";
    const session = listAllSessions().find(
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
      keyboard([[btn("↻ Back to Global Bridge", "admin:bridge", "primary")]]),
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
    await showAdminForceJoin(ctx);
  });
  bot.action("admin:forcejoin:add", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingAdminInput.set(String(ctx.from?.id ?? ""), "forcejoin:add");
    await edit(
      ctx,
      pageText(
        "Admin · Add Force Join",
        infoResponse(
          "Send Target Details",
          "Send one line in this format:\n<code>channel | @username-or-link | Display Name | Button Text</code>\n\nUse a public @username or numeric chat ID when automatic membership verification is required.",
        ),
      ),
      keyboard([[btn(ui.back, "admin:forcejoin")]]),
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
    await ctx.reply(
      pageText(
        "Force Join Target",
        infoResponse(
          target.displayName,
          `<code>${escapeHtml(target.usernameOrLink)}</code>\n\nOpen the target, join it, then return and press Check Membership.`,
        ),
      ),
      { parse_mode: "HTML", reply_markup: forceJoinKeyboard([target]) },
    );
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
    await edit(
      ctx,
      pageText(
        "WhatsApp Menu Media",
        infoResponse(
          "Media Catalog",
          getAdminMediaOverview(resolveTelegramUser(ctx).workspaceId),
        ),
      ),
      mediaKeyboard(),
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

async function beginPairingWizard(ctx: Context): Promise<void> {
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
  try {
    const session = getSession(resolveTelegramUser(ctx).workspaceId, sessionId);
    updateSession(resolveTelegramUser(ctx).workspaceId, sessionId, {
      phoneNumber: normalizedPhone,
      status: "PAIRING",
    });
    clearPendingPairing(userId);
    const code = await requestWhatsAppPairingCode(
      session.workspaceId,
      session.sessionId,
      normalizedPhone,
    );
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
        [btn("↻ Session Status", `session:${session.sessionId}:menu`)],
        [btn(ui.back, "sessions:list:0")],
      ]),
    );
  } catch (error) {
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
        [btn(ui.back, "sessions:list:0")],
      ]),
    );
  }
}

async function sendSessions(ctx: Context, page: number): Promise<void> {
  const user = resolveTelegramUser(ctx);
  const sessions = listSessions(user.workspaceId);
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

async function handleForceJoinAdminInput(
  ctx: Context,
  text: string,
): Promise<void> {
  pendingAdminInput.delete(String(ctx.from?.id ?? ""));
  const [type, target, displayName, buttonText] = text
    .split("|")
    .map((value) => value.trim());
  if (!["channel", "group"].includes(type ?? "") || !target || !displayName) {
    await edit(
      ctx,
      pageText(
        "Admin · Force Join",
        dangerResponse(
          "Invalid Target Format",
          "Use <code>channel | @username | Display Name | Button Text</code> and try again.",
        ),
      ),
      keyboard([[btn("↻ Add Target", "admin:forcejoin:add", "success")]]),
    );
    return;
  }
  await upsertForceJoinTarget({
    targetType: type as "channel" | "group",
    usernameOrLink: target,
    displayName,
    buttonText: buttonText || displayName,
  });
  recordAudit({
    workspaceId: resolveTelegramUser(ctx).workspaceId,
    actorTelegramUserId: String(ctx.from?.id ?? ""),
    action: "admin.forcejoin.add",
    success: true,
    metadata: {
      targetType: type ?? "",
      target: target?.slice(0, 120) ?? "",
    },
  });
  await showAdminForceJoin(ctx);
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
      ["QUEUED", "RUNNING", "PAUSED", "RETRYING"].includes(job.state),
  );
  await edit(
    ctx,
    pageText(
      `${session.sessionName} · Health`,
      infoResponse(
        "Session Diagnostics",
        `<b>Status:</b> ${escapeHtml(session.status)}\n<b>Phone:</b> ${escapeHtml(session.phoneNumber ?? "not paired")}\n<b>Prefix:</b> <code>${escapeHtml(session.prefix || "none")}</code>\n<b>Connected:</b> ${session.connectedAt ? new Date(session.connectedAt).toLocaleString() : "not recorded"}\n<b>Last healthy:</b> ${session.lastHealthyAt ? new Date(session.lastHealthyAt).toLocaleString() : "not recorded"}\n<b>Active jobs:</b> ${activeJobs.length}\n<b>Reconnect note:</b> ${escapeHtml(session.disconnectReason ?? "none")}`,
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

async function showSessionGroups(
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const session = ownedSession(ctx, sessionId);
  if (!session) return deny(ctx);
  try {
    const groups = await listGroups(session.workspaceId, session.sessionId);
    const body = groups.length
      ? groups
          .map(
            (group, index) =>
              `<b>${index + 1}. ${escapeHtml(group.subject)}</b>\n<code>${escapeHtml(group.jid)}</code> · ${group.participantCount} participants`,
          )
          .join("\n\n")
      : "No groups were returned by the connected WhatsApp session.";
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Groups`,
        infoResponse(
          "Live Group Inventory",
          `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Groups:</b> ${groups.length}\n\n${body}`,
        ),
      ),
      keyboard([
        [
          btn(
            "↻ Refresh Groups",
            `session:${session.sessionId}:action:groups`,
            "primary",
          ),
        ],
        [btn("‹ Session", `session:${session.sessionId}:menu`)],
      ]),
    );
  } catch (error) {
    await edit(
      ctx,
      pageText(
        `${session.sessionName} · Groups`,
        dangerResponse(
          "Group Inventory Unavailable",
          escapeHtml(error instanceof Error ? error.message : String(error)),
        ),
      ),
      keyboard([[btn("‹ Session", `session:${session.sessionId}:menu`)]]),
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
  const urls = text
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!urls.length || urls.some((url) => !/^https?:\/\//i.test(url))) {
    await edit(
      ctx,
      pageText(
        "Scheduled Jobs · Invalid Input",
        dangerResponse(
          "No Valid Links",
          "Send HTTP or HTTPS links, one per line.",
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
  const snapshot = await getValidatorSnapshot(user.workspaceId);
  await edit(ctx, validatorDashboardText(snapshot), bucketKeyboard());
}

async function showValidatorLiveLog(
  ctx: Context,
  active: boolean,
): Promise<void> {
  const user = resolveTelegramUser(ctx);
  validatorLiveStates.set(user.workspaceId, active);
  if (!active) stopValidatorLiveLoops(user.workspaceId);
  const snapshot = await getValidatorSnapshot(user.workspaceId);
  await edit(
    ctx,
    validatorLiveText(snapshot, active),
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
    void getValidatorSnapshot(user.workspaceId)
      .then((nextSnapshot) => {
        void ctx.telegram
          .editMessageText(
            chatId,
            messageId,
            undefined,
            validatorLiveText(nextSnapshot, true),
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
  await edit(
    ctx,
    pageText(
      "Global Bridge",
      infoResponse(
        "General Workspace Bridge",
        "Select multiple owned WhatsApp sessions for one workspace-wide bridge. For a bridge tied to one WhatsApp session, open Sessions and use that session’s Bridge action.",
      ),
    ),
    globalBridgeKeyboard(listSessions(user.workspaceId).length),
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
  const jobId = joinJobs.get(key);
  const job = jobId ? await runtime?.get(jobId) : undefined;
  const status = job
    ? jobStateToJoinStatus(job.state)
    : (joinStates.get(key) ?? "idle");
  const render = (currentJob = job) =>
    pageText(
      "Join Manager",
      infoResponse(
        "Live Session-Bound Join Worker",
        `<b>Session:</b> ${escapeHtml(session.sessionName)}\n<b>Source:</b> Active bucket\n<b>Status:</b> ${status}\n<b>Job:</b> <code>${escapeHtml(currentJob?.jobId ?? "not started")}</code>\n<b>Progress:</b> ${currentJob?.progress.completed ?? 0}/${currentJob?.progress.total ?? "—"}\n<b>Joined:</b> ${currentJob?.progress.success ?? 0}  <b>Failed:</b> ${currentJob?.progress.failed ?? 0}\n<b>Rate:</b> ${currentJob?.progress.rate ? currentJob.progress.rate.toFixed(2) : "0.00"}/s\n\nThe view updates in place while the worker is active.`,
      ),
    );
  await edit(ctx, render(), joinManagerKeyboard(session.sessionId, status));
  const message = ctx.callbackQuery?.message;
  const chatId =
    ctx.chat?.id ??
    (message && "chat" in message ? message.chat.id : undefined);
  const messageId =
    message && "message_id" in message ? message.message_id : undefined;
  if (!chatId || !messageId || !jobId || !runtime) return;
  const loopKey = `join:${chatId}:${messageId}`;
  const previous = liveLoops.get(loopKey);
  if (previous) clearInterval(previous);
  const interval = setInterval(() => {
    void runtime
      .get(jobId)
      .then((nextJob) => {
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
  await ctx
    .editMessageText(text, { parse_mode: "HTML", reply_markup: markup })
    .catch(async () => {
      await ctx
        .reply(text, { parse_mode: "HTML", reply_markup: markup })
        .catch(() => undefined);
    });
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

function isAdmin(ctx: Context): boolean {
  return Boolean(ctx.from && ownerTelegramIds.has(String(ctx.from.id)));
}

function requireAdmin(ctx: Context): boolean {
  if (isAdmin(ctx)) return true;
  void ctx.answerCbQuery("Owner only.", { show_alert: true });
  return false;
}

function deny(ctx: Context): void {
  void ctx.answerCbQuery("This action is not available for your workspace.", {
    show_alert: true,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
