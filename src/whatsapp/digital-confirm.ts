/**
 * Digital Confirm — user-scoped native-flow confirmation prompts (Phase 3).
 *
 * A command that needs a Yes/No decision returns a reply carrying
 * `digitalConfirm`. The WhatsApp delivery layer renders it through
 * `renderDigitalConfirmReply` based on the workspace responseType:
 *
 *   - "rich"        → native-flow buttons (✅ Confirm / ✖ Cancel). Tapping one
 *                     delivers an interactiveResponseMessage whose callback id
 *                     (`dc:confirm:<token>` / `dc:cancel:<token>`) routes back
 *                     into `resolveDigitalConfirmTap` → registered action.
 *   - "traditional" → plain-text prompt with a typed answer command
 *                     (`<prefix>dc <token> yes|no`) as the fallback surface.
 *
 * Group safety: every prompt records the initiating user's JID in the pending
 * store. The button/typed answer is one-shot and expires (default 10 min);
 * anyone else tapping a still-valid prompt receives an "Unauthorized" reply
 * instead of executing the action.
 *
 * Token ids intentionally contain only [a-z0-9-] (after the `dc:` prefix) so
 * the interaction id stays routable and lightweight on the wire; the full binding
 * (initiator JID, action, chat, payload, expiry) lives server-side keyed by
 * workspace + session + chat + token.
 */
import { createHash, randomBytes } from "node:crypto";

export type DigitalConfirmDefinition = {
  /** Machine action name; registered via registerDigitalConfirmAction. */
  action: string;
  /** Question shown above the buttons / in the plain-text prompt. */
  promptText: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Optional data handed to the action handler. */
  payload?: Record<string, unknown>;
};

export interface DigitalConfirmReplyShape {
  digitalConfirm: DigitalConfirmDefinition;
}

export type DigitalConfirmActionHandler = (
  payload: Record<string, unknown> | undefined,
) => Promise<string> | string;

export type DigitalConfirmOutcome =
  | { status: "ok"; reply: string }
  | { status: "unauthorized"; reply: string }
  | { status: "expired"; reply: string }
  | { status: "not-found"; reply: string }
  | { status: "wrong-chat"; reply: string };

interface PendingConfirm {
  token: string;
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  initiatorJid: string;
  action: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  answered: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const actionHandlers = new Map<string, DigitalConfirmActionHandler>();
const pending = new Map<string, PendingConfirm>();

const KEY_SEPARATOR = "\u0000";
function pendingKey(workspaceId: string, sessionId: string, chatJid: string, token: string): string {
  return [workspaceId, sessionId, chatJid, token].join(KEY_SEPARATOR);
}

function normalizeIdentity(value: string): string {
  const local = value.trim().toLowerCase().split("@")[0] ?? "";
  return local.split(":")[0] ?? "";
}
function identitiesMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || normalizeIdentity(left) === normalizeIdentity(right);
}

/** Strip a definition action down to a routable [a-z0-9-] token fragment. */
function sanitizeAction(action: string): string {
  const cleaned = action.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (cleaned || "confirm").slice(0, 24);
}

