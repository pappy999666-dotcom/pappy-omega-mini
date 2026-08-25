import type { InlineKeyboardMarkup } from "telegraf/types";
import type { MenuMedia, WhatsAppSession } from "../types/domain.js";
import type { JobRecord } from "../jobs/job-contracts.js";
import type { InceptorSnapshot } from "../jobs/inceptor.js";
import type { AutoPromoteConfig, AutoPromoteRun } from "../autopromote/types.js";
import { effectiveSessionStatus } from "../menus/menu-model.js";
import { infoResponse } from "./renderer.js";
import { pappyTelegramFeatureSections } from "./feature-catalog.js";
import { compactGroupCallbackData } from "./group-selection.js";
import { telegramSafeText } from "./text-safety.js";

export type ButtonStyle = "primary" | "success" | "danger";
type InlineButton = InlineKeyboardMarkup["inline_keyboard"][number][number] & {
  style?: ButtonStyle;
  copy_text?: { text: string };
};
type Button = InlineButton;

export const ui = {
  brand: "✦ PAPPY OMEGA MINI",
  divider: "<code>──────────────────────────────</code>",
  success: "✅",
  danger: "⛔",
  warning: "⚠️",
  info: "◆",
  back: "🔙 Back",
  close: "❌ Close",
};

export function btn(
  text: string,
  callback_data: string,
  style: ButtonStyle = "primary",
): Button {
  return { text, callback_data: compactGroupCallbackData(callback_data), style };
}

export function copyBtn(
  text: string,
  copy_text: string,
  style: ButtonStyle = "primary",
): Button {
  return { text, copy_text: { text: copy_text }, style } as Button;
}

export function urlBtn(
  text: string,
  url: string,
  style: ButtonStyle = "primary",
): Button {
  return { text, url, style };
}

function sanitizeButton(button: Button): Button {
  return {
    ...button,
    text: telegramSafeText(button.text, 128),
    ...(button.copy_text
      ? { copy_text: { text: telegramSafeText(button.copy_text.text, 4096) } }
      : {}),
  };
}

export function keyboard(rows: Button[][]): InlineKeyboardMarkup {
  return {
    inline_keyboard: rows.map((row) => row.map(sanitizeButton)),
  } as InlineKeyboardMarkup;
}

export function groupStartKeyboard(isModerator: boolean): InlineKeyboardMarkup {
  const rows: Button[][] = [
    [btn("📜 Group Rules", "group:start:rules")],
    [btn("🔄 Refresh", "group:start:refresh")],
  ];
  if (isModerator)
    rows.push([
      btn("🛡 Moderator Controls", "group:start:moderation", "success"),
    ]);
  return keyboard(rows);
}

export function groupStartText(
  title: string,
  isModerator: boolean,
  rules?: string,
): string {
  return pageText(
    "Pappy Omega Mini",
    infoResponse(
      "WhatsApp Bot · Group Menu",
      `<b>Group:</b> ${escapeHtml(title)}\n` +
        "WhatsApp bot group menu\n\n" +
        `<b>View:</b> ${isModerator ? "Moderator" : "Member"}\n` +
        `<b>Rules:</b> ${escapeHtml(rules ?? "Not configured.")}\n\n` +
        "Reply to a member for moderation commands.",
    ),
  );
}

export function dashboardKeyboard(isAdmin: boolean): InlineKeyboardMarkup {
  const rows: Button[][] = [
    [
      btn("⚡ Pair Number", "session:new", "success"),
      btn("▣ Sessions", "sessions:list:0"),
    ],
    [
      ...(isAdmin ? [btn("⌁ Validator Hub", "bucket:status")] : []),
      btn("⚡ Auto Promote", "autopromote:user"),
    ],
    [btn("🌉 Global Bridge", "bridge:global")],
    [
      btn("◷ Scheduled Jobs", "jobs:list"),
      btn("📺 Live Show", "jobs:live:open", "success"),
    ],
    [btn("◌ Workload", "workload:menu", "success")],
    [btn("⚙ Settings", "settings:menu")],
    [btn("◌ Support", "support:menu"), btn("▤ Help", "help:main")],
  ];
  if (isAdmin) rows.push([btn("♛ Admin Panel", "admin:panel")]);
  return keyboard(rows);
}

