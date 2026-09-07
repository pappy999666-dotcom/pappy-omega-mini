# Digital OS — App Menu & Interactive Configurations (Design)

Status: **ARCHITECTURE PROPOSAL — no implementation yet.** Review before code.
Builds on: native-flow buttons (Option B), `interactiveResponseMessage` pipeline,
and the Phase-3 `digital-confirm` token/session patterns already shipped.

Scope of this doc:
1. Hard constraints learned from the engine (what the UI substrate can and cannot do).
2. Temporary session-state manager design.
3. `DigitalUIBuilder` — reusable paginated/stateful screen factory.
4. Routing & commit wiring.
5. Working "Anti System" screen example on the real `GroupAntiConfig` schema.
6. Phased implementation plan + open questions.

---

## 1. Hard constraints (verified against plogme 1.0.3 + our router)

These shape every design decision and prevent building on false assumptions:

1. **Native-flow buttons cannot morph in place.** A tap delivers an
   `interactiveResponseMessage.nativeFlowResponseMessage` to the bot; the bubble
   itself never changes locally. "Flipping a toggle in the UI" therefore always
   means: bot receives tap → updates draft state → **bot sends a fresh screen**
   (new bubble) with the updated checkboxes. WhatsApp edits are text-only, so the
   old screen cannot be rewritten in place.
   - Mitigation option: the bot may **delete the previous screen bubble** after
     sending its replacement (own-message delete) so the chat shows a single
     evolving container instead of an accumulating pile. Needs a live probe to
     confirm delete reliability for interactive bubbles.
   - The HTML bubble (Option A / slot-machine substrate) is the *only* true
     in-place morph, but it has **no channel back to the bot** — it stays an
     internal dev experiment, never production UX (per our Phase-3 decision).

2. **Buttons per message are limited.** Legacy `buttonsMessage` and native-flow
   `quick_reply` grids each have client-side caps we have not yet measured
   (legacy was ~3; native flow appears more generous but is unverified). The
   builder MUST therefore paginate controls and cap buttons per screen with an
   env-tunable `DOS_MAX_BUTTONS` (default 4) until P0 probing sets the real cap.

3. **The bot surface is private.** Today only the session owner/sudo reaches
   command handlers; group taps by anyone else are silenced. For Digital OS we
   keep that model and additionally bind each open screen to the initiating
   user's JID (reuse the digital-confirm token pattern) so a future multi-user
   deployment already enforces per-user screens.

4. **State lives in one process today.** Memory Map + TTL sweep matches the
   existing `digital-confirm` and `group-control-confirmation` stores. If the
   worker split (PROCESS_ROLE=worker) ships later, session keys must include the
   owning session id and the store must move to Redis — the API below isolates
   that decision behind one adapter (`DosDraftStore`).

---

## 2. Temporary session-state manager

Purpose: track a user's in-flight configuration screen before "Done" commits.

### Key model

```
key = `${workspaceId}:${sessionId}:${chatJid}:${screenToken}`
screenToken = base36(time) + sha1(initiatorJid).slice(0,8) + nonce   // [a-z0-9-]
```

Interaction ids carry only the opaque token: `dos:<screenToken>:<action>`.
The full binding (initiator, app id, draft, page, previous bubble key) lives
server-side — same principle as `dc:` confirm ids.

### Draft record

```ts
interface DosDraft {
  token: string;
  workspaceId: string; sessionId: string; chatJid: string;
  initiatorJid: string;              // JID that opened the screen
  appId: string;                     // "main" | "anti" | "approvals" | ...
  screen: string;                    // current screen path, e.g. "anti/antilink"
  page: number;
  values: Record<string, DosValue>;  // draft toggle/stepper values (uncommitted)
  previousMessageKey?: { id: string; remoteJid: string };  // bubble to delete on re-render
  createdAt: number; expiresAt: number;  // idle TTL ~10 min, swept lazily
  committed: boolean;                // Done consumed the draft
}
type DosValue = boolean | number | string;
```

### API (module `src/whatsapp/digital-os/session.ts`)

