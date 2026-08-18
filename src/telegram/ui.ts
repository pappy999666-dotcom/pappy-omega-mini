import type { InlineKeyboardMarkup } from "telegraf/types";
import type { WhatsAppSession } from "../types/domain.js";
import { buildSessionMenu } from "../menus/menu-model.js";
import { renderTelegramSessionMenu } from "../menus/renderers.js";
import { infoResponse } from "./renderer.js";

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
  return { text, callback_data, style };
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

export function keyboard(rows: Button[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows } as InlineKeyboardMarkup;
}

export function dashboardKeyboard(isAdmin: boolean): InlineKeyboardMarkup {
  const rows: Button[][] = [
    [
      btn("⚡ Pair Number", "session:new", "success"),
      btn("▣ Sessions", "sessions:list:0"),
    ],
    [
      btn("⌁ Validator Hub", "bucket:status"),
      btn("🌉 Global Bridge", "bridge:global"),
    ],
    [btn("◷ Scheduled Jobs", "jobs:list"), btn("⚙ Settings", "settings:menu")],
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
  active = false,
): InlineKeyboardMarkup {
  return keyboard([
    [btn("➕ Add WhatsApp Session", "session:new", "success")],
    ...(sessionCount > 0
      ? [
          [btn("1️⃣ Choose Sessions", "bridge:global:select")],
          [
            btn(
              "✉️ Send One Command to Selected",
              "bridge:global:command",
              "success",
            ),
          ],
        ]
      : []),
    [
      btn(
        active ? "⏹ Stop Fan-Out" : "▶ Start Fan-Out",
        "bridge:global:toggle",
        active ? "danger" : "success",
      ),
    ],
    ...(sessionCount > 0
      ? [[btn("⏹ Stop Fan-Out", "bridge:global:stop", "danger")]]
      : []),
    [btn(ui.back, "menu:main")],
  ]);
}
export function globalBridgeText(selected = 0, active = false): string {
  return pageText(
    "Global Command Fan-Out",
    infoResponse(
      "One action · many owned sessions",
      `<b>What this does:</b> run one WhatsApp command across every session you select.\n<b>Selected:</b> ${selected} session${selected === 1 ? "" : "s"}\n<b>Status:</b> ${active ? "ON — accepting fan-out commands" : "OFF — nothing is running"}\n\nThis is not the per-session Bridge. It is your workspace-wide command desk.`,
    ),
  );
}

export function globalBridgeResultText(
  command: string,
  results: Array<{ sessionName: string; ok: boolean; output: string }>,
): string {
  const lines = results
    .map(
      (result) =>
        `${result.ok ? "✅" : "⛔"} <b>${escapeHtml(result.sessionName)}</b>\n<code>${escapeHtml(result.output.slice(0, 500))}</code>`,
    )
    .join("\n\n");
  return pageText(
    "Fan-Out Result",
    infoResponse(
      `Command completed: ${escapeHtml(command)}`,
      lines || "No session returned a result.",
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
    btn("✉️ Send Command", "bridge:global:command", "success"),
    btn("↻ Clear Selection", "bridge:global:clear"),
  ]);
  rows.push([btn(ui.back, "bridge:global")]);
  return keyboard(rows);
}

export function sessionKeyboard(
  session: WhatsAppSession,
  isOwner: boolean,
): InlineKeyboardMarkup {
  const actions = buildSessionMenu(session, isOwner).actions;
  const rows: Button[][] = [];
  for (let i = 0; i < actions.length; i += 2) {
    rows.push(
      actions
        .slice(i, i + 2)
        .map((action) =>
          btn(
            `${action.label}`,
            `session:${session.sessionId}:action:${action.id}`,
            action.id === "gpp" ? "danger" : "primary",
          ),
        ),
    );
  }
  rows.push([
    btn("↻ Refresh", `session:${session.sessionId}:menu`),
    btn("‹ Sessions", "sessions:list:0"),
  ]);
  return keyboard(rows);
}

export function linkCollectionKeyboard(
  sessionId: string,
): InlineKeyboardMarkup {
  return keyboard([
    [btn("📊 Refresh Statistics", `session:${sessionId}:collect`, "success")],
    [btn("📡 Live Collection Log", `session:${sessionId}:collect:live`)],
    [btn(ui.back, `session:${sessionId}:menu`)],
  ]);
}

export function validatorDashboardText(snapshot: {
  counts: Record<string, number>;
  recent: Array<{ canonicalUrl: string; bucket: string }>;
  capturedAt: number;
}): string {
  const recent =
    snapshot.recent
      .slice(0, 6)
      .map(
        (record) =>
          `• <code>${escapeHtml(record.canonicalUrl.slice(0, 72))}</code> <i>${escapeHtml(record.bucket)}</i>`,
      )
      .join("\n") || "No link records yet.";
  return pageText(
    "Validator Hub",
    infoResponse(
      "Live Workspace Buckets",
      `<b>Main:</b> ${snapshot.counts.main ?? 0}  <b>Active:</b> ${snapshot.counts.active ?? 0}\n<b>Dead:</b> ${snapshot.counts.dead ?? 0}  <b>Error:</b> ${snapshot.counts.error ?? 0}\n<b>Master:</b> ${snapshot.counts.master ?? 0}\n\n<b>Recent records</b>\n${recent}\n\n<i>Updated ${new Date(snapshot.capturedAt).toISOString()}</i>`,
    ),
  );
}

export function validatorLiveText(
  snapshot: {
    counts: Record<string, number>;
    recent: Array<{ canonicalUrl: string; bucket: string }>;
    capturedAt: number;
  },
  active = false,
): string {
  const recent =
    snapshot.recent
      .slice(0, 10)
      .map(
        (record) =>
          `• <code>${escapeHtml(record.canonicalUrl.slice(0, 72))}</code> <i>${escapeHtml(record.bucket)}</i>`,
      )
      .join("\n") || "Waiting for link activity.";
  return pageText(
    "Validator Live Log",
    infoResponse(
      active ? "Live feed is ON" : "Live feed is OFF",
      `<b>What you see:</b> link collection and validation changes for this workspace.\n<b>Main:</b> ${snapshot.counts.main ?? 0}  <b>Active:</b> ${snapshot.counts.active ?? 0}  <b>Dead:</b> ${snapshot.counts.dead ?? 0}  <b>Error:</b> ${snapshot.counts.error ?? 0}\n\n${recent}\n\n<i>Snapshot ${new Date(snapshot.capturedAt).toISOString()}</i>`,
    ),
  );
}

export function validatorLiveKeyboard(active = false): InlineKeyboardMarkup {
  return keyboard([
    [
      btn(
        active ? "⏹ Turn Live Log Off" : "▶ Turn Live Log On",
        active ? "bucket:live:off" : "bucket:live:on",
        active ? "danger" : "success",
      ),
    ],
    [btn("🔄 Refresh Log", "bucket:live:refresh")],
    [btn("‹ Validator Hub", "bucket:status")],
  ]);
}

export function bucketKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [
      btn("📡 Live Validation Log", "bucket:live", "success"),
      btn("🔄 Refresh", "bucket:status"),
    ],
    [
      btn("📦 Main / Master", "bucket:view:main"),
      btn("✅ Active", "bucket:view:active"),
    ],
    [btn("💀 Dead", "bucket:view:dead"), btn("⚠️ Error", "bucket:view:error")],
    [btn("🔀 Merge Active + Error → Main", "bucket:merge:main", "success")],
    [btn("⬇️ Downloads", "bucket:downloads")],
    [
      btn("🗑 Purge Dead", "bucket:purge:dead", "danger"),
      btn("🗑 Purge Error", "bucket:purge:error", "danger"),
    ],
    [btn("🗑 Purge Everything", "bucket:purge:master", "danger")],
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
      btn("🎯 Target Groups", `session:${sessionId}:join:setlimit`),
      btn("⏱ Delay", `session:${sessionId}:join:setdelay`),
    ]);
  if (status !== "running")
    rows.push([btn("🔁 Batch Cycles", `session:${sessionId}:join:setbatch`)]);
  rows.push([btn("🔄 Refresh", `session:${sessionId}:joinmgr`)]);
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
  defaultJoinDelayMs: number;
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
        `Join delay: ${Math.round(settings.defaultJoinDelayMs / 1000)}s`,
        "settings:delay:cycle",
      ),
    ],
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