/** One-shot random token; charset [a-z0-9-] and <= ~40 chars. */
function createToken(action: string, initiatorJid: string): string {
  const actionPart = sanitizeAction(action);
  const jidHash = createHash("sha1")
    .update(normalizeIdentity(initiatorJid))
    .digest("hex")
    .slice(0, 8);
  const timePart = Date.now().toString(36);
  const randomPart = randomBytes(4).toString("hex");
  return `${actionPart}${jidHash}${timePart}${randomPart}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
}

export function registerDigitalConfirmAction(
  action: string,
  handler: DigitalConfirmActionHandler,
): void {
  actionHandlers.set(sanitizeAction(action), handler);
}

export function unregisterDigitalConfirmAction(action: string): void {
  actionHandlers.delete(sanitizeAction(action));
}

export function digitalConfirmActionCount(): number {
  return actionHandlers.size;
}

export function pendingDigitalConfirmCount(): number {
  sweepExpired(Date.now());
  return pending.size;
}

export function resetDigitalConfirmState(): void {
  actionHandlers.clear();
  pending.clear();
}

function registerPending(entry: Omit<PendingConfirm, "token"> & { token: string }): PendingConfirm {
  sweepExpired(Date.now());
  pending.set(pendingKey(entry.workspaceId, entry.sessionId, entry.chatJid, entry.token), entry);
  return entry;
}

function lookupPending(
  workspaceId: string,
  sessionId: string,
  chatJid: string,
  token: string,
): PendingConfirm | undefined {
  sweepExpired(Date.now());
  return pending.get(pendingKey(workspaceId, sessionId, chatJid, token));
}

/** True when the interaction id is one of ours (used for the unauthorized tap guard). */
export function isDigitalConfirmInteractionId(value: string): boolean {
  return /^dc:(confirm|cancel):[a-z0-9-]+$/iu.test(value.trim());
}

export function parseDigitalConfirmInteractionId(value: string): {
  decision: "confirm" | "cancel";
  token: string;
} | undefined {
  const match = /^dc:(confirm|cancel):([a-z0-9-]+)$/iu.exec(value.trim());
  if (!match) return undefined;
  return {
    decision: (match[1]?.toLowerCase() as "confirm" | "cancel") ?? "confirm",
    token: match[2] ?? "",
  };
}

export interface DigitalConfirmRenderInput {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  initiatorJid: string;
  definition: DigitalConfirmDefinition;
  responseType: "rich" | "traditional";
  /** Session prefix, used by the traditional typed-answer instructions. */
  prefix?: string;
}

export interface DigitalConfirmRenderResult {
  /** Content object ready for sendTrackedMessage (rich: text + nativeFlow; traditional: text). */
  content: {
    text: string;
    nativeFlow?: Array<{ text: string; id: string }>;
  };
  token: string;
}

export function renderDigitalConfirmReply(
  input: DigitalConfirmRenderInput,
): DigitalConfirmRenderResult {
  const token = createToken(input.definition.action, input.initiatorJid);
  const now = Date.now();
  const entry: PendingConfirm = {
    token,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    chatJid: input.chatJid,
    initiatorJid: input.initiatorJid,
    action: sanitizeAction(input.definition.action),
    ...(input.definition.payload ? { payload: input.definition.payload } : {}),
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
    answered: false,
  };
  registerPending(entry);

  if (input.responseType === "rich") {
    return {
      token,
      content: {
        text: input.definition.promptText,
        nativeFlow: [
          { text: input.definition.confirmLabel ?? "✅ Confirm", id: `dc:confirm:${token}` },
          { text: input.definition.cancelLabel ?? "✖ Cancel", id: `dc:cancel:${token}` },
        ],
      },
    };
  }
  const prefix = input.prefix ?? ".";
  return {
    token,
    content: {
      text: [
        input.definition.promptText,
        "",
        `Reply to confirm: ${prefix}dc ${token} yes`,
        `Reply to cancel:  ${prefix}dc ${token} no`,
      ].join("\n"),
    },
  };
}

async function resolveFromEntry(
  entry: PendingConfirm,
  decision: "confirm" | "cancel",
): Promise<DigitalConfirmOutcome> {
  if (entry.answered) {
    return {
      status: "expired",
      reply: "This confirmation was already answered.",
    };
  }
  entry.answered = true;
  if (decision === "cancel") {
    return { status: "ok", reply: "✅ Cancelled. No action was taken." };
  }
  const handler = actionHandlers.get(entry.action);
  if (!handler) {
    return {
      status: "ok",
      reply: `Confirmed. (No action handler is registered for "${entry.action}".)`,
    };
  }
  try {
    const reply = await handler(entry.payload);
    return { status: "ok", reply };
  } catch (error) {
    return {
      status: "ok",
      reply: `The action could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function authorizeEntry(
  entry: PendingConfirm | undefined,
  input: { workspaceId: string; sessionId: string; chatJid?: string; token: string; senderJid: string },
): DigitalConfirmOutcome | undefined {
  if (!entry) {
    return {
      status: "not-found",
      reply: "This confirmation expired, was already answered, or belongs to another chat.",
    };
  }
  if (input.chatJid && entry.chatJid !== input.chatJid) {
    return { status: "wrong-chat", reply: "This confirmation belongs to another chat." };
  }
  if (!identitiesMatch(input.senderJid, entry.initiatorJid)) {
    return {
      status: "unauthorized",
      reply: "Unauthorized — only the user who requested this confirmation may answer it.",
    };
  }
  return undefined;
}

/**
 * Consume a button tap / typed answer and run the registered action.
 * Single-use + expiry + initiator-identity enforced here.
 */
export async function resolveDigitalConfirmTap(input: {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  token: string;
  decision: "confirm" | "cancel";
  senderJid: string;
}): Promise<DigitalConfirmOutcome> {
  const entry = lookupPending(
    input.workspaceId,
    input.sessionId,
    input.chatJid,
    input.token,
  );
  const denied = authorizeEntry(entry, input);
  if (denied || !entry) return denied ?? { status: "not-found", reply: "Not found." };
  return resolveFromEntry(entry, input.decision);
}

/**
 * HTML-beacon variant: the `.cc` deep link arrives from the user's DM, so the
 * chat of the tap differs from the chat the prompt was shown in. The token is
 * the identity — resolve it workspace+session-wide, then run the action.
 */
export async function resolveDigitalConfirmByToken(input: {
  workspaceId: string;
  sessionId: string;
  token: string;
  decision: "confirm" | "cancel";
  senderJid: string;
}): Promise<DigitalConfirmOutcome> {
  sweepExpired(Date.now());
  const prefix = `${input.workspaceId}${KEY_SEPARATOR}${input.sessionId}${KEY_SEPARATOR}`;
  const suffix = `${KEY_SEPARATOR}${input.token}`;
  let entry: PendingConfirm | undefined;
  for (const [key, candidate] of pending) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      entry = candidate;
      break;
    }
  }
  const denied = authorizeEntry(entry, input);
  if (denied || !entry) return denied ?? { status: "not-found", reply: "Not found." };
  return resolveFromEntry(entry, input.decision);
}