```ts
createDosSession(ctx, appId): Promise<{token, screen}>   // registers draft + returns open screen
getDosSession(keyParts): DosDraft | undefined
openScreen(draft, screen): void            // navigation (pagination stays on same token)
applyTap(draft, action): void              // mutate draft.values; bump expiresAt
commitDosSession(draft): Promise<CommitReport>   // runs the app's commit adapter, marks committed
peekDosToken(token, senderJid): "owner" | "other" | "stale"   // for the Unauthorized guard
```

Rules identical to Phase 3:
- one-shot (after Done or expiry the token dies),
- TTL sweep on every access,
- re-render keeps the SAME token until Done (so the container identity is stable).

### Commit adapter interface (isolates where config actually lives)

```ts
interface DosCommitAdapter {
  appId: string;
  load(ctx): Promise<unknown>;          // e.g. loadGroupAntiConfig(ws, sess, group)
  apply(draft: DosDraft, current: unknown): unknown;  // pure: base + deltas
  save(ctx, next): Promise<void>;       // e.g. saveGroupAntiConfig(next)
}
registerDosApp(app: DosApp);            // app = { id, title, homeAdapter, screens }
```

Anti commit = existing `loadGroupAntiConfig` / `saveGroupAntiConfig` — the app
writes exactly what the text commands write today, so both surfaces stay in sync
and nothing existing breaks.

---

## 3. DigitalUIBuilder (reusable factory)

One declarative screen model; renders the compact mobile layout + native-flow
buttons. Any feature becomes a Digital OS screen by declaring a schema — no
hardcoded Anti-specific code in the builder.

### Declarative screen schema

```ts
interface DosScreen {
  appId: string;
  path: string;                 // "anti/antilink"
  title: string;                // "ANTILINK"
  rows: DosRow[];               // control rows rendered inside the text body
}

type DosRow =
  | { kind: "toggle"; id: string; label: string; enabled: boolean }
  | { kind: "action-cycle"; id: string; label: string; options: string[]; index: number }
  | { kind: "stepper";  id: string; label: string; value: number; default: number;
      min: number; max: number; step: number }
  | { kind: "info";     text: string }
  | { kind: "heading";  text: string };

interface DosButton {
  text: string;                 // short, ≤ ~12 chars, tight spacing
  action: string;               // "toggle:antilink-kick" | "cycle:antilink-action" | "step:+/-:antilink-threshold" | "back" | "done" | "next" | "prev"
}
```

### Rendering rules (the "strict mobile" rules become code, not style-guide)

- Single-line control rows, **no `\n\n` anywhere**: rows joined by single `\n`.
- Max ~38 characters per visual line so small phones don't wrap mid-toggle.
- Compact glyphs: `Kick[ ] Warn[✓] Del[✓]` (0-width idea: brackets hug labels).
- Unicode state: `[ ]`/`[✓]`; emoji only for section headers + Done.
- Default-threshold indicator inline: `(d3)` printed when a stepper still equals
  its schema default, so the user sees the factory default vs. their override.
- Example screen body (16 lines max, ~440 chars):
  ```
  📱 PAPPY OS · ANTILINK
  ─────────────────────
  Kick[✓] Warn[✓] Del[ ]
  Warns before kick: 3 (d3)
  Msg on trigger: custom (d0)
  Permits: +234…, +1…  (2)
  ```

### Adaptive pagination

- Buttons are generated from rows; when the count exceeds `DOS_MAX_BUTTONS`
  (default 4; final value from P0 probe), the builder splits rows into pages:
  - footer always `[⏮️ Prev]` / `[Next ⏭️]` only when paging applies,
  - each page is a separate bubble sharing the SAME token; `page` lives in draft.
- `Done ✅` is always present on every config page (never hidden behind paging).

### Bubble-replacement policy (the "one evolving container" feel)

On every tap the bot:
1. `applyTap(draft, action)` → new draft state,
2. renders the updated screen,
3. sends the new bubble,
4. best-effort deletes `draft.previousMessageKey` (own message) so the chat
   shows the container advancing in place; failure to delete is non-fatal.

