import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { env, ownerTelegramIds } from "../config/env.js";
import {
  resolveUser,
  listSessions,
  createSession,
  getSession,
  updateSession,
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
  recordAudit,
  setEmergencyState,
} from "../core/control-plane.js";
import { getValidatorSnapshot } from "../links/validator-snapshot.js";
import {
  listForceJoinTargets,
  removeForceJoinTarget,
  setForceJoinTargetEnabled,
  upsertForceJoinTarget,
  type ForceJoinTargetRecord,
} from "../persistence/mongo.js";
import { requestWhatsAppPairingCode } from "../whatsapp/session-manager.js";
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
const pendingAdminInput = new Map<string, "forcejoin:add">();
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
    const pairing = pendingPairing.get(userId);
    if (pairing && !ctx.message.text.startsWith("/")) {
      await handlePairingText(ctx, pairing, ctx.message.text.trim());
      return;
    }
    const adminInput = pendingAdminInput.get(userId);
    if (adminInput === "forcejoin:add" && !ctx.message.text.startsWith("/")) {
      await handleForceJoinAdminInput(ctx, ctx.message.text.trim());
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
    pendingPairing.set(String(ctx.from?.id ?? ""), {
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
    if (action === "groups")
      return showFeature(
        ctx,
        "Groups",
        "This session’s group inventory is isolated to the selected WhatsApp session. Use <code>.groups</code> or refresh after pairing.",
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
  bot.action(/^bucket:(view|purge|merge|downloads)/, async (ctx) => {
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

  bot.action("jobs:list", async (ctx) =>
    showFeature(
      ctx,
      "Scheduled Jobs",
      "Create timezone-aware jobs for owned sessions. Every job must carry workspace and session scope and supports bounded execution, progress, and cancellation.",
    ),
  );
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
  for (const action of [
    "admin:forcejoin",
    "admin:users",
    "admin:bridge",
    "admin:jobs",
    "admin:bucket",
    "admin:broadcast",
    "admin:audit",
    "admin:safe",
  ]) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      if (!requireAdmin(ctx)) return;
      await edit(
        ctx,
        pageText(
          "Admin Module",
          infoResponse(
            "Owner Verified",
            `<b>Action:</b> <code>${escapeHtml(action.replace("admin:", ""))}</code>\n\nOwner authorization confirmed. This control is available in the Admin Control Plane and every operation is recorded in the audit stream.`,
          ),
        ),
        keyboard([[btn(ui.back, "admin:panel")]]),
      );
    });
  }

  bot.catch((error, ctx) =>
    console.error(`[telegram] update ${ctx.updateType} failed`, error),
  );
  return bot;
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
  pendingPairing.set(String(ctx.from?.id ?? ""), {
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
  pendingPairing.set(String(ctx.from?.id ?? ""), {
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
    pendingPairing.delete(userId);
    await startPairing(ctx, text);
    return;
  }
  const sessionId = pending.sessionId;
  if (!sessionId) {
    pendingPairing.delete(userId);
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
    pendingPairing.delete(userId);
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
