/**
 * Digital OS — app orchestration.
 *
 * Sits on top of the pure builder + session store. Registers the reusable
 * "apps" that appear in the drawer; today that is the Anti System editor
 * (`.os` → "Anti System" → module → Done writes GroupAntiConfig through the
 * exact same load/save functions the `.antilink`-style text commands use).
 *
 * Every screen is derived fresh from `loadGroupAntiConfig` on each render, so
 * the OS UI can never display state the text commands changed out from under
 * it — the two surfaces share one source of truth.
 */
import type { CommandContext, WhatsAppCommandReply } from "../command-registry.js";
import { getSession } from "../../core/session-registry.js";
import { buildDosHtmlScreen } from "./html-app.js";
import {
  createDosSession,
  commitDosSession,
  getDosSession,
  getDosSessionByToken,
  parseDosInteractionId,
  updateDosSession,
  dosIdentitiesMatch,
  type DosDraft,
  type DosValue,
} from "./session.js";
import {
  DEFAULT_MAX_BUTTONS,
  renderDosPage,
  type DosButton,
  type DosRow,
} from "./builder.js";
import {
  allModuleKeys,
  loadGroupAntiConfig,
  moduleCapability,
  saveGroupAntiConfig,
} from "../anti-system/config.js";
import { ensureModule } from "../anti-system/config.js";
import type { AntiAction, AntiModuleConfig, AntiModuleKey } from "../anti-system/types.js";

/** Pending probe: real client cap feeds this; 4 is the safe interim default. */
export const DOS_MAX_BUTTONS = DEFAULT_MAX_BUTTONS;

export type DosRenderScreen = {
  title: string;
  rows: DosRow[];
  showDone: boolean;
  showBack: boolean;
  showHome?: boolean;
};

export interface DosAppDefinition {
  id: string;
  label: string;
  badge?: string;
  /** Materialize the CURRENT screen of a draft into a renderable screen. */
  materialize(draft: DosDraft): DosRenderScreen;
}

const apps = new Map<string, DosAppDefinition>();

export function registerDosApp(app: DosAppDefinition): void {
  apps.set(app.id, app);
}

export function dosAppIds(): string[] {
  return [...apps.keys()];
}

// ---------------------------------------------------------------------------
// Human labels for the common anti modules
// ---------------------------------------------------------------------------
const MODULE_LABELS: Partial<Record<AntiModuleKey, string>> = {
  antilink: "Link",
  antibot: "Bot",
  antispam: "Spam",
  antipic: "Pic",
  antivid: "Video",
  antiaud: "Audio",
  antivn: "Voice",
  antitxt: "Text",
  antiemoji: "Emoji",
  antisticker: "Sticker",
  antiwords: "Words",
  antipoll: "Poll",
  antiforward: "Forward",
  antichannel: "Channel",
};

const ANTI_GROUPS: Array<{ id: string; label: string; keys: AntiModuleKey[] }> = [
  { id: "msg", label: "Message", keys: ["antilink", "antibot", "antiwords", "antipoll", "antiforward"] },
  { id: "media", label: "Media", keys: ["antipic", "antivid", "antiaud", "antivn", "antiemoji", "antisticker"] },
  { id: "group", label: "Group", keys: ["antichannel", "antigroupmention", "antigm", "antigstatus", "antipromote", "antidemote"] },
  { id: "spam", label: "Spam", keys: ["antispam"] },
];

const ACTION_OPTIONS: AntiAction[] = ["kick", "warn", "delete"];
const DEFAULT_WARN_THRESHOLD = 3;

function moduleLabel(key: AntiModuleKey): string {
  const label = MODULE_LABELS[key] ?? key.replace(/^anti/iu, "");
  return label.slice(0, 10);
}

function valueOf(draft: DosDraft, key: string, fallback: DosValue): DosValue {
  return draft.values[key] ?? fallback;
}