export function sessionsKeyboard(
  sessions: WhatsAppSession[],
  page: number,
  pageSize = 5,
  isAdmin = false,
): InlineKeyboardMarkup {
  const start = page * pageSize;
  const rows: Button[][] = sessions
    .slice(start, start + pageSize)
    .map((session) => [
      btn(
        `${statusIcon(session.status)} ${session.sessionName}`,
        `session:${session.sessionId}:menu`,
      ),
    ]);
  const nav: Button[] = [];
  if (page > 0) nav.push(btn("◀ Prev", `sessions:list:${page - 1}`));
  if (start + pageSize < sessions.length)
    nav.push(btn("Next ▶", `sessions:list:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("➕ New Session", "session:new", "success")]);
  if (isAdmin) rows.push([btn("♛ Admin Panel", "admin:panel")]);
  rows.push([btn(ui.back, "menu:main")]);
  return keyboard(rows);
}

export function globalBridgeKeyboard(
  sessionCount: number,
  _active = false,
): InlineKeyboardMarkup {
  return keyboard([
    [btn("➕ Add WhatsApp Session", "session:new", "success")],
    ...(sessionCount > 0
      ? [
          [btn("1️⃣ Choose ACTIVE Sessions", "bridge:global:select")],
          [btn("☑ Select All ACTIVE", "bridge:global:select:all", "primary")],
          [btn("✉️ Send Command", "bridge:global:command", "success")],
        ]
      : []),
    [btn(ui.back, "menu:main")],
  ]);
}
export function globalBridgeText(selected = 0, active = false): string {
  return pageText(
    "Global Command Bridge",
    infoResponse(
      "One command · selected ACTIVE sessions",
      `<b>What this does:</b> send one WhatsApp command to the ACTIVE sessions you select.\n<b>Selected:</b> ${selected} session${selected === 1 ? "" : "s"}\n<b>Status:</b> ${active ? "READY — listening for one command" : "IDLE — no command input is open"}\n\nThis is not the per-session Bridge. It is the workspace-wide command desk.`,
    ),
  );
}

export function globalBridgeResultText(
  command: string,
  results: Array<{ sessionName: string; ok: boolean; output: string }>,
  actorTelegramUserId?: string,
): string {
  const lines = results
    .map(
      (result) =>
        `${result.ok ? "✅" : "⛔"} <b>${escapeHtml(result.sessionName)}</b>\n<code>${escapeHtml(result.output.slice(0, 500))}</code>`,
    )
    .join("\n\n");
  return pageText(
    "Global Bridge Result",
    infoResponse(
      `Command completed: ${escapeHtml(command)}`,
      `${actorTelegramUserId ? `<b>Telegram user:</b> <code>${escapeHtml(actorTelegramUserId)}</code>\n\n` : ""}${lines || "No session returned a result."}`,
    ),
  );
}

export function bridgeSessionPicker(
  sessions: WhatsAppSession[],
  selected: Set<string>,
): InlineKeyboardMarkup {
  const rows: Button[][] = sessions.map((session) => [
    btn(
      `${selected.has(session.sessionId) ? "☑" : "☐"} ${session.sessionName}`,
      `bridge:global:toggle:${session.sessionId}`,
    ),
  ]);
  rows.push([
    btn("☑ Select All ACTIVE", "bridge:global:select:all", "primary"),
    btn("↻ Clear Selection", "bridge:global:clear"),
  ]);
  rows.push([btn("✉️ Send Command", "bridge:global:command", "success")]);
  rows.push([btn(ui.back, "bridge:global")]);
  return keyboard(rows);
}

export function sessionKeyboard(
  session: WhatsAppSession,
  isOwner: boolean,
): InlineKeyboardMarkup {
  const id = session.sessionId;
  const rows: Button[][] = [
    [
      btn("◉ Overview", `session:${id}:section:overview`, "success"),
      btn("🧰 WhatsApp Tools", `session:${id}:section:tools`),
    ],
    [
      btn("👥 My Groups", `session:${id}:groups`),
      btn("🌉 Session Bridge", `session:${id}:section:bridge`),
    ],
    [
      btn("⚡ Auto Promote", `session:${id}:autopromote`, "primary"),
    ],
    [btn("🛠 Join Manager", `session:${id}:section:join`)],
    [
      btn("🩺 Health & Jobs", `session:${id}:section:health`),
      btn("⚙ Session Settings", `session:${id}:section:settings`),
    ],
    [btn("↻ Reconnect WhatsApp", `session:${id}:action:reconnect`, "primary")],
  ];
  if (isOwner)
    rows.push([btn("🔐 Access / Sudo", `session:${id}:section:access`)]);
  rows.push([btn("⚠ Purge Session", `session:${id}:action:purge`, "danger")]);
  rows.push([
    btn("↻ Refresh", `session:${id}:menu`),
    btn("‹ Sessions", "sessions:list:0"),
  ]);
  return keyboard(rows);
}

export function sessionGroupKeyboard(
  sessionId: string,
  index: number,
): InlineKeyboardMarkup {
  return keyboard([
    [
      btn("✎ Edit Name", `session:${sessionId}:group:name:${index}`, "primary"),
      btn("✎ Edit Description", `session:${sessionId}:group:description:${index}`, "primary"),
    ],
    [
      btn("🖼 Set Picture", `session:${sessionId}:group:picture:${index}`),
      btn("◉ Get Picture", `session:${sessionId}:group:picture:get:${index}`),
    ],
    [btn("🛡 Moderation", `session:${sessionId}:group:moderation:${index}`, "primary")],
    [btn("✅ Approvals", `session:${sessionId}:group:moderation:approve:${index}`, "success")],
    [btn("🔗 Invite Link", `session:${sessionId}:group:invite:${index}`)],
    [btn("↪ Leave Group", `session:${sessionId}:group:leave:${index}`, "danger")],
    [btn("‹ My Groups", `session:${sessionId}:section:groups`)],
  ]);
}

export function sessionToolsKeyboard(sessionId: string): InlineKeyboardMarkup {
  return keyboard([
    [
      btn("🪪 Profile", `session:${sessionId}:action:profile`),
      btn("🖼 PFP", `session:${sessionId}:action:pfp`),
    ],
    [
      btn("✎ Name", `session:${sessionId}:action:name`),
      btn("✎ Bio", `session:${sessionId}:action:bio`),
    ],
    [
      btn(
        "＋ Create Group",
        `session:${sessionId}:action:creategroup`,
        "success",
      ),
      btn("▣ Group Picture", `session:${sessionId}:action:gpp`),
    ],
    [btn("‹ Session Control", `session:${sessionId}:menu`)],
  ]);
}

export function sessionSettingsKeyboard(
  sessionId: string,
  autoJoinEnabled: boolean,
): InlineKeyboardMarkup {
  return keyboard([
    [
      btn(
        `Auto-join: ${autoJoinEnabled ? "ON" : "OFF"}`,
        `session:${sessionId}:action:autojoin`,
        autoJoinEnabled ? "success" : "danger",
      ),
      btn("Prefix", `session:${sessionId}:action:prefix`),
    ],
    [btn("‹ Session Control", `session:${sessionId}:menu`)],
  ]);
}

export function sessionAccessKeyboard(sessionId: string): InlineKeyboardMarkup {
  return keyboard([
    [btn("◉ List Sudo", `session:${sessionId}:sudo:list`)],
    [
      btn("＋ Add Sudo", `session:${sessionId}:sudo:add`, "success"),
      btn("− Remove Sudo", `session:${sessionId}:sudo:remove`, "danger"),
    ],
    [btn("‹ Session Control", `session:${sessionId}:menu`)],
  ]);
}

export function sessionValidatorKeyboard(
  sessionId: string,
): InlineKeyboardMarkup {
  return keyboard([[btn("‹ Session Control", `session:${sessionId}:menu`)]]);
}

export function linkCollectionKeyboard(
  sessionId: string,
): InlineKeyboardMarkup {
  return keyboard([
    [btn("↻ Refresh Shared Statistics", `session:${sessionId}:collect`, "success")],
    [btn("📥 Download Active Links", "bucket:user:active", "success")],
    [btn(ui.back, `session:${sessionId}:menu`)],
  ]);
}

export function validatorDashboardText(snapshot: {
  counts: Record<string, number>;
  recent: Array<{ canonicalUrl: string; bucket: string; metadata?: { title?: string; validationState?: string; memberCount?: number } }>;
  capturedAt: number;
}): string {
  const recent =
    snapshot.recent
      .slice(0, 6)
      .map(
        (record) =>
          `• <code>${escapeHtml(record.metadata?.title ?? record.canonicalUrl.slice(0, 72))}</code> <i>${escapeHtml(record.metadata?.validationState ?? record.bucket)}</i>`,
      )
      .join("\n") || "No link records yet.";
  return pageText(
    "Validator Hub",
    infoResponse(
      "Live Workspace Buckets",
      `<b>Main:</b> ${snapshot.counts.main ?? 0}  <b>Validating:</b> ${snapshot.counts.validating ?? 0}\n<b>Active:</b> ${snapshot.counts.active ?? 0}  <b>Dead:</b> ${snapshot.counts.dead ?? 0}\n<b>Retryable:</b> ${snapshot.counts.error ?? 0}\n\n<b>Recent records</b>\n${recent}\n\n<i>Updated ${new Date(snapshot.capturedAt).toISOString()}</i>`,
    ),
  );
}

export function validatorLiveText(
  snapshot: {
    counts: Record<string, number>;
    recent: Array<{ canonicalUrl: string; bucket: string; sourceSessionId?: string; metadata?: { title?: string; validationState?: string; memberCount?: number } }>;
    capturedAt: number;
  },
  active = false,
  jobs: Array<{
    state: string;
    jobCode?: string;
    jobId: string;
    sessionId?: string;
    progress: {
      completed: number;
      total?: number;
      success: number;
      failed: number;
      currentLink?: string;
      currentAction?: string;
      lastResult?: string;
    };
  }> = [],
  sessions: Array<{ sessionId: string; sessionName: string; status: string; authHealth?: string; validatorRetiredUntil?: number; validatorRetireReason?: string; validatorFailureCount?: number }> = [],
  summary?: {
    totalSessions: number;
    eligibleSessions: number;
    leasedSessions: number;
    retiredSessions: number;
  },
): string {
  const matrix = snapshot.recent
    .slice(0, 10)
    .map((record) => {
      const state = record.metadata?.validationState ?? record.bucket;
      const icon = state === "active" ? "●" : state === "validating" ? "◌" : state === "dead" ? "×" : state === "retryable-error" ? "↻" : "·";
      const title = record.metadata?.title ?? record.canonicalUrl.slice(0, 64);
      const size = record.metadata?.memberCount !== undefined ? ` · ${record.metadata.memberCount} members` : "";
      return `${icon} <code>${escapeHtml(title)}</code> <i>${escapeHtml(state)}${size}</i>`;
    })
    .join("\n") || "Waiting for link activity.";
  const work = jobs.filter((job) => ["RUNNING", "RETRYING"].includes(job.state)).slice(0, 6);
  const leases = snapshot.recent.filter((record) => record.bucket === "validating").slice(0, 6);
  const activeFeed = work.length
    ? work.map((job) => `◌ <code>${escapeHtml(job.jobCode ?? job.jobId.slice(0, 8))}</code> · ${escapeHtml(job.sessionId?.slice(0, 8) ?? "socket—")} · ${escapeHtml(job.progress.currentAction ?? "validating")} · <code>${escapeHtml(job.progress.currentLink ?? job.progress.lastResult ?? "waiting")}</code>`).join("\n")
    : leases.length
      ? leases.map((record) => `◌ <code>${escapeHtml(record.sourceSessionId?.slice(0, 8) ?? "broker—")}</code> · leased · <code>${escapeHtml(record.canonicalUrl)}</code>`).join("\n")
      : (snapshot.counts.main ?? 0) > 0
        ? "Main links are waiting for the next automatic admission sweep or a healthy validation socket."
        : "No Main links are waiting; collection is active and the Validator is idle.";
  const sessionLine = (session: {
    sessionId: string;
    sessionName: string;
    status: string;
    authHealth?: string;
    validatorRetiredUntil?: number;
    validatorRetireReason?: string;
    validatorFailureCount?: number;
  }): string => {
    const remaining = session.validatorRetiredUntil && session.validatorRetiredUntil > Date.now()
      ? ` · retired ${Math.ceil((session.validatorRetiredUntil - Date.now()) / 60_000)}m · ${session.validatorRetireReason ?? "cooldown"}`
      : "";
    const failures = session.validatorFailureCount ? ` · failures ${session.validatorFailureCount}` : "";
    return `${session.status === "ACTIVE" ? "●" : "○"} <b>${escapeHtml(session.sessionName)}</b> · ${escapeHtml(session.status)}${session.authHealth ? ` · ${escapeHtml(session.authHealth)}` : ""}${remaining}${failures} · <code>${escapeHtml(session.sessionId.slice(0, 8))}</code>`;
  };
  const sessionFeed = summary
    ? `<b>Total sessions:</b> ${summary.totalSessions} · <b>Eligible:</b> ${summary.eligibleSessions} · <b>Leased:</b> ${summary.leasedSessions} · <b>Retired:</b> ${summary.retiredSessions}${sessions.length ? `\n\n<b>Lease sample</b>\n${sessions.slice(0, 12).map(sessionLine).join("\n")}` : ""}`
    : sessions.length
      ? sessions.map(sessionLine).join("\n")
      : "No session is currently available for validation.";
  return pageText(
    "Validator Hub · Live",
    infoResponse(
      active ? "Live feed is ON" : "Live feed is PAUSED",
      `<b>Live validation workers · state matrix</b> · refreshed in place\n<b>Main:</b> ${snapshot.counts.main ?? 0}  <b>Validating:</b> ${snapshot.counts.validating ?? 0}\n<b>Active:</b> ${snapshot.counts.active ?? 0}  <b>Dead:</b> ${snapshot.counts.dead ?? 0}\n<b>Retryable:</b> ${snapshot.counts.error ?? 0}\n\n<b>Validator intake</b> · automatic collection ON · up to five-link batch per eligible session · one request at a time per socket · admission every 5s\n\n<b>Validation sockets</b>\n${sessionFeed}\n\n<b>Current validation</b>\n${activeFeed}\n\n<b>Group matrix</b>\n${matrix}\n\n<i>Links leave Main into Validating while the distributor checks them. Only confirmed invite metadata enters Active. Dead means revoked, expired, invalid, or missing groups. Automatic transient or rate-limited failures enter Retryable/Error; use explicit requeue to return them to Main. Active links never return to Main automatically.</i>\n<i>Snapshot ${new Date(snapshot.capturedAt).toISOString()}</i>`,
    ),
  );
}

export function validatorLiveKeyboard(active = false): InlineKeyboardMarkup {
  return keyboard([
    [
      btn(
        active ? "⏹ Stop Live Refresh" : "▶ Resume Live Refresh",
        active ? "bucket:live:off" : "bucket:live:on",
        active ? "danger" : "success",
      ),
    ],
    [btn("↻ Refresh Live Log", "bucket:live:refresh")],
    [btn("‹ Validator Hub", "bucket:status")],
    [btn(ui.back, "menu:main")],
  ]);
}

export function bucketKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [
      btn("▶ Open Live Log", "bucket:live", "success"),
      btn("↻ Refresh Dashboard", "bucket:status", "primary"),
    ],
    [
      btn("📥 Main", "bucket:view:main"),
      btn("◌ Validating", "bucket:view:validating"),
      btn("✅ Active", "bucket:view:active"),
    ],
    [btn("💀 Dead", "bucket:view:dead"), btn("↻ Retryable", "bucket:view:error")],
    [btn("↻ Requeue Retryable Errors", "bucket:merge:main", "success")],
    [btn("⬇️ Downloads", "bucket:downloads")],
    [
      btn("🗑 Purge Dead", "bucket:purge:dead", "danger"),
      btn("🗑 Purge Retryable", "bucket:purge:error", "danger"),
    ],
    [btn(ui.back, "menu:main")],
  ]);
}

export function joinManagerKeyboard(
  sessionId: string,
  status: string,
): InlineKeyboardMarkup {
  const controls: Button[] = [];
  if (status === "running")
    controls.push(btn("⏸ Pause", `session:${sessionId}:join:pause`, "danger"));
  else
    controls.push(
      btn(
        status === "paused" ? "▶ Resume" : "▶ Start",
        `session:${sessionId}:join:start`,
        "success",
      ),
    );
  if (status === "running" || status === "paused")
    controls.push(btn("⏹ Stop", `session:${sessionId}:join:stop`, "danger"));
  const rows: Button[][] = [controls];
  if (status !== "running")
    rows.push([
      btn("🎯 Edit Target", `session:${sessionId}:join:edit:target`),
      btn("⏱ Edit Delay", `session:${sessionId}:join:edit:delay`),
    ]);
  if (status !== "running")
    rows.push([btn("🔁 Edit Batch Cycles", `session:${sessionId}:join:edit:batch`)]);
  rows.push([
    btn("⚙ Full Join Settings", `session:${sessionId}:join:settings`),
    btn("🔄 Refresh Live View", `session:${sessionId}:joinmgr`),
  ]);
  rows.push([
    btn(
      status === "running" ? "🔙 Back (keeps running)" : ui.back,
      `session:${sessionId}:menu`,
    ),
  ]);
  return keyboard(rows);
}

export function workspaceSettingsKeyboard(settings: {
  defaultAutoJoinEnabled: boolean;
  defaultPrefix: string;
  defaultBroadcastDelayMs: number;
}): InlineKeyboardMarkup {
  return keyboard([
    [
      btn(
        `Auto-join: ${settings.defaultAutoJoinEnabled ? "ON" : "OFF"}`,
        "settings:autojoin:toggle",
        settings.defaultAutoJoinEnabled ? "success" : "danger",
      ),
    ],
    [
      btn(
        `Prefix: ${settings.defaultPrefix || "none"}`,
        "settings:prefix:cycle",
      ),
    ],
    [
      btn(
        `Broadcast delay: ${Math.round(settings.defaultBroadcastDelayMs / 1000)}s`,
        "settings:broadcastdelay:cycle",
      ),
      btn("Set exact", "settings:broadcastdelay:set", "primary"),
    ],
    [btn("Open per-session Join Manager settings", "sessions:list:0")],
    [btn("↻ Refresh", "settings:menu")],
    [btn(ui.back, "menu:main")],
  ]);
}

export interface ForceJoinTargetView {
  targetId: string;
  targetType: "channel" | "group";
  usernameOrLink: string;
  displayName: string;
  buttonText: string;
  enabled: boolean;
  required: boolean;
  sortOrder: number;
}

export function forceJoinText(
  targets: ForceJoinTargetView[],
  passed: string[] = [],
): string {
  const lines = targets.length
    ? targets
        .map((target) => {
          const state = passed.includes(target.targetId)
            ? "✅ Joined"
            : "⏳ Required";
          return `${state} · <b>${escapeHtml(target.displayName)}</b>\n<code>${escapeHtml(target.usernameOrLink)}</code>`;
        })
        .join("\n\n")
    : "No force-join targets are configured.";
  return pageText(
    "Access Check",
    infoResponse(
      "Join Required Channels or Groups",
      `${lines}\n\nJoin every required target, then press <b>Check Membership</b>. Targets that Telegram cannot verify automatically will be clearly identified.`,
    ),
  );
}

function forceJoinUrl(value: string): string {
  const target = value.trim();
  if (/^https?:\/\//i.test(target)) return target;
  if (/^t\.me\//i.test(target)) return `https://${target}`;
  if (target.startsWith("@")) return `https://t.me/${target.slice(1)}`;
  if (/^[A-Za-z0-9_]{3,}$/.test(target)) return `https://t.me/${target}`;
  if (/^-?\d+$/.test(target))
    return `tg://resolve?domain=${encodeURIComponent(target)}`;
  return `https://t.me/${target.replace(/^\/+/, "")}`;
}

export function forceJoinKeyboard(
  targets: ForceJoinTargetView[],
): InlineKeyboardMarkup {
  const rows: Button[][] = targets.map((target) => [
    urlBtn(`↗ ${target.buttonText}`, forceJoinUrl(target.usernameOrLink), "primary"),
  ]);
  rows.push([btn("✓ Check Membership", "forcejoin:check", "success")]);
  return keyboard(rows);
}

export function adminForceJoinText(targets: ForceJoinTargetView[]): string {
  const body = targets.length
    ? targets
        .map(
          (target) =>
            `${target.enabled ? "🟢" : "⛔"} <b>${escapeHtml(target.displayName)}</b> · ${escapeHtml(target.targetType)}\n<code>${escapeHtml(target.usernameOrLink)}</code> · ${target.required ? "required" : "optional"}`,
        )
        .join("\n\n")
    : "No targets configured. Add a public channel or group username/link.";
  return pageText(
    "Admin · Force Join",
    infoResponse(
      "Persistent Membership Policy",
      `${body}\n\nTelegram membership can be verified automatically for public usernames or chat IDs. Invite links remain visible but may require manual confirmation when Telegram does not expose membership lookup.`,
    ),
  );
}

export function adminForceJoinKeyboard(
  targets: ForceJoinTargetView[],
): InlineKeyboardMarkup {
  const rows: Button[][] = targets.map((target) => [
    btn(
      `${target.enabled ? "⛔ Disable" : "✅ Enable"} · ${target.displayName}`,
      `admin:forcejoin:toggle:${target.targetId}`,
      target.enabled ? "danger" : "success",
    ),
    btn("✕ Remove", `admin:forcejoin:remove:${target.targetId}`, "danger"),
  ]);
  rows.push([btn("＋ Add Target", "admin:forcejoin:add", "success")]);
  rows.push([btn("↻ Refresh", "admin:forcejoin", "primary")]);
  rows.push([btn(ui.back, "admin:panel")]);
  return keyboard(rows);
}

export interface AdminUserView {
  telegramUserId: string;
  username?: string;
  displayName?: string;
  status: "active" | "banned";
  workspaceId: string;
  lastSeenAt: number;
  sessionCount: number;
}

export function adminUsersText(users: AdminUserView[], page: number): string {
  const body = users.length
    ? users
        .map(
          (user) =>
            `${user.status === "active" ? "🟢" : "⛔"} <b>${escapeHtml(user.displayName || user.username || user.telegramUserId)}</b>\n<code>${escapeHtml(user.telegramUserId)}</code> · ${user.sessionCount} sessions · last seen ${new Date(user.lastSeenAt).toISOString()}`,
        )
        .join("\n\n")
    : "No users have been persisted yet.";
  return pageText(
    "Admin · Users",
    infoResponse(
      "Tenant Directory",
      `${body}\n\n<b>Page:</b> ${page + 1}\n\nBan/unban changes the durable user policy and is recorded in the audit stream.`,
    ),
  );
}

export function adminUsersKeyboard(
  users: AdminUserView[],
  page: number,
): InlineKeyboardMarkup {
  const rows: Button[][] = users.map((user) => [
    btn(
      `${user.status === "active" ? "⛔ Ban" : "✅ Unban"} · ${user.telegramUserId}`,
      `admin:user:${user.status === "active" ? "ban" : "unban"}:${user.telegramUserId}`,
      user.status === "active" ? "danger" : "success",
    ),
  ]);
  rows.push([
    ...(page > 0
      ? [btn("‹ Previous", `admin:users:${page - 1}`, "primary")]
      : []),
    btn("Next ›", `admin:users:${page + 1}`, "primary"),
  ]);
  rows.push([btn("↻ Refresh", `admin:users:${page}`, "primary")]);
  rows.push([btn(ui.back, "admin:panel")]);
  return keyboard(rows);
}

export function adminBucketText(snapshot: {
  counts: Record<string, number>;
  recent: Array<{
    canonicalUrl: string;
    bucket: string;
    validationError?: string;
  }>;
  capturedAt: number;
}): string {
  const counts = Object.entries(snapshot.counts)
    .map(([bucket, count]) => `<b>${escapeHtml(bucket)}:</b> ${count}`)
    .join("  ");
  const recent = snapshot.recent.length
    ? snapshot.recent
        .map(
          (record) =>
            `${record.bucket === "active" ? "✅" : record.bucket === "dead" ? "⛔" : "•"} <code>${escapeHtml(record.canonicalUrl.slice(0, 80))}</code>${record.validationError ? `\n<i>${escapeHtml(record.validationError.slice(0, 120))}</i>` : ""}`,
        )
        .join("\n\n")
    : "No shared validator records are available.";
  return pageText(
    "Admin · Validator Hub",
    infoResponse(
      "Shared Admin Validator Snapshot",
      `${counts}\n\n<b>Recent records</b>\n${recent}\n\n<i>Captured ${new Date(snapshot.capturedAt).toISOString()}</i>`,
    ),
  );
}

export function adminBucketKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("↻ Refresh Bucket", "admin:bucket", "primary")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function adminBridgeText(sessions: WhatsAppSession[]): string {
  const body = sessions.length
    ? sessions
        .map(
          (session) =>
            `${statusIcon(session.status)} <b>${escapeHtml(session.sessionName)}</b>\n<code>${escapeHtml(session.sessionId.slice(0, 12))}</code> · workspace <code>${escapeHtml(session.workspaceId.slice(0, 12))}</code>\n${escapeHtml(session.phoneNumber ?? "phone pending")}`,
        )
        .join("\n\n")
    : "No ACTIVE WhatsApp sessions are available for Bridge. Pair or recover a session first.";
  return pageText(
    "Admin · Global Bridge",
    infoResponse(
      "Active Session Command Bridge",
      `${body}\n\nSelect the ACTIVE sessions that should receive one command, then press Send Command. Pairing, reconnecting, logged-out, and failed sessions are intentionally hidden.`,
    ),
  );
}

export function adminBridgeTargetToken(
  workspaceId: string,
  sessionId: string,
): string {
  let hash = 2166136261;
  for (const char of `${workspaceId}:${sessionId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

export function adminBridgeKeyboard(
  sessions: WhatsAppSession[],
  selected: Set<string> = new Set(),
): InlineKeyboardMarkup {
  const rows: Button[][] = sessions.map((session) => {
    const token = adminBridgeTargetToken(session.workspaceId, session.sessionId);
    return [
      btn(
        `${selected.has(token) ? "☑" : "☐"} ${session.sessionName}`,
        `admin:bridge:toggle:${token}`,
        selected.has(token) ? "success" : "primary",
      ),
    ];
  });
  if (!sessions.length)
    rows.push([btn("＋ Pair Session", "session:new", "success")]);
  if (sessions.length) {
    rows.push([btn("☑ Select All ACTIVE", "admin:bridge:all", "primary")]);
    rows.push([btn("✉ Send Command", "admin:bridge:command", "success")]);
  }
  rows.push([btn("↻ Refresh", "admin:bridge", "primary")]);
  rows.push([btn(ui.back, "admin:panel")]);
  return keyboard(rows);
}

export interface AdminAuditView {
  action: string;
  actorTelegramUserId: string;
  success: boolean;
  timestamp: number;
  correlationId: string;
  metadata?: Record<string, string | number | boolean>;
}

export function adminAuditText(events: AdminAuditView[]): string {
  const body = events.length
    ? events
        .map(
          (event) =>
            `${event.success ? "✅" : "⛔"} <b>${escapeHtml(event.action)}</b>\n<code>${escapeHtml(event.correlationId.slice(0, 12))}</code> · actor ${escapeHtml(event.actorTelegramUserId)} · ${new Date(event.timestamp).toISOString()}`,
        )
        .join("\n\n")
    : "No audit events are recorded for this workspace.";
  return pageText(
    "Admin · Audit",
    infoResponse(
      "Recent Control-Plane Events",
      `${body}\n\n<i>Secrets and private message content are intentionally redacted.</i>`,
    ),
  );
}

export function adminAuditKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("↻ Refresh Audit", "admin:audit", "primary")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function adminInceptorText(snapshot?: InceptorSnapshot): string {
  if (!snapshot)
    return pageText("Admin · Inceptor", infoResponse("Maintenance Engine", "Inceptor is starting; no sweep has completed yet."));
  const actions = snapshot.lastActions.length
    ? snapshot.lastActions.map((action) => `• ${escapeHtml(action)}`).join("\n")
    : "No corrective actions in the latest sweep.";
  return pageText(
    "Admin · Inceptor",
    infoResponse(
      "Bounded Maintenance Engine",
      `<b>Status:</b> ${snapshot.running ? "🟢 RUNNING" : "⚪ STOPPED"}\n` +
        `<b>Scanned:</b> ${snapshot.scanned}\n` +
        `<b>Recovered:</b> ${snapshot.recovered}\n` +
        `<b>Failed after retry limit:</b> ${snapshot.failed}\n` +
        `<b>Flushed terminal-session jobs:</b> ${snapshot.flushedDeadSessionJobs}\n` +
        `<b>Flushed missing-session jobs:</b> ${snapshot.flushedMissingSessionJobs}\n` +
        `<b>Flushed stuck broadcast jobs:</b> ${snapshot.flushedStuckJobs}\n` +
        `<b>Pruned old terminal jobs:</b> ${snapshot.prunedTerminalJobs}\n` +
        `<b>Transient sessions skipped:</b> ${snapshot.skippedTransientSessions}\n` +
        `<b>Last sweep:</b> ${snapshot.lastSweepAt ? new Date(snapshot.lastSweepAt).toISOString() : "not yet"}\n\n` +
        `<b>Latest actions</b>\n${actions}` +
        (snapshot.lastError ? `\n\n<b>Last error:</b> ${escapeHtml(snapshot.lastError)}` : ""),
    ),
  );
}

export function adminInceptorKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("↻ Run Inceptor Sweep", "admin:inceptor:run", "primary")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function adminKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("⚙ Force Join", "admin:forcejoin"), btn("⚡ Global Auto Promote", "admin:autopromote")],
    [btn("◉ Users", "admin:users")],
    [
      btn("▣ Media", "admin:media"),
      btn("🌉 Global Bridge Ops", "admin:bridge"),
    ],
    [btn("◌ Workload", "admin:workload", "success")],
    [
      btn("◷ Global Jobs", "admin:jobs"),
      btn("⌁ Validator Hub", "bucket:status"),
    ],
    [btn("🛡 Inceptor", "admin:inceptor")],
    [btn("🗑 Clear All Jobs", "admin:jobs:clear", "danger")],
    [
      btn("▥ Broadcast", "admin:broadcast"),
      btn("◌ Support Inbox", "admin:support"),
    ],
    [btn("▤ Audit Log", "admin:audit")],
    [btn("⚠ Emergency Mode", "admin:safe", "danger")],
    [btn(ui.back, "menu:main")],
  ]);
}

export interface AdminJobView {
  jobId: string;
  kind: string;
  workspaceId: string;
  state: string;
  progress: {
    completed: number;
    total?: number;
    success: number;
    failed: number;
    skipped: number;
    retrying: number;
    rate: number;
  };
  createdAt: number;
  error?: string;
}

export function adminJobsText(jobs: AdminJobView[]): string {
  const counts = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.state] = (acc[job.state] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([state, count]) => `<b>${escapeHtml(state)}:</b> ${count}`)
    .join("  ");
  const rows = jobs
    .slice(0, 12)
    .map((job) => {
      const total = job.progress.total ?? "?";
      return `${jobStatusIcon(job.state)} <code>${escapeHtml(job.kind)}</code> · <b>${escapeHtml(job.state)}</b>\n<code>${escapeHtml(job.jobId.slice(0, 8))}</code> · ${job.progress.completed}/${total} done · ${job.progress.success} ok · ${job.progress.failed} failed`;
    })
    .join("\n\n");
  return pageText(
    "Admin Jobs Control",
    infoResponse(
      "Owner Queue Overview",
      `<b>Recent jobs:</b> ${jobs.length}\n${summary || "<b>No jobs recorded.</b>"}\n\n${rows || "No queued, running, or completed jobs are available yet."}\n\n<i>Updated ${new Date().toISOString()}</i>`,
    ),
  );
}

function liveProgressBar(completed: number, total?: number): string {
  if (!total || total <= 0) return "[░░░░░░░░░░]";
  const filled = Math.max(0, Math.min(10, Math.round((completed / total) * 10)));
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

function formatLiveClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function jobLiveClockText(job: JobRecord, now = Date.now()): string {
  const terminal = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"].includes(job.state);
  const end = terminal ? (job.completedAt ?? now) : now;
  const started = job.startedAt ?? job.createdAt;
  const updated = new Date(now).toISOString().slice(11, 19);
  return `<b>Live clock</b> ${formatLiveClock(end - started)} · <b>Updated</b> ${updated} UTC`;
}

export function jobLiveText(job: JobRecord | undefined): string {
  if (!job)
    return pageText(
      "Live Show",
      infoResponse(
        "Job Not Found",
        "The code is invalid, expired, or belongs to another workspace.",
      ),
    );
  const progress = job.progress;
  const title = `${job.kind.replace(/-/g, " ").toUpperCase()} · ${job.jobCode ?? job.jobId.slice(0, 8)}`;
  const terminal = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"].includes(job.state);
  const indicator = terminal ? "■" : job.state === "RUNNING" ? "●" : "◌";
  const remaining = progress.total === undefined
    ? "—"
    : Math.max(0, progress.total - progress.completed);
  const countdownMs = progress.nextActionAt === undefined
    ? undefined
    : Math.max(0, progress.nextActionAt - Date.now());
  const countdown = terminal || countdownMs === undefined
    ? "—"
    : `${Math.ceil(countdownMs / 1000)}s`;
  const cadence = typeof job.payload.delayMs === "number"
    ? `${Math.max(1, Math.round(job.payload.delayMs / 1000))}s${job.kind === "allstatus" || job.kind === "allchat" ? "/group" : ""}`
    : "—";
  const nextLabel = job.kind === "join-manager"
    ? "Next attempt"
    : job.kind === "group-control"
      ? "Next action"
      : "Next post";
  const worker = job.workerId ?? "waiting for worker";
  const lease = job.leaseExpiresAt
    ? new Date(job.leaseExpiresAt).toISOString()
    : "—";
  return pageText(
    "Live Show",
    infoResponse(
      title,
      `<blockquote><b>Signal</b> ${indicator} ${escapeHtml(job.state)}
<b>Code</b> <code>${escapeHtml(job.jobCode ?? "—")}</code>
<b>Flow</b> ${liveProgressBar(progress.completed, progress.total)} ${progress.completed}/${progress.total ?? "—"} · ${remaining} remaining
${jobLiveClockText(job)}
<b>${nextLabel}</b> ${countdown}  <b>Cadence</b> ${cadence}
<b>Worker</b> <code>${escapeHtml(worker)}</code>  <b>Lease until</b> <code>${escapeHtml(lease)}</code>
<b>Success</b> ${progress.success}  <b>Failed</b> ${progress.failed}  <b>Skipped</b> ${progress.skipped}
<b>Joined</b> ${progress.joined ?? progress.success}  <b>Already member</b> ${progress.alreadyMember ?? 0}
<b>Requested</b> ${progress.requested ?? 0}  <b>Dead links</b> ${progress.deadLinks ?? 0}  <b>Rate-limit</b> ${progress.rateLimitHits ?? 0}
<b>Action</b> ${escapeHtml(progress.currentAction ?? "waiting")}
<b>Target</b> ${escapeHtml(progress.currentGroup ?? progress.currentLink ?? "—")}
<b>Last result</b> ${escapeHtml(progress.lastResult ?? job.error ?? "—")}</blockquote>

<i>Live state is edited in place from the durable worker record.</i>`,
    ),
  );
}

export function jobLiveKeyboard(
  job: JobRecord | undefined,
): InlineKeyboardMarkup {
  const code = job?.jobCode ?? "";
  return keyboard([
    ...(code ? [[copyBtn("📋 Copy live code", code, "success")]] : []),
    ...(code ? [[btn("↻ Refresh Live Show", `job:live:${code}`)]] : []),
    [btn(ui.back, "jobs:list")],
  ]);
}

export function adminJobsKeyboard(
  jobs: Array<{
    jobId: string;
    kind: string;
    state: string;
    progress: {
      completed: number;
      total?: number;
      success: number;
      failed: number;
      skipped: number;
      retrying: number;
      rate: number;
    };
  }>,
): InlineKeyboardMarkup {
  const rows: Button[][] = jobs
    .filter((job) =>
      ["QUEUED", "RUNNING", "PAUSED", "RETRYING"].includes(job.state),
    )
    .slice(0, 8)
    .map((job) => [
      btn(
        `⏹ Cancel ${job.kind} · ${job.jobId.slice(0, 6)}`,
        `admin:jobs:cancel:${job.jobId}`,
        "danger",
      ),
    ]);
  rows.push([btn("🗑 Clear All Jobs", "admin:jobs:clear", "danger")]);
  rows.push([btn("↻ Refresh Jobs", "admin:jobs:refresh", "primary")]);
  rows.push([btn(ui.back, "admin:panel")]);
  return keyboard(rows);
}

export function mediaKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [
      btn("＋ Add Image", "admin:media:add:image", "success"),
      btn("＋ Add Video", "admin:media:add:video", "success"),
    ],
    [btn("▣ Choose Menu Media", "admin:media:select")],
    [btn("✎ Set Menu Caption", "admin:media:caption")],
    [btn("▢ Clear Menu Media", "admin:media:clear", "danger")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function menuMediaPickerKeyboard(
  items: MenuMedia[],
  selectedMediaId?: string,
): InlineKeyboardMarkup {
  const rows: Button[][] = items.map((item) => [
    btn(
      `${item.mediaId === selectedMediaId ? "✅" : "▣"} ${item.kind.toUpperCase()} · ${item.fileName}`,
      `admin:media:pick:${item.mediaId}`,
      item.mediaId === selectedMediaId ? "success" : "primary",
    ),
  ]);
  rows.push([btn("▢ Clear Selection", "admin:media:clear", "danger")]);
  rows.push([btn("✎ Set Shared Caption", "admin:media:caption")]);
  rows.push([btn(ui.back, "admin:media")]);
  return keyboard(rows);
}

export interface SessionAutoPromoteStatus {
  sessionState: string;
  userState: string;
  globalState: string;
  nextExecution?: number;
  cooldownUntil?: number;
}

export function sessionText(
  session: WhatsAppSession,
  autoPromote?: SessionAutoPromoteStatus,
): string {
  const status = effectiveSessionStatus(session);
  const autoPromoteText = autoPromote
    ? `\n\n<b>Auto Promote</b>\n<b>Session:</b> ${escapeHtml(autoPromote.sessionState)}\n<b>User:</b> ${escapeHtml(autoPromote.userState)}\n<b>Global:</b> ${escapeHtml(autoPromote.globalState)}\n<b>Next:</b> ${autoPromote.nextExecution ? escapeHtml(new Date(autoPromote.nextExecution).toISOString()) : "—"}\n<b>Cooldown:</b> ${autoPromote.cooldownUntil ? escapeHtml(new Date(autoPromote.cooldownUntil).toISOString()) : "None"}`
    : "";
  return `${sessionStatusCardText(session)}${autoPromoteText}\n\nChoose a control area below. Each area edits this message and keeps its own Back path.`;
}

export function workspaceSettingsText(settings: {
  defaultAutoJoinEnabled: boolean;
  defaultPrefix: string;
  defaultBroadcastDelayMs: number;
}): string {
  return pageText(
    "Workspace Settings",
    infoResponse(
      "Workspace-wide defaults",
      `<b>Auto-join default:</b> ${settings.defaultAutoJoinEnabled ? "ON" : "OFF"}\n<b>Prefix default:</b> <code>${escapeHtml(settings.defaultPrefix || "none")}</code>\n<b>Allchat/allstatus delay:</b> ${Math.round(settings.defaultBroadcastDelayMs / 1000)}s\n\nBroadcast delay is workspace-wide and bounded from 1 to 60 seconds. Join Manager delay, concurrency, retry, cooldown, target, and mode are configured inside each WhatsApp session and never change another session.`,
    ),
  );
}

export function dashboardText(isAdmin: boolean): string {
  return pageText(
    "Command Center",
    `${isAdmin ? "<b>Owner control plane</b>" : "<b>Personal workspace</b>"}\n\nChoose a workspace-wide action or open one of your isolated WhatsApp sessions.\n\n${ui.info} <b>Scope:</b> workspace-safe\n${ui.info} <b>Bridge:</b> global or per-session\n${ui.info} <b>Queues:</b> bounded and recoverable`,
  );
}

export function helpKeyboard(): InlineKeyboardMarkup {
  const rows = pappyTelegramFeatureSections.map((section) => [
    btn(`${section.label}`, `help:section:${section.id}`, "primary"),
  ]);
  rows.push([btn(ui.back, "menu:main")]);
  return keyboard(rows);
}

export function helpSectionText(sectionId: string): string {
  const section = pappyTelegramFeatureSections.find((item) => item.id === sectionId);
  if (!section) return helpText();
  const entries = section.entries
    .map((entry) => `${entry.command ? `<code>${escapeHtml(entry.command)}</code> · ` : ""}<b>${escapeHtml(entry.name)}</b> — ${escapeHtml(entry.description)}`)
    .join("\n");
  return pageText(
    `Help · ${section.label}`,
    `<b>${escapeHtml(section.description)}</b>\n\n${entries}`,
  );
}

export function helpSectionKeyboard(sectionId: string): InlineKeyboardMarkup {
  return keyboard([
    [btn("‹ All Features", "help:main")],
    [btn(ui.back, "menu:main")],
  ]);
}

export function helpText(): string {
  const summary = pappyTelegramFeatureSections
    .map((section) => `<b>${escapeHtml(section.label)}</b> · ${section.entries.length} mapped controls`)
    .join("\n");
  return pageText(
    "Help & Features",
    `A complete PAPPY-native map of the commands and control surfaces currently implemented in this bot. Select a section for the exact command, purpose, and safe scope.\n\n${summary}\n\n${ui.info} <b>Bridge:</b> kept separate as an existing transport surface and intentionally not duplicated here.\n${ui.info} <b>Security:</b> owner/admin callbacks are checked again on every action.`,
  );
}

export function pageText(title: string, body: string): string {
  return `<b>${ui.brand}</b>\n${ui.divider}\n\n<b>${escapeHtml(title)}</b>\n\n<blockquote>${body}</blockquote>`;
}

export function featureText(title: string, body: string): string {
  return pageText(title, body);
}

export function telegramCommandUsageCardText(input: {
  title: string;
  command: string;
  syntax: string;
  acceptedTargets?: string[];
  examples?: string[];
  note: string;
}): string {
  return [
    `⌬ ⤷ <b>${escapeHtml(input.title.toUpperCase())} USAGE</b> ⚙︎`,
    "",
    "─────────────",
    `<b>⎔ Command</b> · ⇆ <code>${escapeHtml(input.syntax)}</code>`,
    "─────────────",
    ...(input.acceptedTargets?.length ? ["<b>» Accepted Targets:</b>", ...input.acceptedTargets.map((line) => `◈ ${escapeHtml(line)}`), ""] : []),
    ...(input.examples?.length ? ["<b>» Examples:</b>", ...input.examples.map((line) => `» <code>${escapeHtml(line)}</code>`), ""] : []),
    `» <b>Note:</b> ${escapeHtml(input.note)}`,
  ].join("\n");
}

export function antiConfigCardText(input: {
  name: string;
  enabled: boolean;
  action?: string;
  access?: string;
  note: string;
  usage?: string[];
}): string {
  const mode = input.enabled ? `Enabled [ ${input.action ?? "delete"} ]` : "Disabled [ off ]";
  const usage = input.usage?.length
    ? `\n\n<b>» How to use:</b>\n${input.usage.map((line) => `· <code>${escapeHtml(line)}</code>`).join("\n")}`
    : "";
  return [
    `⌬ ⤷ <b>${escapeHtml(input.name.toUpperCase())} CONFIG</b> ⚙︎`,
    "",
    "─────────────",
    `<b>⎔ Mode</b>        · ⇆ ${escapeHtml(mode)}`,
    "<b>⎔ Scope</b>       · ⇆ This group only",
    `<b>⎔ Access</b>      · ⇆ ${escapeHtml(input.access ?? "Local-only")}`,
    "─────────────",
    `» <b>Note:</b> ${escapeHtml(input.note)}`,
    usage,
  ].join("\n");
}

export function pairingHelpCardText(): string {
  return [
    "⌬ ⤷ <b>PAIRING HELP</b> ⚙︎",
    "",
    "─────────────",
    "<b>⎔ Command</b> · ⇆ <code>/pair &lt;label&gt; &lt;number&gt;</code>",
    "─────────────",
    "» <b>Example:</b> <code>/pair support 2348012345678</code>",
    "» <b>Note:</b> Use full international format without the + symbol.",
  ].join("\n");
}

export function sessionPairingCardText(session: WhatsAppSession, phone: string, code: string): string {
  return [
    "ㅤ   ⚫︎  <b>𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜</b>  ⚫︎",
    "",
    "˗ˏˋ 🗝 ˎˊ˗  <b>SESSION PAIRING</b>  ✦",
    "─────────────",
    `<b>⎔ Session</b> · ⇆ ${escapeHtml(session.sessionName)}`,
    `<b>⎔ Phone</b>   · ⇆ ${escapeHtml(phone)}`,
    `<b>⎔ Code</b>    · ⇆ <code>${escapeHtml(code)}</code>`,
    "─────────────",
    `» <b>Instructions:</b> Open WhatsApp → Linked Devices → Link a Device → Link with phone number, then enter code <b>${escapeHtml(code)}</b>.`,
    "",
    "ℹ️ <i>Session chained to workspace and source Telegram owner.</i>",
  ].join("\n");
}

export function sessionStatusCardText(session: WhatsAppSession): string {
  const status = effectiveSessionStatus(session);
  const active = session.connectedAt ? new Date(session.connectedAt).toISOString().replace("T", " ").replace(".000Z", " UTC") : "—";
  return [
    "ㅤ   ⚫︎  <b>𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜</b>  ⚫︎",
    "",
    "˗ˏˋ ⎔ ˎˊ˗  <b>SESSION STATUS</b>  ✦",
    "─────────────",
    `<b>⎔ Session</b> · ⇆ ${escapeHtml(session.sessionName)}`,
    `<b>⎔ State</b>   · ⇆ ${escapeHtml(status)}`,
    `<b>⎔ Active</b>  · ⇆ ${escapeHtml(active)}`,
    "─────────────",
  ].join("\n");
}

export function memberBatchJobCardText(input: { action: string; selected: number; jobId: string }): string {
  return [
    "ㅤ   ⚫︎  <b>𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜</b>  ⚫︎",
    "",
    "˗ˏˋ ⚙︎ ˎˊ˗  <b>MEMBER BATCH JOB</b>  ✦",
    "─────────────",
    `<b>⎔ Action</b>    · ⇆ ${escapeHtml(input.action.toUpperCase())}`,
    `<b>⎔ Selected</b>  · ⇆ ${input.selected}`,
    `<b>⎔ Job ID</b>    · ⇆ <code>${escapeHtml(input.jobId)}</code>`,
    "─────────────",
    "» <b>Progress:</b> Open Telegram Live Show for detailed results.",
  ].join("\n");
}

function jobStatusIcon(state: string): string {
  return state === "COMPLETED"
    ? "✅"
    : state === "FAILED" || state === "CANCELLED"
      ? "⛔"
      : state === "RUNNING"
        ? "🟢"
        : state === "PAUSED"
          ? "⏸️"
          : "🟡";
}

function statusIcon(status: WhatsAppSession["status"]): string {
  return status === "ACTIVE"
    ? "🟢"
    : status === "PAIRING"
      ? "🟡"
      : status === "ERROR"
        ? "🔴"
        : "⚪";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}


export function autoPromoteScopeKeyboard(
  sessionId?: string,
  sessions: WhatsAppSession[] = [],
): InlineKeyboardMarkup {
  const sessionButtons = sessions.map((session) =>
    [btn(`Session · ${session.sessionName}`, `autopromote:scope:SESSION:${session.sessionId}`, "success")],
  );
  return keyboard([
    ...(sessionId
      ? [[btn("This Session", `autopromote:scope:SESSION:${sessionId}`, "success")]]
      : sessionButtons),
    [btn("All My Sessions", "autopromote:scope:USER", "primary")],
    [btn(ui.back, sessionId ? `session:${sessionId}:menu` : "menu:main")],
  ]);
}

export function autoPromoteCommandKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("All Status", "autopromote:command:allstatus", "primary")],
    [btn("All Status D · Designed", "autopromote:command:allstatusd", "success")],
    [btn("All Chat", "autopromote:command:allchat", "primary")],
    [btn("All Status X", "autopromote:command:allstatusx", "success")],
    [btn("Cancel", "autopromote:cancel", "danger")],
  ]);
}

export function autoPromoteDaysKeyboard(): InlineKeyboardMarkup {
  const values = Array.from({ length: 29 }, (_, index) => index + 2);
  const rows: Button[][] = [];
  for (let index = 0; index < values.length; index += 7)
    rows.push(values.slice(index, index + 7).map((value) => btn(String(value), `autopromote:days:${value}`)));
  rows.push([btn("Cancel", "autopromote:cancel", "danger")]);
  return keyboard(rows);
}

export function autoPromoteTimesKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [1, 2, 3, 4, 5].map((value) => btn(`${value} time${value === 1 ? "" : "s"}`, `autopromote:times:${value}`)),
    [btn("Cancel", "autopromote:cancel", "danger")],
  ]);
}

export function autoPromotePostsKeyboard(): InlineKeyboardMarkup {
  const rows: Button[][] = [];
  for (let index = 1; index <= 10; index += 5)
    rows.push(Array.from({ length: 5 }, (_, offset) => index + offset).map((value) => btn(String(value), `autopromote:posts:${value}`)));
  rows.push([btn("Cancel", "autopromote:cancel", "danger")]);
  return keyboard(rows);
}

export function autoPromoteConfirmKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("✅ Confirm Auto Promote", "autopromote:confirm", "success")],
    [btn("✎ Edit", "autopromote:edit", "primary"), btn("Cancel", "autopromote:cancel", "danger")],
  ]);
}

export function autoPromoteDashboardKeyboard(
  configs: AutoPromoteConfig[],
  newCallback = "autopromote:new",
  backCallback = "menu:main",
): InlineKeyboardMarkup {
  const rows: Button[][] = configs.slice(0, 20).map((config) => [
    btn(
      `${config.enabled ? "■" : "□"} ${config.command.toUpperCase()} · ${config.scope}`,
      `autopromote:view:${config.id}`,
    ),
  ]);
  rows.push([btn("＋ New Auto Promote", newCallback, "success")]);
  rows.push([btn(ui.back, backCallback)]);
  return keyboard(rows);
}

export function autoPromoteText(
  configs: AutoPromoteConfig[],
  runs: AutoPromoteRun[] = [],
): string {
  const configRows = configs.length
    ? configs
        .slice(0, 12)
        .map((config) => {
          const scope = config.scope === "GLOBAL"
            ? "ALL ACTIVE + FUTURE SESSIONS"
            : config.scope === "USER"
              ? "ALL SESSIONS OWNED BY USER"
              : `SESSION ${config.sessionId?.slice(0, 8) ?? "—"}`;
          const slotTimes = Object.values(config.slotTimes).filter(Boolean).join(", ");
          const payloadText = typeof config.payload.text === "string"
            ? config.payload.text
            : typeof config.payload.caption === "string"
              ? config.payload.caption
              : config.payload.media
                ? `[${config.payload.media.kind} attachment]`
                : "[empty payload]";
          const postsPerGroup = config.command === "allstatusx"
            ? config.allstatusxPostsPerGroup ?? 1
            : 1;
          return `${config.enabled ? "🟢" : "⚪"} <b>${escapeHtml(config.command.toUpperCase())}</b> · ${escapeHtml(config.state)}\n` +
            `<code>${escapeHtml(config.id.slice(0, 8))}</code> · <b>Scope:</b> ${escapeHtml(scope)}\n` +
            `<b>Schedule:</b> ${escapeHtml(config.startDate)} → ${escapeHtml(config.endDate)} · ${config.timesPerDay}x/day · ${escapeHtml(slotTimes)} · ${escapeHtml(config.timezone)}\n` +
            `<b>Posts/group:</b> ${postsPerGroup} · <b>Payload:</b> <code>${escapeHtml(payloadText.slice(0, 180))}</code>`;
        })
        .join("\n\n")
    : "No Auto Promote configurations have been created.";
  const runRows = runs
    .slice(0, 5)
    .map(
      (run) =>
        `<code>${escapeHtml(run.id.slice(0, 8))}</code> · ${escapeHtml(run.status)} · ${escapeHtml(run.sessionId.slice(0, 8))} · ${run.completedGroups}/${run.totalGroups} groups · ${run.successCount} success · ${run.failedGroups} failed`,
    )
    .join("\n");
  return pageText(
    "Auto Promote",
    infoResponse(
      "Durable Multi-Scope Scheduler",
      `${configRows}\n\n<b>Recent runs</b>\n${runRows || "No runs yet."}\n\n<i>Timezone-aware occurrences, per-session queue locks, cooldowns, and restart-safe run records are enabled.</i>`,
    ),
  );
}


export function autoPromoteGlobalTargetsKeyboard(
  sessions: WhatsAppSession[],
  selected: Set<string>,
): InlineKeyboardMarkup {
  const rows: Button[][] = sessions.map((session) => [
    btn(
      `${selected.has(session.sessionId) ? "✅" : "□"} ${session.sessionName}`,
      `autopromote:global:toggle:${session.sessionId}`,
      selected.has(session.sessionId) ? "success" : "primary",
    ),
  ]);
  rows.push([btn("✅ Use Selected Sessions", "autopromote:global:ready", "success")]);
  rows.push([btn("🌐 All ACTIVE + Future Sessions", "autopromote:global:all", "primary")]);
  rows.push([btn("↻ Refresh ACTIVE Sessions", "admin:autopromote:targets:refresh", "primary")]);
  rows.push([btn("Cancel", "autopromote:cancel", "danger")]);
  return keyboard(rows);
}


export function workloadKeyboard(hasWorker: boolean): InlineKeyboardMarkup {
  return keyboard([
    [btn("➕ Add Workload", "workload:add", "success")],
    [btn(hasWorker ? "▣ My Workloads" : "▣ My Workload", "workload:list")],
    [btn("🔗 Add Shared Panel", "workload:share:add", "primary")],
    [btn("⬇ Download Panel Worker", "workload:download", "success")],
    [btn("📖 Simple Setup Guide", "workload:guide")],
    [btn("↻ Refresh Status", "workload:status")],
    [btn(ui.back, "menu:main")],
  ]);
}

export function workloadText(
  mode: "ON" | "OFF",
  workers: Array<{ workerName?: string; workloadCode?: string; displayKey: string; status: string; workerVersion: string; lastHeartbeatAt?: number; assignedSessionIds: string[]; shared?: boolean }>,
): string {
  const body = workers.length
    ? workers.map((worker) => {
        const heartbeat = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toISOString() : "never";
        const code = worker.workloadCode ?? worker.displayKey;
        return `<b>${escapeHtml(worker.workerName ?? "Panel")}</b> · <code>${escapeHtml(code)}</code> · ${worker.shared ? "🔗 SHARED" : escapeHtml(worker.status)}\n<b>Version:</b> ${escapeHtml(worker.workerVersion)}\n<b>Heartbeat:</b> ${escapeHtml(heartbeat)}\n<b>Sessions:</b> ${worker.shared ? "Isolated to your workspace" : worker.assignedSessionIds.length}`;
      }).join("\n\n")
    : "No workload panel is attached to this workspace.";
  return pageText(
    "Workload",
    infoResponse(
      "Central control · panel execution",
      `<b>Central VPS workload:</b> ${mode === "ON" ? "🟢 ON" : "⚪ OFF"}\n\n${body}\n\n<b>How it works:</b> tap <b>Add Workload</b>. Telegram gives you a copyable pairing code and sends <code>index.js</code>. Upload that exact file to your panel, click <b>Start</b>, then paste the Telegram code when the panel asks. The panel becomes your workload and can host as many sessions as its resources can support. ${mode === "OFF" ? "New sessions currently require an ACTIVE workload." : "Existing sessions are not deleted when workload mode changes."}`,
    ),
  );
}

export function workloadPanelText(
  worker: { workerName?: string; workloadCode?: string; displayKey: string; status: string; workerVersion: string; lastHeartbeatAt?: number; assignedSessionIds: string[]; shared?: boolean },
): string {
  return pageText(
    "Workload Panel",
    infoResponse(
      `${escapeHtml(worker.workerName ?? "Panel")} · ${escapeHtml(worker.workloadCode ?? worker.displayKey)}`,
      `<b>Workload code:</b> <code>${escapeHtml(worker.workloadCode ?? worker.displayKey)}</code>\n<b>Access:</b> ${worker.shared ? "🔗 SHARED PANEL · child workspace" : "👑 OWNER PANEL"}\n<b>Status:</b> ${escapeHtml(worker.status)}\n<b>Version:</b> ${escapeHtml(worker.workerVersion)}\n<b>Last heartbeat:</b> ${worker.lastHeartbeatAt ? escapeHtml(new Date(worker.lastHeartbeatAt).toISOString()) : "never"}\n<b>Assigned sessions:</b> ${worker.shared ? "Only your sessions are visible" : worker.assignedSessionIds.length}\n\n<b>Tap the code button below to copy this workload code.</b> This panel can host your WhatsApp sessions within its available resources. Tap <b>Use This Workload</b> before pairing.`,
    ),
  );
}

export function workloadPanelKeyboard(workloadCode: string, shared = false): InlineKeyboardMarkup {
  return keyboard([
    [copyBtn(workloadCode, workloadCode, "success")],
    [btn("✓ Use This Workload", `workload:use:${workloadCode}`, "success")],
    ...(shared ? [] : [[btn("🔗 Share This Panel", `workload:share:${workloadCode}`, "primary")]]),
    ...(shared ? [] : [[btn("👥 Manage Shared Users", `workload:share:users:${workloadCode}`, "primary")]]),
    ...(shared ? [] : [[btn("▣ Logger", `workload:logger:${workloadCode}`, "primary")]]),
    [btn("↻ Check Again", "workload:status")],
    [btn(shared ? "↩ Unlink Shared Panel" : "🗑 Remove Workload", `${shared ? "workload:share:remove" : "workload:remove"}:${workloadCode}`, "danger")],
    [btn(ui.back, "workload:list")],
  ]);
}

export function workloadShareUsersText(
  worker: { workerName?: string; workloadCode?: string; displayKey: string },
  recipients: Array<{
    recipientDisplayName: string;
    recipientTelegramUserId: string;
    recipientUsername?: string;
    status: "ACTIVE" | "BLOCKED";
  }>,
): string {
  const body = recipients.length
    ? recipients.map((recipient, index) => `${index + 1}. <b>${escapeHtml(recipient.recipientDisplayName)}</b>${recipient.recipientUsername ? ` · @${escapeHtml(recipient.recipientUsername)}` : ""}\n<b>Telegram ID:</b> <code>${escapeHtml(recipient.recipientTelegramUserId)}</code>\n<b>Access:</b> ${recipient.status === "BLOCKED" ? "⛔ BLOCKED" : "🟢 ACTIVE"}`).join("\n\n")
    : "No users have redeemed a share code for this panel yet.";
  return pageText(
    "Workload · Shared Users",
    infoResponse(
      `${escapeHtml(worker.workerName ?? "Panel")} · ${escapeHtml(worker.workloadCode ?? worker.displayKey)}`,
      `${body}\n\n<b>Block:</b> immediately stops this user’s child-session commands and pairing access.\n<b>Unblock:</b> restores only this user’s shared access. The parent panel and other users are unaffected.`,
    ),
  );
}

export function workloadShareUsersKeyboard(
  workloadCode: string,
  recipients: Array<{ shareId: string; recipientDisplayName: string; status: "ACTIVE" | "BLOCKED" }>,
): InlineKeyboardMarkup {
  return keyboard([
    ...recipients.map((recipient) => [
      btn(`${recipient.status === "BLOCKED" ? "🟢 Unblock" : "⛔ Block"} · ${recipient.recipientDisplayName.slice(0, 22)}`, `workload:share:${recipient.status === "BLOCKED" ? "unblock" : "block"}:${recipient.shareId}`, recipient.status === "BLOCKED" ? "success" : "danger"),
    ]),
    [btn("↻ Refresh Users", `workload:share:users:${workloadCode}`)],
    [btn(ui.back, `workload:select:${workloadCode}`)],
  ]);
}

export function workloadLoggerText(snapshot: {
  worker: { workerName?: string; workloadCode?: string; displayKey: string; status: string; workerVersion: string; lastHeartbeatAt?: number; assignedSessionIds: string[] };
  connectionCount: number;
  timeoutCount: number;
  errorCount: number;
  lastConnectedAt?: number;
  lastTimeoutAt?: number;
  events: Array<{ at: number; state: string; detail?: string | undefined }>;
}): string {
  const worker = snapshot.worker;
  const code = worker.workloadCode ?? worker.displayKey;
  const heartbeat = worker.lastHeartbeatAt ? `${Math.max(0, Math.round((Date.now() - worker.lastHeartbeatAt) / 1000))}s ago` : "never";
  const state = worker.status === "ACTIVE" ? "🟢 ACTIVE" : worker.status === "UNREACHABLE" ? "🔴 OFFLINE" : `🟡 ${escapeHtml(worker.status)}`;
  const recent = snapshot.events.length
    ? snapshot.events.slice(0, 8).map((event) => `• <code>${escapeHtml(new Date(event.at).toISOString().slice(11, 19))}</code> · <b>${escapeHtml(event.state)}</b>${event.detail ? ` · ${escapeHtml(event.detail)}` : ""}`).join("\n")
    : "No state transitions recorded yet.";
  return pageText(
    "Workload · Logger",
    infoResponse(
      `${escapeHtml(worker.workerName ?? "Panel")} · <code>${escapeHtml(code)}</code>`,
      `<b>Panel health:</b> ${state}\n<b>Worker version:</b> <code>${escapeHtml(worker.workerVersion)}</code>\n<b>Heartbeat:</b> ${heartbeat}\n<b>Assigned sessions:</b> ${worker.assignedSessionIds.length}\n\n<b>Connection screen</b>\nConnected / recovered · <code>${snapshot.connectionCount}</code>\nHeartbeat timeouts · <code>${snapshot.timeoutCount}</code>\nErrors / degraded · <code>${snapshot.errorCount}</code>\nLast connected · ${snapshot.lastConnectedAt ? escapeHtml(new Date(snapshot.lastConnectedAt).toISOString()) : "—"}\nLast timeout · ${snapshot.lastTimeoutAt ? escapeHtml(new Date(snapshot.lastTimeoutAt).toISOString()) : "—"}\n\n<b>Live panel log</b>\n${recent}\n\nLogger refreshes this message only. Heartbeats stay silent in chat; alerts are sent only when the panel changes state.`,
    ),
  );
}

export function workloadLoggerKeyboard(workloadCode: string): InlineKeyboardMarkup {
  return keyboard([
    [btn("↻ Refresh Logger", `workload:logger:refresh:${workloadCode}`, "primary")],
    [btn("‹ Panel", `workload:select:${workloadCode}`)],
    [btn(ui.back, "workload:list")],
  ]);
}

export function workloadGuideText(controlUrl?: string): string {
  return pageText(
    "Workload Deployment Guide",
    infoResponse(
      "Deploy once · paste one Telegram code",
      `<b>1.</b> Tap <b>Add Workload</b>. Telegram shows a black-quote instruction screen, a copy button for your private pairing code, and sends the exact <code>index.js</code> file.\n<b>2.</b> Save the code and the file. On your Node.js 20+ panel, the file name must be exactly <code>index.js</code>; rename it if the panel changed the name.\n<b>3.</b> Upload <code>index.js</code> into the panel and click <b>Start</b>. Wait while the panel installs and verifies its runtime. Do not type anything during installation.\n<b>4.</b> When the console says <b>Paste the pairing code from Telegram</b>, paste the code you copied from this bot. The panel registers itself automatically.\n<b>5.</b> Return to Telegram and tap <b>Refresh Status</b>. When the panel is <b>ACTIVE</b> with a fresh heartbeat, tap <b>Use This Workload</b> and then <b>Pair Number</b>.\n\nYou do not need an <code>.env</code> file, <code>package.json</code>, MongoDB, Redis, Telegram token, terminal enrollment command, or permanent-code exchange. The worker contains only WhatsApp workload runtime, while Telegram remains the control plane. Keep <code>pappy-workload-data</code> persistent so sessions survive restarts.\n\n<b>Control URL:</b> <code>${escapeHtml(controlUrl ?? "configured by the owner")}</code>`,
    ),
  );
}

export function adminWorkloadText(
  mode: "ON" | "OFF",
  workers: Array<{ workerId: string; workerName?: string; workloadCode?: string; displayKey: string; ownerTelegramUserId: string; status: string; workerVersion: string; lastHeartbeatAt?: number; assignedSessionIds: string[] }>,
): string {
  const body = workers.length
    ? workers.map((worker) => `<b>${escapeHtml(worker.workerName ?? "Panel")}</b> · <code>${escapeHtml(worker.workloadCode ?? worker.displayKey)}</code> · ${escapeHtml(worker.status)}\n<code>${escapeHtml(worker.workerId.slice(0, 12))}</code> · owner <code>${escapeHtml(worker.ownerTelegramUserId)}</code>\nversion ${escapeHtml(worker.workerVersion)} · sessions ${worker.assignedSessionIds.length} · heartbeat ${worker.lastHeartbeatAt ? escapeHtml(new Date(worker.lastHeartbeatAt).toISOString()) : "never"}`).join("\n\n")
    : "No external workload workers are registered.";
  return pageText(
    "Admin · Workload",
    infoResponse(
      `Owner workload mode: ${mode}`,
      `${body}\n\n<b>ON:</b> new users may choose the central VPS workload or an ACTIVE external panel.\n<b>OFF:</b> central VPS pairing is blocked; users must deploy or select an external panel. Existing sessions, assignments, and auth are preserved.\n\n<b>Worker Pause:</b> pauses command traffic to that panel immediately while keeping its heartbeat, sessions, and auth files. Re-enable it to resume traffic.\n\nUse the controls below to change placement policy or inspect a worker.`,
    ),
  );
}

export function adminWorkloadKeyboard(mode: "ON" | "OFF", workers: Array<{ workerId: string; displayKey: string; status: string }>): InlineKeyboardMarkup {
  return keyboard([
    [btn(mode === "ON" ? "⚪ Turn Workload OFF" : "🟢 Turn Workload ON", "admin:workload:toggle", mode === "ON" ? "danger" : "success")],
    ...workers.map((worker) => [btn(`${worker.status === "DISABLED" ? "▶ Resume traffic" : "⏸ Pause traffic"} · ${worker.displayKey}`, `admin:workload:worker:${worker.workerId}`)]),
    [btn("↻ Refresh", "admin:workload")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function adminWorkloadWorkerText(worker: { workerId: string; workerName?: string; workloadCode?: string; displayKey: string; status: string; ownerTelegramUserId: string; workerVersion: string; assignedSessionIds: string[]; lastHeartbeatAt?: number; lastError?: string | undefined }): string {
  return pageText(
    "Admin · Workload Worker",
    infoResponse(
      `Worker ${escapeHtml(worker.workerName ?? "Panel")} · ${escapeHtml(worker.workloadCode ?? worker.displayKey)}`,
      `<b>Code:</b> <code>${escapeHtml(worker.workloadCode ?? worker.displayKey)}</code>\n<b>ID:</b> <code>${escapeHtml(worker.workerId)}</code>\n<b>Owner:</b> <code>${escapeHtml(worker.ownerTelegramUserId)}</code>\n<b>Status:</b> ${escapeHtml(worker.status)}\n<b>Traffic:</b> ${worker.status === "DISABLED" ? "PAUSED · commands blocked" : "OPEN · commands allowed"}\n<b>Version:</b> ${escapeHtml(worker.workerVersion)}\n<b>Sessions:</b> ${worker.assignedSessionIds.length}\n<b>Heartbeat:</b> ${worker.lastHeartbeatAt ? escapeHtml(new Date(worker.lastHeartbeatAt).toISOString()) : "never"}${worker.lastError ? `\n<b>Last error:</b> ${escapeHtml(worker.lastError)}` : ""}`,
    ),
  );
}

export function adminWorkloadWorkerKeyboard(workerId: string, disabled: boolean): InlineKeyboardMarkup {
  return keyboard([
    [btn(disabled ? "▶ Resume Traffic" : "⏸ Pause Traffic", `admin:workload:worker:toggle:${workerId}`, disabled ? "success" : "danger")],
    [btn("↻ Refresh Registry", `admin:workload:worker:check:${workerId}`)],
    [btn(ui.back, "admin:workload")],
  ]);
}