Policy behind an env toggle: `DOS_REPLACE_BUBBLES=1|0` (default 1 once the P0
delete probe passes; else new-bubble-only).

---

## 4. Routing & events

- New interaction namespace intercepted in `executeCommand` **before** command
  matching, exactly like `game:` / `group-control:` / `dc:`:
  ```
  /^dos:([a-z0-9-]+):(toggle|cycle|step|back|next|prev|done|home):(.+)$/
  → handleDosInteraction(raw, ctx)
  ```
- Owner path: parse token → `getDosSession` → `applyTap` → return a
  `WhatsAppReply` carrying `digitalConfirm`-style screen content OR direct
  `{text, nativeFlow}`; delivery reuses the existing session-manager render
  branch (same code path as Phase 3) — no new transport code.
- Non-owner taps on a **live** token: "Unauthorized — only the user who opened
  this screen may change it." Stale/committed tokens: silence (same as dc).
- `Done` returns the app's commit adapter result → final summary bubble:
  ```
  ✅ ANTLINK SAVED
  Kick ON · Warn ON · Delete OFF
  Warns before kick: 3
  ```
  and the token is consumed.

### Home screen (app drawer) + pagination
- `main` app schema lists category tiles; each tile opens an app screen
  (`back` returns to main under the same token).
- App drawer pages when tiles exceed `DOS_MAX_BUTTONS`.

### Wrapping arbitrary commands
Any legacy command output is wrapped by giving it a thin `DosApp`:
`{ id, title, screens: buildScreensFromCommandOutput(reply) }` — the builder only
needs `{title, rows, buttons}`, so stats/approval lists become native screens
with a `Done ✅` that resolves to the original action. Legacy prefix commands
remain fully functional alongside (no removal).

---

## 5. Working example — Anti System (real schema)

Per-group source of truth (existing, unchanged):
`GroupAntiConfig` → modules keyed by `AntiModuleKey`
(`antilink`, `antispam`, …) each `{ enabled, action: kick|warn|delete,
warnThreshold (default 3), permitList, capability }`.

Screens (declarative — builder is generic):
1. `anti/home` — one tile per supported module; unavailable modules render grey
   with reason, not buttons.
2. `anti/<module>` (e.g. `anti/antilink`) — draft = clone of current module:
   - `toggle` row per action: `Kick`, `Warn`, `Delete` (schema action-cycle so
     exactly one can be active — tap moves the `✓`),
   - `stepper` row `Warn before kick: 3 (d3)` with `−`/`+` buttons (only when
     action=warn),
   - `Done ✅` → `apply()` on the module clone → `saveGroupAntiConfig` →
     summary bubble + token consumed.
   - Row cap exceeded? Action tri-state collapses to ONE `cycle` control +
     toggle rows `Enable`, `Custom msg` → stays under the button cap.

Anti text commands (`.antilink …`) still work; Digital OS is a second writer to
the same store via the same config functions, so state can never diverge.

---

## 6. Phased plan (after review)

- **P0 — live probes (1 small deploy):** measure real native-flow button cap
  (3/4/5/8/10 grid renders + tap) and own-bubble delete reliability on Android
  + iOS + Web. Output: `DOS_MAX_BUTTONS`, `DOS_REPLACE_BUBBLES` default.
- **P1 — state manager** (`digital-os/session.ts` + adapter interface + unit
  tests mirroring `tests/digital-confirm.test.ts`).
- **P2 — builder** (`DigitalUIBuilder`, schema, pagination, compact renderer +
  snapshot tests pinning line width ≤ 38 chars / no double newlines).
- **P3 — Anti app** (home + module screens wired to `GroupAntiConfig`, Dos-app
  registration, `dos:` routing + Unauthorized guard, `.os` command to open the
  drawer; `.setvar`-independent — screen always renders native-flow).
- **P4 — wrapper** for approvals/stats/other outputs; menu entry; docs.

---

## 7. Decisions (confirmed 2026-09-06)

_Numbered sections shifted: §7 decisions, §8 implementation status, §9 P0 probe._

