# Pappy Omega Mini — Remaining Master Prompt Requirements Review

**Review baseline:** repository commit `e63d5c2`, latest local validation, and live VPS verification on 19 August 2026.

## Current release state

Pappy Omega Mini is live and healthy on the designated VPS. The Pappy process is online with zero unstable restarts. `omega-core` and `omega-test` are also online with zero unstable restarts and were not restarted during the review. The repository is synchronized at commit `e63d5c2`.

The current release now includes the compact Telegram group `/start` menu, group-aware Moderator Controls routing, inline protection toggles, same-message moderator dashboard updates, destructive confirmation dialogs for `/ban` and `/resetwarn`, one-shot confirmation tokens, and temporary-response cleanup scheduling. The implementation remains an incremental release; the full second Master Prompt is not yet complete.

## WhatsApp stability requirements

| ID | Requirement | Current status | What remains |
|---|---|---|---|
| A1 | Authoritative lifecycle states | Partial | Replace mixed transport/domain vocabulary with one persisted lifecycle state machine covering pairing, authenticated, online, reconnecting, degraded, logged-out, restricted, failed, and purged states |
| A2 | One supervisor/socket owner and zombie prevention | Partial | Add generation proof, listener-count assertions, and stronger state authority around reconnect ownership |
| A3 | Encrypted credentials and registered-auth verification | Partial / improved | Keep the current encrypted store and `registered === true` gate; add restart/logout acceptance proof and migration checks |
| A4 | Full inbound-to-reply trace | Partial | Persist structured message trace records containing message ID, normalization, authorization, parser result, handler, enqueue/send outcome, and failure reason |
| A5 | JID/LID/participant identity resolution | Partial | Complete live end-to-end tests for owner, sudo, self-message, participant alternative IDs, and unauthorized silence |
| A6 | Prefix, quoted, media, caption, URL, group, and DM parsing | Partial | Finish reusable quoted/media resolver and test document, image, video, audio, captions, and URL extraction |
| A7 | Clean authenticated notification | Partial | Prove one notification after authenticated open and no duplicate reconnect/pairing notices |
| A8 | Composite truthful health | Partial | Combine socket, heartbeat, inbound/outbound activity, auth, worker state, and last error into one owner-facing health view |
| A9 | Safe purge and cleanup | Partial | Formalize terminal-state contract and prove locks, listeners, workers, and persistence cleanup after logout or definitive failure |
| A10 | Owner-only diagnostics | Partial | Add the Telegram diagnostic view for lifecycle, trace, auth, reconnect, restore, and restart events with redaction |

**WhatsApp priority:** This remains the first technical priority because the Master Prompt places transport stability before moderator expansion. The most valuable next increment is structured message tracing plus composite health and lifecycle-state reconciliation, followed by live acceptance tests using a controlled paired account.

## Telegram moderator requirements

| ID | Requirement | Current status | What remains |
|---|---|---|---|
| B1 | Group registration and Quick Protect/Custom Setup | Partial | Group `/start` and group registration now exist; add a guided Quick Protect/Custom Setup wizard with permission checks and same-message Save/Cancel behavior |
| B2 | Protected grouped moderator UX and command scopes | Partial / improved | Group `/start` now shows member/moderator views; Moderator Controls are administrator-gated; continue converting settings pages to grouped inline flows |
| B3 | Durable group settings and lock state | Partial | Settings, rules, greetings, filters, staff, and whitelist are durable; durable mute/lock state and expiry fields are still missing |
| B4 | Unified DETECT → CLASSIFY → EXEMPTION → RECORD → ACTION → EXECUTE → NOTIFY → CLEANUP engine | Partial | Refactor direct command and automatic middleware paths into one idempotent action engine with correlation IDs and structured outcomes |
| B5 | Warnings and escalation | Partial | Warning commands and durable records exist; add policy-driven escalation, dashboard counts, and confirmation/cleanup for clear/reset workflows, with `/resetwarn` now protected |
| B6 | User/group mute with expiry | Partial | User Telegram `until_date` exists; group-wide mute still requires explicit unmute and needs durable expiry plus restart reconciliation |
| B7 | Staff, trusted users, whitelist, Telegram limits | Partial | Staff and whitelist exist; add a separate trusted-user model/UX and verify every automatic rule honors all exemptions without granting configuration access unintentionally |
| B8 | Protected moderation modules | Partial | Anti-link, anti-spam, filters, rules, logs, welcome, and goodbye exist; route them through the unified action engine and finish guided UI flows |
| B9 | Permission-aware suggestions | Partial / improved | Administrator command scope is trimmed so configuration toggles are not advertised; complete per-group dynamic suggestions and confirm Telegram command-scope refresh behavior |
| B10 | Welcome/goodbye templates, media, cleanup | Partial | Text mentions work; add real media delivery, template validation, cleanup jobs, and failure-safe logging |
| B11 | Rules state machine and editable templates | Partial | Rules display/edit exists; add draft, preview, publish, cancel, validation, and restart-persistent state transitions |
| B12 | Controlled tag-all | Missing | Add preview/confirm, deduplicated eligible members, bot/admin/staff/whitelist exclusions, bounded batches, progress, cancellation, rate limits, and durable job state |
| B13 | Anti-link and obfuscated-link detection | Partial | Common URL/invite detection works; add obfuscated and link-like text fixtures while keeping false positives bounded |
| B14 | Redis sliding-window anti-spam | Partial | Ten-second Redis window and TTL exist; route the resulting mute/delete action through the unified engine and test TTL/restart behavior |
| B15 | Raid/join-flood protection | Missing | Add join-event counters, thresholds, temporary lockdown, recovery, exemptions, deduplication, and durable event records |
| B16 | Admin-only moderation logs | Partial / improved | Durable success/failure logs exist and are accessible from the dashboard; add pagination, correlation IDs, automatic-action details, and redaction checks |
| B17 | Exemptions and bot self-protection | Partial | Admin/staff/whitelist exemptions exist; add explicit bot self-protection and consistent trusted-user enforcement across every automatic action |
| B18 | Moderator dashboard | Partial / recently improved | Grouped dashboard, live counts, toggles, rules/filters/warnings/log views, same-message editing, and group-start entry now exist; add real lock/raid state, Quick Protect, Custom Setup, pagination, and live worker counts |

