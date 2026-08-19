# Pappy Omega Mini — Advanced Master Prompt Implementation Plan

## 1. Planning baseline

The current deployment is a stable incremental baseline rather than a fully complete implementation of the second Master Prompt. The Telegram moderator surface already has real administrator checks, durable group settings, warnings, mutes, bans, rules, filters, anti-link, anti-spam, welcome/goodbye, whitelist/staff controls, and moderation logs. The remaining work must preserve real Telegram API execution, durable state, strict permission boundaries, explicit failure reporting, and isolation from `omega-core` and `omega-test`.

The authoritative checklist also keeps several WhatsApp stability items partial. The correct order is therefore to close the remaining transport observability and lifecycle gaps that the advanced moderator system depends on, then add the moderator execution engine and protection modules, and only afterward build the richer dashboard and polish.

## 2. Remaining requirements by workstream

| Workstream | Checklist items | Current gap | Priority |
|---|---|---|---|
| WhatsApp lifecycle and diagnostics | A1–A10 | State authority, structured message traces, composite health, reusable media/quoted resolution, and owner diagnostics are incomplete | P0 |
| Unified moderation engine | B4, B8, B16, B17 | Direct command and middleware paths are not yet one durable action pipeline | P0 |
| Durable expiry/reconciliation | B6, B14 | User expiry relies partly on Telegram `until_date`; group-wide mute has no durable expiry/recovery worker | P0 |
| Group setup and dashboard | B1, B2, B5, B9, B18 | No dedicated Quick Protect/Custom Setup flow or live moderator dashboard | P1 |
| Raid/join flood protection | B15 | No join-window counter, temporary lockdown, recovery, or dedicated logs | P1 |
| Controlled tag-all | B12 | No bounded, deduplicated, cancellable mention job with exclusions and progress | P1 |
| Rules and member-experience completion | B7, B10, B11 | Trusted-user UX, rules state machine, media greetings, and cleanup remain incomplete | P2 |
| Detection coverage | B13, B17 | Obfuscated links and explicit bot self-protection/trusted exemptions remain incomplete | P2 |

## 3. Recommended implementation sequence

### Milestone 0 — Freeze and instrument the baseline

Create a release branch or tagged deployment reference from the current production commit. Capture the current PM2 process definitions, environment contract, Mongo indexes, Redis key conventions, and the current audit checklist. Add a migration/version marker for any new Mongo fields before changing schemas. Do not purge healthy WhatsApp authentication and do not restart unrelated services.

The milestone is complete when the current 31 tests remain green, TypeScript builds cleanly, the VPS reports all three services online with zero unstable restarts, and a rollback command is documented and tested against a staging or disposable process target.

### Milestone 1 — Finish the WhatsApp stability contract

First replace mixed lifecycle vocabulary with one authoritative state machine covering `CREATING`, `PAIRING`, `PAIRING_CODE_READY`, `AUTHENTICATED`, `CONNECTING`, `ONLINE`, `RECONNECTING`, `DEGRADED`, `LOGGED_OUT`, `BANNED_OR_RESTRICTED`, `FAILED`, and `PURGED`. Every transition should record a timestamp, reason, socket generation, reconnect attempt, and whether the state is transport-authenticated or merely persisted.

Next add structured redacted message events for the complete inbound path: `messages.upsert`, normalization, authorization, parsing, handler selection, reply enqueue, send result, and failure. Add a reusable resolver for quoted messages, captions, URLs, images, videos, documents, and audio. The composite health view should combine socket state, heartbeat age, inbound age, outbound age, auth validity, worker health, and the last failure rather than relying on the database status alone.

Finish with an owner-only diagnostic view that exposes these records without leaking credentials or message content. Acceptance requires pairing delivery, one authenticated notification, `.ping`, `.menu`, owner/sudo authorization, unauthorized silence, quoted/media parsing, transient reconnect, restart recovery, logout classification, purge cleanup, listener uniqueness, and no silent message loss.

### Milestone 2 — Introduce the unified moderation action engine

Create a single internal action contract, for example `ModerationActionRequest`, containing group, actor, target, source message, detection rule, requested action, reason, and correlation ID. The engine must execute the complete pipeline:

> DETECT → CLASSIFY → EXEMPTION → RECORD → ACTION → EXECUTE → NOTIFY → CLEANUP

`DETECT` receives manual commands and automatic messages/member events. `CLASSIFY` maps them to link, spam, filter, warning, raid, mute, ban, lock, or informational actions. `EXEMPTION` evaluates Telegram administrators, configured staff, whitelist/trusted users, the bot itself, and explicit protected targets. `RECORD` writes the attempted action and correlation ID before transport execution. `EXECUTE` calls the Telegram API and captures the exact success or failure. `NOTIFY` sends only the appropriate moderator/member-facing response. `CLEANUP` deletes offending messages, expires temporary state, and removes completed Redis markers.

Refactor existing `/mute`, `/unmute`, `/ban`, `/unban`, `/warn`, anti-link, anti-spam, and filter handlers to call the engine rather than duplicating permission and event logic. This is the key dependency for reliable dashboard counts, raid lockdown, and truthful logs.

Acceptance requires that every manual and automatic action produces one durable event, exempted users generate an auditable skip reason, failed Telegram calls expose a failure reason, duplicate updates do not double-apply actions, and ordinary users cannot invoke moderator actions through commands or crafted message content.

### Milestone 3 — Durable expiry and reconciliation worker

Extend `ModeratorGroupRecord` with fields such as `groupMuteUntil`, `groupMuteAppliedAt`, `groupMuteActorId`, `lockdownUntil`, and `lockdownReason`. Add a durable moderation job or expiry record keyed by group and action type. The existing BullMQ/Redis orchestration should be reused for retry, idempotency, progress, and cancellation rather than adding an unrelated scheduler.

Implement a worker that scans due expiries, restores group permissions through `setChatPermissions`, records the result through the unified engine, and removes the completed expiry marker. On process startup, reconcile all active group mute and lockdown records. If the expiry is already past, restore immediately; if it is future, enqueue the remaining delay. The worker must be safe under duplicate execution and Redis/Mongo retries.

Acceptance requires group mute to restore automatically without `/unmute all`, restart persistence to work, expired records to be cleaned, Telegram failures to retry with bounded backoff, and no group to be accidentally unmuted when another active lockdown still applies.

### Milestone 4 — Group setup and moderator dashboard

Add a dedicated moderator UI module separate from the general workspace/admin dashboard. The first screen should show group identity, bot permission status, protection state, active mute/lockdown expiry, warning totals, recent moderation events, filter count, whitelist/staff count, and setup completeness.

Implement Quick Protect as a bounded preset that confirms the bot has required Telegram administrator permissions before applying anti-link, anti-spam, default warning escalation, and safe cleanup settings. Implement Custom Setup as a guided state machine with explicit Save, Cancel, Back, and Preview operations. Every inline button must edit the existing dashboard message when the interaction is a view mutation rather than sending duplicate menus.

Use grouped controls for Protection, Warnings, Rules, Filters, Members, Raid Lockdown, Logs, and Advanced Settings. Dashboard counts must be read from durable state or real Telegram queries, never from hardcoded display values. Command suggestions should continue to respect private-chat, group-chat, and administrator scopes; the dashboard should additionally refresh its own group-specific controls based on the caller’s permissions.

Acceptance requires ordinary users to receive no moderator dashboard, administrators to see only their current group’s controls, callback actions to be permission-checked again, counts to reflect real persisted data, and a restart to preserve all settings.

### Milestone 5 — Raid and join-flood protection

Handle `chat_member` and equivalent join events through a Redis sliding window keyed by group. Store event timestamps and unique user IDs, exclude existing administrators/staff/whitelist entries where appropriate, and apply configurable thresholds. When the threshold is crossed, invoke the unified engine to activate a temporary lockdown with a bounded maximum duration. The lockdown should restrict new message activity using the least destructive Telegram permission set that satisfies the configured protection policy.

Record the trigger, observed count, threshold, expiry, actor/source, and Telegram API result. Notify administrators once per lockdown window rather than once per member. Provide an administrator-only recovery action and an automatic expiry path. Use deduplication keys so Telegram retries do not inflate the join count.