// ---------------------------------------------------------------------------
// Anti System app
// ---------------------------------------------------------------------------
function materializeAnti(draft: DosDraft): DosRenderScreen {
  const config = loadGroupAntiConfig(
    draft.workspaceId,
    draft.sessionId,
    draft.chatJid,
  );
  const local = draft.screen.replace(/^anti:/u, "");
  if (local === "home") {
    const rows: DosRow[] = [];
    for (const group of ANTI_GROUPS) {
      const enabledCount = group.keys.filter((key) => config[key]?.enabled).length;
      rows.push({
        kind: "tile",
        id: `anti:group:${group.id}`,
        label: group.label,
        ...(enabledCount > 0 ? { badge: `${enabledCount} on` } : {}),
      });
    }
    return { title: "📱 ANTI SYSTEM", rows, showDone: false, showBack: true };
  }
  const groupMatch = /^group:(.+)$/u.exec(local);
  if (groupMatch) {
    const group = ANTI_GROUPS.find((candidate) => candidate.id === groupMatch[1]);
    const rows: DosRow[] = (group?.keys ?? []).map((key) => ({
      kind: "tile",
      id: `anti:module:${key}`,
      label: moduleLabel(key),
      ...(config[key]?.enabled ? { badge: "ON" } : {}),
    }));
    return {
      title: `📱 ANTI · ${(group?.label ?? "").toUpperCase()}`,
      rows,
      showDone: false,
      showBack: true,
    };
  }
  const match = /^module:(.+)$/u.exec(local);
  if (!match) return { title: "ANTI", rows: [], showDone: false, showBack: true };
  const key = match[1] as AntiModuleKey;
  const current: AntiModuleConfig = config[key] ?? {
    enabled: false,
    action: "delete",
    warnThreshold: DEFAULT_WARN_THRESHOLD,
    permitList: [],
  };
  const enabled = Boolean(valueOf(draft, `mod:${key}.enabled`, current.enabled));
  const action = String(valueOf(draft, `mod:${key}.action`, current.action)) as AntiAction;
  const warnThreshold = Number(valueOf(draft, `mod:${key}.warnThreshold`, current.warnThreshold));
  const rows: DosRow[] = [
    { kind: "toggle", id: `mod:${key}.enabled`, label: "Enable", value: enabled, ctlText: enabled ? "On ✓" : "On" },
    {
      kind: "cycle",
      id: `mod:${key}.action`,
      label: "Action",
      options: ACTION_OPTIONS,
      index: Math.max(0, ACTION_OPTIONS.indexOf(action)),
    },
  ];
  if (action === "warn") {
    rows.push({
      kind: "stepper",
      id: `mod:${key}.warnThreshold`,
      label: "Warn-limit",
      value: warnThreshold,
      min: 1,
      max: 10,
      default: DEFAULT_WARN_THRESHOLD,
    });
  }
  if (key === "antispam") {
    const spam = config.antispam;
    rows.push(
      {
        kind: "stepper",
        id: `mod:antispam.messageLimit`,
        label: "Msg-limit",
        value: Number(valueOf(draft, "mod:antispam.messageLimit", spam?.messageLimit ?? 10)),
        min: 1,
        max: 1000,
        default: 10,
      },
      {
        kind: "stepper",
        id: "mod:antispam.windowSeconds",
        label: "Window-s",
        value: Number(valueOf(draft, "mod:antispam.windowSeconds", spam?.windowSeconds ?? 5)),
        min: 1,
        max: 3600,
        default: 5,
      },
    );
  }
  if (key === "antiwords") {
    rows.push({
      kind: "info",
      text: `Words: ${(config.antiwords?.words ?? []).length} · manage via .antiwords`,
    });
  }
  const capability = moduleCapability(key);
  if (capability.capability !== "supported") {
    rows.push({
      kind: "info",
      text: `Capability: ${capability.capability}${capability.reason ? ` — ${capability.reason}` : ""}`,
    });
  }
  return {
    title: `📱 ANTI · ${moduleLabel(key).toUpperCase()}`,
    rows,
    showDone: true,
    showBack: true,
  };
}

registerDosApp({
  id: "anti",
  label: "Anti System",
  badge: "config",
  materialize: materializeAnti,
});