## Important UX corrections now in place

The group `/start` flow is separate from the private workspace dashboard. In a group it shows a compact WhatsApp-bot group menu, with moderator controls only for verified Telegram administrators. Configuration toggles are represented as inline buttons with state labels and same-message updates. Member-targeted actions remain slash commands because they require reply context.

The administrator command suggestions no longer advertise `/antilink` or `/protection`; those settings are available in the moderator control room. The handlers should remain hidden or be removed after compatibility review so the inline dashboard is the authoritative UX. Destructive `/ban` and `/resetwarn` actions now require one-shot confirmation, bind callbacks to actor/group/chat/action/target, and clean up temporary prompts and results.

## Prioritized implementation order

### P0 — Close transport and action-engine foundations

First complete WhatsApp structured tracing, lifecycle authority, composite health, and controlled live acceptance. In parallel, design and implement the unified moderation action contract. Every manual and automatic moderation event should use the same pipeline and event schema before more modules are added.

### P1 — Durable expiry and protection recovery

Add Mongo fields and Redis/BullMQ jobs for group mute expiry, raid lockdown expiry, startup reconciliation, retries, and idempotency. This is required before claiming that group protection is durable or restart-safe.

### P2 — Finish the moderator control room

Implement Quick Protect and Custom Setup as guided same-message flows. Add real lock/raid state, warning totals, event pagination, filters/staff/whitelist navigation, and callback reauthorization. Do not display a control as active until its Telegram API operation and durable state update both succeed.

### P3 — Raid protection and controlled tag-all

Add join-flood detection and bounded lockdown first. Then build tag-all on the existing worker/orchestration model with preview, confirmation, progress, cancellation, deduplication, exclusions, and rate limits.

### P4 — Complete rules, greetings, exemptions, and detection

Finish rules draft/publish state, media greetings and cleanup, trusted-user UX, bot self-protection, and obfuscated-link detection. Add focused tests for group isolation, restart persistence, Telegram permissions, Redis TTLs, and failure recovery.

## Acceptance gates before declaring the Master Prompt complete

| Gate | Required proof |
|---|---|
| WhatsApp | Pairing, authenticated open, one notification, `.ping`, `.menu`, owner/sudo, unauthorized silence, quoted/media parsing, reconnect, restart, logout, purge, listener uniqueness, and no message loss |
| Moderator security | Ordinary-user denial, callback reauthorization, actor/group binding, bot/admin/staff/whitelist/trusted exemptions, and redacted logs |
| Persistence | Group settings, rules states, warning records, mute/lock expiry, raid state, tag-all progress, and restart reconciliation |
| Telegram transport | Real restriction, ban/unban, group permission set/restore, delete, member events, callback edits, and failure reasons |
| UX | Compact group `/start`, private dashboard separation, same-message edits, temporary cleanup, confirmation cancellation, and no misleading command suggestions |
| Deployment | Timestamped backup, additive migration, Pappy-only restart, existing Omega services untouched, PM2 health, and rollback procedure |

## Bottom line

The current system has a functioning SaaS foundation and a substantially improved Telegram moderator UX, but the highest-value unfinished requirements are not cosmetic. The next work should focus on **unified moderation execution, durable expiry/reconciliation, raid lockdown, controlled tag-all, and complete WhatsApp lifecycle observability**. Those foundations should be finished before adding further presentation polish.

— **Manus AI**