export function forceJoinKeyboard(
  targets: ForceJoinTargetView[],
): InlineKeyboardMarkup {
  const rows: Button[][] = targets.map((target) => [
    btn(
      `↗ ${target.buttonText}`,
      `forcejoin:open:${target.targetId}`,
      "primary",
    ),
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
    : "No master-bucket records are available.";
  return pageText(
    "Admin · Master Bucket",
    infoResponse(
      "Validator Workspace Snapshot",
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
    : "No WhatsApp sessions are currently persisted.";
  return pageText(
    "Admin · Global Bridge",
    infoResponse(
      "Owner Cross-Workspace Control",
      `${body}\n\nSelect a session only after confirming the workspace and intended operation. Destructive fan-out remains bounded and auditable.`,
    ),
  );
}

export function adminBridgeKeyboard(
  sessions: WhatsAppSession[],
): InlineKeyboardMarkup {
  const rows: Button[][] = sessions.map((session) => [
    btn(
      `Open ${session.sessionName}`,
      `admin:bridge:session:${session.workspaceId}:${session.sessionId}`,
      "primary",
    ),
  ]);
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

export function adminKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn("⚙ Force Join", "admin:forcejoin"), btn("◉ Users", "admin:users")],
    [
      btn("▣ Media", "admin:media"),
      btn("🌉 Global Bridge Ops", "admin:bridge"),
    ],
    [
      btn("◷ Global Jobs", "admin:jobs"),
      btn("▤ Master Bucket", "admin:bucket"),
    ],
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

export function adminJobsKeyboard(jobs: AdminJobView[]): InlineKeyboardMarkup {
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
    [btn("▣ Select WhatsApp Menu Media", "admin:media:select")],
    [btn(ui.back, "admin:panel")],
  ]);
}

export function sessionText(session: WhatsAppSession): string {
  const model = buildSessionMenu(session, false);
  const rendered = renderTelegramSessionMenu(model);
  return pageText(
    "Per-Session Control",
    rendered.text.replace(/<b>.*?<\/b>\n?/s, "").trim(),
  );
}

export function workspaceSettingsText(settings: {
  defaultAutoJoinEnabled: boolean;
  defaultPrefix: string;
  defaultJoinDelayMs: number;
}): string {
  return pageText(
    "Workspace Settings",
    infoResponse(
      "Applies to all owned sessions",
      `<b>Auto-join:</b> ${settings.defaultAutoJoinEnabled ? "ON" : "OFF"}\n<b>Default prefix:</b> <code>${escapeHtml(settings.defaultPrefix || "none")}</code>\n<b>Join delay:</b> <code>${Math.round(settings.defaultJoinDelayMs / 1000)}s</code>\n\nChanges are persisted and propagated to every session in this workspace.`,
    ),
  );
}

export function dashboardText(isAdmin: boolean): string {
  return pageText(
    "Command Center",
    `${isAdmin ? "<b>Owner control plane</b>" : "<b>Personal workspace</b>"}\n\nChoose a workspace-wide action or open one of your isolated WhatsApp sessions.\n\n${ui.info} <b>Scope:</b> workspace-safe\n${ui.info} <b>Bridge:</b> global or per-session\n${ui.info} <b>Queues:</b> bounded and recoverable`,
  );
}

export function helpText(): string {
  return pageText(
    "Help & Shortcuts",
    "<b>Workspace</b> — Global Bridge, Validator Hub, Scheduled Jobs, Settings, Support.\n<b>Session</b> — Pairing, profile controls, link collection, Join Manager, and per-session Bridge.\n<b>WhatsApp</b> — <code>.menu</code>, <code>.ping</code>, <code>.autojoin on|off</code>, <code>.pfp</code>, <code>.setgpp</code>, <code>.groups</code>, <code>.health</code>, <code>.setname</code>, <code>.setbio</code>, <code>.setsudo</code>, and <code>.setprefix</code>.\n\n${ui.info} <b>Security:</b> Admin controls are never rendered for ordinary users and are checked again on every callback.",
  );
}

export function pageText(title: string, body: string): string {
  return `<b>${ui.brand}</b>\n${ui.divider}\n\n<b>${escapeHtml(title)}</b>\n\n<blockquote>${body}</blockquote>`;
}

export function featureText(title: string, body: string): string {
  return pageText(title, body);
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