// ---------------------------------------------------------------------------
// OS Live Demo — a fully interactive showcase (nothing is persisted): it proves
// the whole control matrix works — toggles, action chips, stepper, paging and
// Done — so tapping around never lands on an empty or unexplained screen.
// ---------------------------------------------------------------------------
const DEMO_TOGGLES = [
  { id: "demo.sound", label: "Sound" },
  { id: "demo.vibrate", label: "Vibrate" },
  { id: "demo.preview", label: "Preview" },
  { id: "demo.hide", label: "Hide" },
  { id: "demo.compact", label: "Compact" },
  { id: "demo.auto", label: "Auto" },
];

function materializeDemo(draft: DosDraft): DosRenderScreen {
  const local = draft.screen.replace(/^demo:/u, "");
  if (local !== "home") return { title: "DEMO", rows: [], showDone: false, showBack: true };
  const rows: DosRow[] = DEMO_TOGGLES.map((toggle) => ({
    kind: "toggle",
    id: toggle.id,
    label: toggle.label,
    value: Boolean(valueOf(draft, toggle.id, false)),
    ctlText: "On",
  }));
  rows.push(
    {
      kind: "cycle",
      id: "demo.action",
      label: "Sample act",
      options: ["kick", "warn", "delete"],
      index: Math.max(
        0,
        ["kick", "warn", "delete"].indexOf(String(valueOf(draft, "demo.action", "warn"))),
      ),
    },
    {
      kind: "stepper",
      id: "demo.count",
      label: "Demo count",
      value: Number(valueOf(draft, "demo.count", 3)),
      min: 1,
      max: 9,
      default: 3,
    },
    {
      kind: "info",
      text: "Live demo — every control morphs here; Done only summarizes",
    },
  );
  return {
    title: "📱 OS LIVE DEMO",
    rows,
    showDone: true,
    showBack: true,
  };
}

registerDosApp({
  id: "demo",
  label: "OS Demo",
  badge: "live",
  materialize: materializeDemo,
});