/** Peek (no consume) — used to answer unauthorized taps with a specific notice. */
export function peekDigitalConfirmTap(input: {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  token: string;
}): { valid: boolean; expiresAt: number } {
  const entry = lookupPending(
    input.workspaceId,
    input.sessionId,
    input.chatJid,
    input.token,
  );
  if (!entry || entry.answered) return { valid: false, expiresAt: 0 };
  return { valid: true, expiresAt: entry.expiresAt };
}

/** Test helper: set a pending entry's expiry to force TTL behavior deterministically. */
export function _expireDigitalConfirmToken(input: {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  token: string;
}): void {
  const entry = pending.get(
    pendingKey(input.workspaceId, input.sessionId, input.chatJid, input.token),
  );
  if (entry) entry.expiresAt = Date.now() - 1;
}

// ---------------------------------------------------------------------------
// HTML-primitive confirm/cancel (slot-machine container). Screen A shows the
// prompt + Confirm/Cancel; a tap morphs the SAME bubble locally to
// "Confirmed"/"Cancelled" (JS) and fires the `.cc` wa.me beacon so the
// backend executes the registered action exactly once.
// ---------------------------------------------------------------------------
export interface DigitalConfirmHtmlResult {
  html: string;
  token: string;
}

/**
 * Pure HTML card for a pending confirm token. The pending entry must already
 * exist under `token` (renderDigitalConfirmReply registers it) so the card and
 * the native deck answer the SAME one-shot confirmation: the card's `.cc`
 * beacon and the deck's `dc:confirm/cancel:<token>` buttons share one token.
 */
