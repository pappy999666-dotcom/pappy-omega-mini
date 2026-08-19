# Pappy Omega Mini Audit Matrix — Preview, Bridge, Command State

## Audit scope

The audit used the attached master prompt, the current Pappy source tree, the copied Omega-v1 reference modules, and the static callback contract output in `callback_contract_audit.txt`. No source implementation was changed until this matrix was written.

## Requirement matrix

| Feature | Current Pappy finding | Omega-v1/reference behavior | Decision | Repair priority |
|---|---|---|---|---|
| Universal link preview | Canonical resolver supports generic HTTP(S) OpenGraph pages, but URL detection only recognizes explicit `http://`/`https://`; bare domains such as `example.com` are skipped. Preview is also skipped for any media-bearing payload even when its caption contains a URL. | Preview engine resolves ordinary domains and social URLs through metadata and keeps link text/caption behavior separate from Validator Hub’s WhatsApp-only collector. | Keep the existing Baileys-native resolver and cache; add safe bare-domain extraction and allow captions with media to receive previews without replacing media payloads. | P1 |
| Preview security | SSRF protections, redirect limit, private-IP checks, image byte limits, Sharp normalization, canonical invite handling, and Redis coalescing are present. | Reference also uses guarded fetch and canonical cache behavior. | Keep. Add regression coverage for bare domains, punctuation, captions, and media. | Protected |
| Link collector scope | Telegram/WhatsApp link collector intentionally accepts only `chat.whatsapp.com` invites, which matches the attached prompt. | Omega-v1 collector is WhatsApp-only for Validator Hub. | Keep; do not broaden collection to arbitrary domains. | Protected |
| Admin Global Bridge | Admin panel button reaches a single-session inspection/command route. It does not provide the requested true cross-workspace multi-session selection and fan-out operation. | Omega reference has global bridge selection and explicit command-input state, with session-scoped bridge kept separate. | Preserve Pappy’s existing per-session/workspace Bridge; add an Admin cross-workspace selection/fan-out surface without replacing it. | P1 |
| Admin Bridge command input | Existing per-session Admin Bridge path is real, but result edit failures are swallowed and the user receives no fallback if the original message cannot be edited. | Reference uses same-message updates with explicit recovery/back states. | Keep transport execution; add explicit fallback edit/reply reporting and cancellation. | P1 |
| Telegram pending input state | Callback middleware clears pending maps before handlers set the new one, which is correct for button switching. Slash commands bypass pending branches but do not clear pending maps, so an abandoned flow can remain armed and capture a later non-command message. | Omega uses explicit session-bound flow state and cancellation on navigation/commands. | Clear all pending flows when any Telegram slash command arrives; add explicit cancel semantics and tests for stale-state isolation. | P1 |
| Telegram passive intake | A normal non-command message can be treated as passive WhatsApp-link collection when no pending flow is active. A callback sets a one-message suspension flag, which is correct for preventing accidental collection immediately after navigation. | Omega separates UI input modes from background collection and does not let a stale UI flow capture unrelated input. | Keep automatic collection but ensure command/callback transitions clear stale state and that only valid WhatsApp invites are collected. | P1 |
| WhatsApp command privacy | Router requires configured prefix, owner/fromMe/bridge authorization, and returns null for unauthorized or unknown commands. | Omega uses strict platform command catalogs and silent public rejection. | Keep; add tests for non-command text, unknown command, unauthorized sender, and bridge authorization. | Protected/P1 tests |
| WhatsApp command conflict | Router is strict, but pending Telegram bridge flows and broad text input handling can still cause user confusion if old Telegram state survives a new slash command. | Omega command input has explicit unbind/cancel behavior. | Add one active flow per Telegram actor and clear prior flow on every new command/callback. | P1 |
| My Groups | Dedicated route now exists and listGroups returns all groups in one array. This is a scale risk for hundreds/thousands of groups and lacks Telegram pagination. | Omega reference paginates group inventory and includes missing metadata, empty, loading, error, refresh, and group actions. | Preserve live group operations; add bounded pagination and safe metadata rendering. | P2/P1 scale |
| Validator Hub | Stable dashboard/live-log split exists after latest repair; bucket views and downloads exist. Need compare every callback and clarify auto-validation versus manual compatibility controls. | Omega separates stable dashboard and optional live monitor; validation is permanent background capability; bucket view is paginated. | Keep current bucket store and native rendering; remove misleading manual/toggle semantics where appropriate and add missing pagination/state coverage. | P2 |
| Join Manager | Active-link selection now uses workspace Active inventory and selected-session socket, but the attached prompt additionally requires dynamic randomized traversal, durable per-link claims, rich state taxonomy, and no silent loss. | Omega uses durable claim leases, randomized/dynamic active selection, retry/release/fence, and explicit outcomes. | Next P1 backend increment after current reported blockers: add randomized bounded claim order, explicit terminal taxonomy, human-readable progress, and durable claim recovery. | P1 next |

## Callback/flow inventory

The static audit enumerated current callback namespaces for dashboard, sessions, nested session sections, My Groups, group actions, PFP, Sudo, Bridge, Validator Hub, Join Manager, jobs, schedules, support, Admin, Force Join, and moderation. Every dynamic namespace must be tested against its registered `bot.action` handler; dynamic strings alone are not proof of behavior.

The high-risk state machine has 18 pending maps, a shared `clearPendingInputs()` function, and a `passiveIntakeSuspended` set. The repair must treat these as one mutually exclusive input-state machine rather than independent listeners.

## Implementation order

1. Repair universal preview eligibility for explicit and bare domains while preserving WhatsApp-only Validator collection and media transport.
2. Implement true Admin Global Bridge multi-session selection/fan-out with bounded, auditable execution, keeping existing user/session Bridge untouched.
3. Make Telegram command/callback navigation cancel all stale pending inputs, add fallback responses for edit failures, and test strict WhatsApp command silence.
4. Re-run the static callback audit, build, focused tests, full suite, and a second missing-functionality comparison against Omega-v1 before deployment.

## Absolute no-regression constraints

The existing Session Bridge remains authoritative. The WhatsApp-only Validator collector remains restricted to `chat.whatsapp.com` invite links. Unauthorized/public WhatsApp messages remain silent. No feature is considered complete if its callback only renders a button without real backend behavior.