function demoSummary(draft: DosDraft): string {
  const enabled = DEMO_TOGGLES.filter((toggle) => draft.values[toggle.id] === true).length;
  const action = String(valueOf(draft, "demo.action", "warn"));
  const count = Number(valueOf(draft, "demo.count", 3));
  return [
    "✅ OS LIVE DEMO — COMPLETE",
    `Enabled ${enabled}/${DEMO_TOGGLES.length}`,
    `Sample action ${action}`,
    `Demo count ${count}${count === 3 ? " (d3)" : ""}`,
    "Nothing was persisted — this was a live showcase.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Drawer (main app list)
// ---------------------------------------------------------------------------
function materializeResult(draft: DosDraft): DosRenderScreen {
  const body = String(valueOf(draft, "result.body", "The operation completed."));
  return {
    title: String(valueOf(draft, "result.title", "✓ PAPPY OS · COMPLETE")),
    rows: body.split("\n").filter(Boolean).map((text) => ({ kind: "info" as const, text })),
    showDone: false,
    showBack: false,
    showHome: true,
  };
}

function materializeDrawer(_draft: DosDraft): DosRenderScreen {
  return {
    title: "📱 PAPPY OS",
    rows: drawerRows(),
    showDone: false,
    showBack: false,
  };
}

// ---------------------------------------------------------------------------
// Screen routing for a draft
// ---------------------------------------------------------------------------
export function resolveScreen(draft: DosDraft): DosRenderScreen {
  if (draft.screen === "drawer") return materializeDrawer(draft);
  if (draft.screen === "result") return materializeResult(draft);
  const appId = draft.screen.split(":")[0] ?? "";
  const app = apps.get(appId);
  if (app) return app.materialize(draft);
  return materializeDrawer(draft);
}

// ---------------------------------------------------------------------------
// Seed a module's draft values from the live config when it is opened
// ---------------------------------------------------------------------------
function seedModuleValues(
  draft: DosDraft,
  key: AntiModuleKey,
  config: ReturnType<typeof loadGroupAntiConfig>,
): Record<string, DosValue> {
  const current = config[key] as AntiModuleConfig | undefined;
  const seeded: Record<string, DosValue> = {
    [`mod:${key}.enabled`]: current?.enabled ?? false,
    [`mod:${key}.action`]: current?.action ?? ("delete" as AntiAction),
    [`mod:${key}.warnThreshold`]: current?.warnThreshold ?? DEFAULT_WARN_THRESHOLD,
  };
  if (key === "antispam") {
    seeded["mod:antispam.messageLimit"] = config.antispam?.messageLimit ?? 10;
    seeded["mod:antispam.windowSeconds"] = config.antispam?.windowSeconds ?? 5;
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Commit: Done on a module screen → write the module back through GroupAntiConfig
// ---------------------------------------------------------------------------
function commitScreen(draft: DosDraft): string {
  if (draft.screen.startsWith("demo:")) return demoSummary(draft);
  const moduleMatch = /^anti:module:(.+)$/u.exec(draft.screen);
  if (!moduleMatch) return "Nothing to commit on this screen.";
  const key = moduleMatch[1] as AntiModuleKey;
  const config = loadGroupAntiConfig(draft.workspaceId, draft.sessionId, draft.chatJid);
  const module = ensureModule(config, key);
  const enabled = draft.values[`mod:${key}.enabled`];
  const action = draft.values[`mod:${key}.action`];
  const threshold = draft.values[`mod:${key}.warnThreshold`];
  const patch: Partial<AntiModuleConfig> & { messageLimit?: number; windowSeconds?: number } = {};
  if (typeof enabled === "boolean") patch.enabled = enabled;
  if (typeof action === "string" && ACTION_OPTIONS.includes(action as AntiAction))
    patch.action = action as AntiAction;
  if (typeof threshold === "number") patch.warnThreshold = threshold;
  if (key === "antispam") {
    const messageLimit = draft.values["mod:antispam.messageLimit"];
    const windowSeconds = draft.values["mod:antispam.windowSeconds"];
    if (typeof messageLimit === "number") patch.messageLimit = messageLimit;
    if (typeof windowSeconds === "number") patch.windowSeconds = windowSeconds;
  }
  Object.assign(module, patch);
  saveGroupAntiConfig(config);
  const lines = [
    `✅ ANTI · ${moduleLabel(key).toUpperCase()} SAVED`,
    `Enable ${module.enabled ? "ON" : "OFF"}`,
    `Action ${module.action}`,
    `Warn-limit ${module.warnThreshold}${module.warnThreshold === DEFAULT_WARN_THRESHOLD ? " (d3)" : ""}`,
  ];
  const spam = module as AntiModuleConfig & { messageLimit?: number; windowSeconds?: number };
  if (key === "antispam") {
    lines.push(`Msg-limit ${spam.messageLimit ?? 10}`);
    lines.push(`Window-s ${spam.windowSeconds ?? 5}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Render a draft to a WhatsApp reply (shared by .os and every dos: tap).
//
// The official OS surface is one compact native-flow response:
//   - text: the current screen/page state,
//   - native-flow: the controls whose ids are `dos:<token>:<verb>`.
// The slot-machine HTML primitive remains available through the explicit
// legacy HTML beacon path below, but is not attached to `.os` responses.
// ---------------------------------------------------------------------------
function replyForDraft(
  draft: DosDraft,
  extraRows: DosRow[] = [],
  includeHtml = false,
): WhatsAppCommandReply {
  const screen = resolveScreen(draft);
  const rows = [...screen.rows, ...extraRows];
  const rendered = renderDosPage({
    token: draft.token,
    appId: draft.appId,
    screen: draft.screen,
    title: screen.title,
    rows,
    page: draft.page,
    maxButtons: DOS_MAX_BUTTONS,
    showDone: screen.showDone,
    showBack: screen.showBack,
    ...(screen.showHome !== undefined ? { showHome: screen.showHome } : {}),
  });
  const reply: WhatsAppCommandReply = {
    text: rendered.lines.join("\n"),
    nativeFlow: rendered.buttons,
  };
  const digits = botDigits(draft.workspaceId, draft.sessionId);
  if (includeHtml && digits.length >= 7) {
    reply.htmlBubble = buildDosHtmlScreen({
      token: draft.token,
      botNumber: digits,
      title: screen.title,
      rows,
      page: rendered.page,
      maxButtons: DOS_MAX_BUTTONS,
      showDone: screen.showDone,
      showBack: screen.showBack,
    });
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Entry: .os opens the drawer
// ---------------------------------------------------------------------------
export function openDosDrawer(ctx: CommandContext): WhatsAppCommandReply | string {
  if (!ctx.chatJid || !ctx.senderJid)
    return "Digital OS needs a WhatsApp chat with a verified sender.";
  const draft = createDosSession({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    chatJid: ctx.chatJid,
    initiatorJid: ctx.senderJid,
    appId: "os",
    screen: "drawer",
  });
  return replyForDraft(draft);
}

// ---------------------------------------------------------------------------
// Interaction dispatch: dos:<token>:<verb>
// ---------------------------------------------------------------------------
export async function handleDosInteraction(
  interactionId: string,
  ctx: CommandContext,
): Promise<WhatsAppCommandReply | string | undefined> {
  const parsed = parseDosInteractionId(interactionId);
  if (!parsed) return undefined;
  if (!ctx.chatJid || !ctx.senderJid)
    return "This screen is no longer available in this chat.";
  const draft = getDosSession(
    ctx.workspaceId,
    ctx.sessionId,
    ctx.chatJid,
    parsed.token,
  );
  if (!draft || draft.committed)
    return "This screen expired or was already closed.";
  if (!dosIdentitiesMatch(ctx.senderJid, draft.initiatorJid))
    return "Unauthorized — only the user who opened this screen may change it.";

  const verb = parsed.action;
  const token = draft.token;

  if (verb === "prev") {
    const page = Math.max(0, draft.page - 1);
    return replyForDraft(updateDosSession(draft, { page }));
  }
  if (verb === "next") {
    return replyForDraft(updateDosSession(draft, { page: draft.page + 1 }));
  }
  if (verb === "back") {
    const stack = draft.stack.slice();
    stack.pop();
    if (!stack.length) return undefined;
    const screen = stack[stack.length - 1] ?? "drawer";
    const next = updateDosSession(draft, { stack, screen, page: 0 });
    return replyForDraft(next);
  }
  if (verb === "home") {
    const next = updateDosSession(draft, {
      stack: ["drawer"],
      screen: "drawer",
      page: 0,
    });
    return replyForDraft(next);
  }
  if (verb === "done") {
    const summary = commitScreen(draft);
    const next = updateDosSession(draft, {
      stack: [...draft.stack, "result"],
      screen: "result",
      page: 0,
      values: {
        "result.title": "✓ PAPPY OS · SAVED",
        "result.body": summary,
      },
    });
    return replyForDraft(next);
  }

  // Row verbs: x<idx> toggle, c<idx> cycle, d/u<idx> stepper, o<idx> open tile.
  const rowVerb = /^([xcduo])(\d+)$/u.exec(verb);
  if (!rowVerb) return undefined;
  const op = rowVerb[1];
  const index = Number(rowVerb[2]);
  const screen = resolveScreen(draft);
  const rendered = renderDosPage({
    token,
    appId: draft.appId,
    screen: draft.screen,
    title: screen.title,
    rows: screen.rows,
    page: draft.page,
    maxButtons: DOS_MAX_BUTTONS,
    showDone: screen.showDone,
    showBack: screen.showBack,
    ...(screen.showHome !== undefined ? { showHome: screen.showHome } : {}),
  });
  const row = rendered.pageRows[index];
  if (!row) return undefined;

  if (op === "o") {
    const target = (row as { id?: string }).id ?? "";
    // Tiles may open any screen under a registered app (anti:…, demo:…).
    const allowedPrefix = `^(?:${[...apps.keys()].join("|")}):`;
    if (!target || !new RegExp(allowedPrefix, "u").test(target)) return undefined;
    const moduleMatch = /^anti:module:(.+)$/u.exec(target);
    if (moduleMatch) {
      const key = moduleMatch[1] as AntiModuleKey;
      const config = loadGroupAntiConfig(draft.workspaceId, draft.sessionId, draft.chatJid);
      const seeded = seedModuleValues(draft, key, config);
      return replyForDraft(
        updateDosSession(draft, {
          screen: target,
          stack: [...draft.stack, target],
          page: 0,
          values: seeded,
        }),
      );
    }
    // anti:home / anti:group:<id> / demo:home need no seeding; live state is
    // read per render.
    return replyForDraft(
      updateDosSession(draft, {
        screen: target,
        stack: [...draft.stack, target],
        page: 0,
      }),
    );
  }

  if (op === "x") {
    if (row.kind !== "toggle") return undefined;
    const next = updateDosSession(draft, {
      values: { [row.id]: !row.value },
    });
    return replyForDraft(next);
  }
  if (op === "c") {
    if (row.kind !== "cycle") return undefined;
    if (row.options.length === 0) return undefined;
    const nextIndex = (row.index + 1) % row.options.length;
    const nextOption = row.options[nextIndex] ?? row.options[0] ?? "";
    return replyForDraft(
      updateDosSession(draft, {
        values: { [row.id]: nextOption },
      }),
    );
  }
  if (op === "u" || op === "d") {
    if (row.kind !== "stepper") return undefined;
    const delta = op === "u" ? 1 : -1;
    const raw = Number(draft.values[row.id] ?? row.value);
    const value = Math.max(row.min, Math.min(row.max, raw + delta));
    return replyForDraft(updateDosSession(draft, { values: { [row.id]: value } }));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Legacy HTML-primitive mode (slot-machine container). The `.ic` beacon path
// remains available for clients that explicitly use the deep-link HTML demo;
// official `.os` interactions use only the native-flow response above.
// ---------------------------------------------------------------------------
function botDigits(workspaceId: string, sessionId: string): string {
  try {
    const session = getSession(workspaceId, sessionId);
    return (session.phoneNumber ?? "").replace(/\D/gu, "");
  } catch {
    return ""; // Session registry lookup can fail only in degenerate states.
  }
}

function drawerRows(): DosRow[] {
  return [...apps.values()].map((app) => ({
    kind: "tile" as const,
    id: `${app.id}:home`,
    label: app.label,
    ...(app.badge ? { badge: app.badge } : {}),
  }));
}

/**
 * Open a fresh legacy HTML drawer for `.ic` dead-ends. The official `.os`
 * command uses the native-only drawer above. `note`, when given, is rendered
 * as a trailing info line in the HTML/text compatibility response.
 */
export function openDosHtmlDrawerWithNote(
  ctx: CommandContext,
  note?: string,
): WhatsAppCommandReply | string {
  if (!ctx.chatJid || !ctx.senderJid)
    return note ?? "Digital OS needs a WhatsApp chat with a verified sender.";
  const draft = createDosSession({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    chatJid: ctx.chatJid,
    initiatorJid: ctx.senderJid,
    appId: "os",
    screen: "drawer",
  });
  const extraRows: DosRow[] = note
    ? [{ kind: "info", text: note }]
    : [];
  return replyForDraft(draft, extraRows, true);
}

export function openDosHtmlDrawer(ctx: CommandContext): WhatsAppCommandReply | string {
  return openDosHtmlDrawerWithNote(ctx);
}

function findRowById(draft: DosDraft, rowId: string): DosRow | undefined {
  const screen = resolveScreen(draft);
  return screen.rows.find((row) => "id" in row && row.id === rowId);
}

export function handleDosHtmlBeacon(
  ctx: CommandContext,
  argv: string[],
): WhatsAppCommandReply | string {
  // Every dead-end re-opens a fresh, professional drawer inside the HTML
  // container (with a one-line note) — taps never land on raw helper text.
  const resetDrawer = (note: string): WhatsAppCommandReply | string =>
    openDosHtmlDrawerWithNote(ctx, note);

  const token = argv[0] ?? "";
  const op = (argv[1] ?? "").toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(token) || !op)
    return resetDrawer(
      "Welcome to PAPPY OS — tap an app below. Tip: OS Demo walks the full live matrix.",
    );
  if (!ctx.senderJid) return "Could not verify the sender of this beacon.";
  const draft = getDosSessionByToken(ctx.workspaceId, ctx.sessionId, token);
  if (!draft || draft.committed)
    return resetDrawer("That screen ended — here is a fresh OS.");
  if (!dosIdentitiesMatch(ctx.senderJid, draft.initiatorJid))
    return "Unauthorized — only the user who opened this screen may change it.";

  if (op === "next") {
    return replyForDraft(updateDosSession(draft, { page: draft.page + 1 }));
  }
  if (op === "prev") {
    return replyForDraft(updateDosSession(draft, { page: Math.max(0, draft.page - 1) }));
  }
  if (op === "back") {
    const stack = draft.stack.slice();
    stack.pop();
    if (!stack.length) return resetDrawer("You are at the home screen.");
    return replyForDraft(
      updateDosSession(draft, { stack, screen: stack[stack.length - 1] ?? "drawer", page: 0 }),
      [],
      true,
    );
  }
  if (op === "done") {
    const summary = commitScreen(draft);
    commitDosSession(draft);
    return summary;
  }
  if (op === "open") {
    const target = argv[2] ?? "";
    if (!target || !/^(?:anti|demo):/u.test(target))
      return resetDrawer("Pick an app from the drawer below.");
    const next = updateDosSession(draft, {
      screen: target,
      stack: [...draft.stack, target],
      page: 0,
    });
    if (target.startsWith("anti:module:")) {
      const key = target.replace(/^anti:module:/u, "") as AntiModuleKey;
      const config = loadGroupAntiConfig(draft.workspaceId, draft.sessionId, draft.chatJid);
      return replyForDraft(
        updateDosSession(next, { values: seedModuleValues(next, key, config) }),
      );
    }
    return replyForDraft(next, [], true);
  }

  const rowId = argv[2] ?? "";
  const valueArg = argv[3] ?? "";
  const row = findRowById(draft, rowId);
  if (!row) return resetDrawer("That control changed — reopen it from the matrix below.");

  if (op === "toggle") {
    if (row.kind !== "toggle") return resetDrawer("Not a toggle — use the matrix below.");
    const on = valueArg === "1";
    updateDosSession(draft, { values: { [row.id]: on } });
    return `✓ ${row.label} ${on ? "on" : "off"}`;
  }
  if (op === "cycle") {
    if (row.kind !== "cycle") return resetDrawer("Not an action control — use the matrix below.");
    if (!row.options.includes(valueArg as never)) return resetDrawer("Invalid action — reopen the screen below.");
    updateDosSession(draft, { values: { [row.id]: valueArg } });
    return `✓ ${row.label}: ${valueArg}`;
  }
  if (op === "step") {
    if (row.kind !== "stepper") return resetDrawer("Not a stepper — use the matrix below.");
    const dir = Number(valueArg);
    if (!Number.isFinite(dir) || (dir !== 1 && dir !== -1)) return resetDrawer("Invalid step — reopen the screen below.");
    const raw = Number(draft.values[row.id] ?? row.value);
    const value = Math.max(row.min, Math.min(row.max, raw + dir));
    updateDosSession(draft, { values: { [row.id]: value } });
    return `✓ ${row.label}: ${value}`;
  }
  return resetDrawer(`Unknown action "${op}" — the drawer is below.`);
}

// Exposed for the router guard (same pattern as digital confirm).
export { isDosInteractionId, peekDosToken, getDosSessionByToken } from "./session.js";
export { getDosSession } from "./session.js";
export { renderDosPage, auditDosLayout } from "./builder.js";
export type { DosButton, DosRow } from "./builder.js";
export { DEFAULT_MAX_BUTTONS as DOS_DEFAULT_MAX_BUTTONS } from "./builder.js";