export function renderDigitalConfirmCardForToken(input: {
  definition: DigitalConfirmDefinition;
  botNumber: string;
  token: string;
}): string {
  const prompt = String(input.definition.promptText ?? "").replace(/[\n\r]+/gu, " ");
  const yes = input.definition.confirmLabel ?? "Confirm";
  const no = input.definition.cancelLabel ?? "Cancel";
  const beacon = (decision: string): string =>
    `https://wa.me/${encodeURIComponent(input.botNumber)}?text=${encodeURIComponent(`.cc ${input.token} ${decision}`)}`;
  const escape = (value: string): string =>
    value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

  const html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:transparent;font:14px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;color:#111}
.card{background:linear-gradient(165deg,#0f172a,#1e293b 60%,#0b1120);border-radius:20px;padding:16px 14px;box-shadow:0 0 0 2px #334155,0 12px 26px rgba(0,0,0,.35)}
.p{color:#f1f5f9;font-weight:700;font-size:15px;line-height:1.35}
.sub{color:#94a3b8;font-size:11px;margin-top:5px}
.btns{display:flex;gap:8px;margin-top:14px}
.btns a{flex:1;display:block;text-align:center;text-decoration:none;border-radius:13px;padding:12px 6px;font-weight:800;font-size:14px}
.y{background:#22c55e;color:#052e16;border:1px solid #4ade80}
.n{background:#ef4444;color:#fff;border:1px solid #f87171}
.state{display:none;text-align:center;padding:10px 4px 4px;font-weight:800;font-size:17px}
.state.show{display:block}
.state.yes{color:#4ade80}.state.no{color:#f87171}
.done .btns{display:none}
.done .card{border-color:#4ade80}
</style></head><body><div class="card" id="c"><div class="p">${escape(prompt)}</div><div class="sub">PAPPY OS · CONFIRM</div><div class="btns" id="b"><a class="y" data-d="yes" href="${beacon("yes")}">${escape(yes)}</a><a class="n" data-d="no" href="${beacon("no")}">${escape(no)}</a></div><div class="state yes" id="sYes">✅ Confirmed</div><div class="state no" id="sNo">✖ Cancelled</div></div><script>
(function(){var c=document.getElementById('c'),b=document.getElementById('b'),ys=document.getElementById('sYes'),ns=document.getElementById('sNo');
c.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-d]');if(!a)return;var d=a.getAttribute('data-d');if(d==='yes')ys.className='state yes show';else ns.className='state no show';c.className='card done';if(b)b.parentNode.removeChild(b);});})();
</script></body></html>`;

  return html;
}

/**
 * HTML-primitive confirm/cancel (slot-machine container) with full ownership:
 * registers a fresh pending entry and returns the card HTML for that token.
 * The delivery layer pairs this card with the native deck via
 * renderDigitalConfirmReply + renderDigitalConfirmCardForToken when it needs
 * one shared token across both channels.
 */
export function renderDigitalConfirmHtml(input: {
  workspaceId: string;
  sessionId: string;
  chatJid: string;
  initiatorJid: string;
  definition: DigitalConfirmDefinition;
  botNumber: string;
}): DigitalConfirmHtmlResult {
  const token = createToken(input.definition.action, input.initiatorJid);
  const now = Date.now();
  const entry: PendingConfirm = {
    token,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    chatJid: input.chatJid,
    initiatorJid: input.initiatorJid,
    action: sanitizeAction(input.definition.action),
    ...(input.definition.payload ? { payload: input.definition.payload } : {}),
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
    answered: false,
  };
  registerPending(entry);
  return {
    token,
    html: renderDigitalConfirmCardForToken({
      definition: input.definition,
      botNumber: input.botNumber,
      token,
    }),
  };
}