1. **Bubble policy: P0 probe first.** Run live probes (button-cap grid + own-bubble
   delete reliability on Android/iOS/Web) and set `DOS_MAX_BUTTONS` /
   `DOS_REPLACE_BUBBLES` from real results before the full build.
2. **Entry point: separate `.os` command.** Opens the app drawer; `.menu`/
   `.menulist` stay untouched until the OS UI proves itself.
3. **Commit scope: per-group.** Anti screens edit the current group's
   `GroupAntiConfig` through the same `loadGroupAntiConfig`/`saveGroupAntiConfig`
   functions the text commands use — the two surfaces can never diverge.
4. **Interactions: native-flow controls, HTML card decorative (locked after
   live probe).** HTML anchors inside the FOAHtml webview do not navigate on the
   test device, so every OS screen and confirmation is a CARD + DECK pair
   (HTML card for the look, native-flow buttons for control) sharing one token.

## 8. Implementation status (2026-09-06, later)

Built, typechecked (clean), tested (397/397 incl. the Digital OS + confirm
suites), and dist rebuilt — deployed in stages during the session:
- `digital-os/session.ts` — draft store (P1 as designed),
- `digital-os/builder.ts` — DigitalUIBuilder w/ pagination + compact renderer (P2),
- `digital-os/app.ts` — drawer + Anti System home + module editor committing through
  `load/saveGroupAntiConfig` (P3, v1: 8 showcase modules; extra configs like
  antispam limits / words lists remain on text commands),
- `.os` command (aliases `.apps`/`.drawer`), `dos:` interaction intercept +
  Unauthorized guard, menu entries (P3 wiring),
- Button budget default `DOS_MAX_BUTTONS = 4` — the P0 probe result replaces it.

**HTML-primitive mode (the core assignment, later same day):** `.os` now renders
the Digital OS UI as a custom HTML/JS app injected into the exact
`FOAHtmlPrimitiveDemoDONOTUSE` container the slot machine uses
(`html-app.ts`), with local checkbox morphing and `wa.me` deep-link beacons
(`.ic <token> …`) as the backend channel. `.ic` replies render navigation
screens in the DM where the beacon lands and commit `Done` to the group's
`GroupAntiConfig`. Native-flow screens remain available as a documented
fallback.

**Live finding (owner device, 2026-09-06): the FOAHtml webview is read-only on
the test client** — the container renders, but HTML anchors do not navigate, so
no wa.me beacon can ever reach the bot from inside the bubble. Decision locked
(§7, item 4): **CARD + DECK** — every screen is sent as two bubbles: the
polished HTML card (slot-machine container, purely decorative) followed by a
compact native-flow control deck whose buttons (`dos:<token>:<verb>`, or
`dc:confirm/cancel:<token>` for confirmations) drive the whole state machine
through the proven tap→bot channel. The card and the deck share one token and
mirror the same page; if the HTML send ever fails the deck still lands, and the
deck itself falls back to plain text. `.ic`/`.cc` beacon handlers stay for
HTML-capable clients and re-render through the same card+deck replies.

Remaining: deck validation on a device (buttons respond, drawer → Anti System →
module → Done persists; OS Demo matrix pages + Done summarizes); P0 probe
results → constants; bubble-replacement (delete previous screen) after probe
passes; more apps (approvals/stats).

## 9. P0 probe plan (next action)

Implements `.osprobe` (owner-only):
- Sends native-flow quick-reply grids of **3/4/5/6/8/10** buttons in the current
  chat (id `dosprobe:<n>:<k>`), ~1.2 s apart, and logs each sent key.
- Delete probe: sends P0-D1, then P0-D2, then attempts to delete P0-D1 and logs
  the outcome.
- Writes results to a JSONL file under the session data dir and asks the owner
  to reply `.osprobe report ok 4 6 8 10 del` (grids that rendered + tapped, and
  whether the replaced bubble disappeared).
- Outputs feed `DOS_MAX_BUTTONS` and `DOS_REPLACE_BUBBLES` defaults.