Acceptance requires synthetic join floods to produce one lockdown, normal joins to remain unaffected, exempt members not to trigger the lock, recovery to restore permissions, and restart/retry behavior to preserve the active lockdown.

### Milestone 6 — Controlled tag-all job

Implement tag-all as an administrator-only, explicitly confirmed command. Resolve eligible members from Telegram where available, deduplicate IDs, exclude bots, administrators, staff, whitelist/trusted users, and the requesting moderator where configured, and apply a hard maximum count and message-size budget. The job should use the existing BullMQ orchestration with idempotency, bounded concurrency, progress, cancellation, and rate limits.

The user-facing flow should be `preview → confirm → execute → progress → complete/cancelled`. It should never mention users who cannot be resolved or who opted out through configured exclusions. Every execution should record the actor, eligible count, sent count, skipped count, cancellation state, and failures. Telegram flood limits must be handled with bounded delay and retry, not unbounded loops.

Acceptance requires duplicate membership inputs to produce one mention each, administrator/bot exclusions to hold, a large group to remain bounded, cancellation to stop future batches, retries not to duplicate completed batches, and ordinary users to be denied before job creation.

### Milestone 7 — Rules, trusted users, greetings, and detection completion

Convert rules into a small state machine with `unset`, `draft`, and `published` states, validation, preview, and explicit publish/cancel actions. Add trusted-user management as a distinct durable set with administrator-only add/remove/list operations and consistent exemption handling in every automatic rule.

Complete welcome/goodbye media delivery using the existing media abstraction, with caption templating, real member mentions, size/type validation, and optional cleanup through a durable cleanup job. Extend link detection for obfuscated schemes, whitespace-separated domains, invite variants, and link-like text while minimizing false positives. Add explicit bot self-protection before any automatic deletion, restriction, or escalation.

Acceptance requires state transitions to survive restart, invalid templates to be rejected, media failures to be logged without crashing moderation, trusted users to be exempted consistently, and obfuscated-link fixtures to be covered by tests.

## 4. Test and rollout gates

| Gate | Required checks | Release decision |
|---|---|---|
| Unit and contract | Engine transitions, exemptions, idempotency, schema defaults, Redis TTLs, tag-all batching | Must pass before integration testing |
| Telegram integration | Real permission checks, restriction/restore, group permission set/restore, member joins, callbacks, message deletion | Must pass in a disposable test group |
| Restart and recovery | Mongo persistence, Redis key recovery, expiry reconciliation, active lockdown restoration, job resumption/cancellation | Must pass before VPS rollout |
| Security | Ordinary-user denial, callback reauthorization, admin/staff/whitelist/bot exemptions, sensitive-log redaction | Zero unauthorized transport actions |
| Live canary | One test group and one controlled moderator account; no existing Omega process restarts | Roll back on repeated API failures or process instability |
| Production rollout | Timestamped backup, migration check, health probe, PM2 status, recent log scan, service-isolation check | Deploy only after all prior gates pass |

## 5. Rollback and non-regression safeguards

Every schema change should be additive first, with defaults that preserve existing behavior. A migration marker and rollback backup must be created before deployment. New workers should be disabled by configuration until their data model and canary tests are complete. The dashboard must never imply that a protection feature is active until the Telegram API call succeeds and the durable state reflects that result.

No healthy WhatsApp authentication should be invalidated during a moderator rollout. No existing `omega-core` or `omega-test` process should be restarted. If a new worker repeatedly fails, pause or disable only that worker and preserve the core bot. If a Telegram API action partially succeeds, the event log must state the exact result and the recovery path rather than reporting a generic success.

## 6. Recommended execution order

The shortest safe path is **Milestone 0 → Milestone 1 → Milestone 2 → Milestone 3 → Milestone 4 → Milestone 5 → Milestone 6 → Milestone 7**. Milestones 2 and 3 are the critical foundation: without a single action engine and durable expiry reconciliation, raid lockdown, dashboard counts, and advanced notifications would reproduce the current direct-handler fragmentation.

The first implementation increment should therefore be the unified moderation action contract plus additive persistence for group mute/lock expiry and structured action events. The first production canary should be limited to one Telegram test group, with the existing WhatsApp transport and Omega services left untouched.

— **Manus AI**
