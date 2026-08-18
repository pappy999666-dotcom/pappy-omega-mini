# Pappy Omega Mini Requirements Audit

**Audit basis:** the product-owner plan in `pasted_content.txt`, the authoritative implementation plan, the current `pappy-omega-mini` source tree, and a behavioral comparison with the `omega-v1` reference. This audit intentionally distinguishes **real execution**, **partial foundations**, and **placeholder UI**. A screen that renders is not counted as a completed feature.

## Executive finding

The current deployment is a stable **foundation**, not the completed SaaS bot described by the plan. The user’s report is accurate. The new-session screen asks for a label, but the text router has no pending setup state for that label, so the next reply is ignored. Several Admin buttons are wired to a generic acknowledgement screen rather than an operational control panel. The queue and Redis foundations exist, but the validator worker currently promotes parseable URLs to `active` without using WhatsApp verification, and the outbound mass-operation workers requested by the plan are not yet implemented.

The correct next sequence is not cosmetic expansion. It is: **finish session onboarding and persistence boundaries; implement honest force-join and owner administration; build a real WhatsApp transport adapter; then connect bounded jobs, validator buckets, previews, scheduling, and analytics.** This order protects existing sessions and prevents the UI from promising controls that do not execute.

## Capability status

| Capability | Required behavior | Current evidence | Status | Priority |
|---|---|---|---|---|
| Telegram onboarding | `/start` checks force-join targets, then unlocks dashboard | Dashboard renders directly; no force-join target repository or membership verification | Missing | P0 |
| New WhatsApp session wizard | Label → country-code number → pairing code → progress → persistence → notifications | `session:new` only displays a prompt; no pending label/number state in `bot.ts`; text handler only handles global bridge input | Broken / Missing | P0 |
| Multi-session ownership | Every session belongs to one workspace and is isolated | In-memory registry has workspace ownership and session filtering | Partial | P0 |
| Durable session persistence | Mongo-backed users, sessions, auth/runtime records | Registry and session state remain in-memory/file-backed; Mongo is only health-checked | Missing | P0 |
| Session safety | Distributed lock, bounded reconnect, graceful shutdown, no transient purge | Local lifecycle has bounded reconnect and encrypted auth store; no distributed lock or durable runtime registry | Partial | P0 |
| Per-session Telegram menu | Profile, PFP, name, bio, groups, create group, My Groups, leave, sudo, Join Manager, health, Bridge, delete | Keyboard exists; most actions route to generic “guided input” or feature text | Partial / Misleading | P1 |
| WhatsApp transport | Real Baileys adapter for profile/group/media/quoted-message operations | Socket lifecycle and plain text routing exist; no general outbound adapter or media resolver | Partial | P0 |
| Pairing | Native Baileys pairing code, copy-friendly progress, recoverable state | No pairing state machine or label/number text handler; current UI cannot proceed | Missing | P0 |
| User Bridge | Select owned sessions, command, confirm scope, enqueue work, progress/results | Global command fan-out executes registry commands directly with `Promise.all`; not queued and not progress-aware | Partial | P1 |
| Global sudo | Apply sudo to all owned sessions | No real global sudo action or repository | Missing | P1 |
| Join Manager | Active bucket input, start/pause/stop/settings, bounded joins, retry/backoff, progress | Worker exists with basic delay and bucket moves; no rich settings/concurrency/recovery dashboard | Partial | P1 |
| Link collection | Text, quoted messages, files, forwards, batches; canonical dedupe into Main | Basic job contract/store exists; no complete inbound collector/media/file pipeline | Partial | P1 |
| Validator Hub | Verify links using sessions without joining; classify Active/Dead/Error; live totals/rate/ETA | Current validation worker promotes parseable links to Active; no WhatsApp verification | UI + simulated worker | P0 |
| Bucket operations | TXT/HTML downloads, metadata, merge/remerge/purge, Master bucket | Keyboard and store foundations exist; export/download/metadata paths are not complete | Partial | P1 |
| Live Validator Log | Explicit opt-in refresh with meaningful worker progress | Recent off-state fix exists; underlying validation progress remains shallow | Partial | P1 |
| Preview Manager | Preserve complete previews; hydrate partial metadata; cache, circuit breakers, metrics; integrate all senders | Minimal Redis cache and in-memory host cooldown; no sender integration/metrics/partial hydration | Partial foundation | P1 |
| WhatsApp command engine | `.ping`, `.menu`, group status, allstatus, allchat, tag, profile/group, pair, quoted media, prefix/sudo | Only a small command registry; many commands return readiness text rather than executing | Missing / Misleading | P0 |
| Mass outbound operations | Bounded workers for broadcast/allchat/allstatus/tag with cancel/stop/progress | No real outbound workers wired to Baileys | Missing | P0 after transport |
| Scheduling | User 24-job quota, Africa/Lagos timing, repeat counts/days/months, media/link/text | No real schedule repository or worker | Missing | P1 |
| Admin Force Join | Add/edit/remove/enable/disable unlimited Telegram targets, verify membership | Admin button only shows generic acknowledgement; no target storage or verification | Missing | P0 |
| Admin Global Bridge | All sessions across all users with safe confirmation and queue controls | Admin button only generic acknowledgement | Missing | P1 |
| Admin Auto-Promote | Global allstatus/allchat scheduling with unlimited safe administrative quota | Missing | P1 |
| Admin Master Bucket | Aggregate active links across workspaces; TXT/HTML export | Missing | P1 |
| Admin users | User list, username, session count, ban/unban, session management | Missing | P0 |
| Admin support inbox | User messages and immediate owner notification | Missing | P1 |
| Admin broadcast | Telegram text/media/file broadcast with safety controls | Missing | P1 |
| Admin audit | Persistent searchable audit stream | Audit event types exist; no persistent query UI | Partial | P1 |
| Emergency mode | Pause mass sends/joins/broadcasts/scheduler/global bridge/pairing visibly | Control-plane state exists; admin UI is not fully connected | Partial | P1 |
| Admin media | Upload validated media and select WhatsApp menu media | Implemented foundation and deployed | Real foundation | P2 |
| Quality gates | Typecheck, tests, build, lint, doctor, isolation, secret checks | Typecheck/tests/build/doctor used; full CI and migration gates absent | Partial | P1 |

## Why the reported screens are wrong

The new-session prompt is not a complete wizard. In `src/telegram/bot.ts`, `session:new` edits the message and asks the user to send a label, but the global `bot.on("text")` handler only processes `pendingGlobalCommand`. There is no `pendingSessionSetup` map, no label validation, no number state, and no call into a pairing-code adapter. Therefore the user’s reply has no matching handler and appears to receive no response.

The Admin screens named `forcejoin`, `users`, `bridge`, `jobs`, `bucket`, `broadcast`, and `audit` are registered in one loop that returns a generic “Owner Verified” acknowledgement. This is not an Admin Panel implementation. It proves authorization only; it does not expose the required repository, controls, confirmation steps, queue state, or results. The correct behavior is to replace each generic action with a real subpanel or an honest “not yet enabled” state that is not presented as an operational success.

The Validator UI is ahead of the worker. It can display buckets and a live screen, but the current worker’s validation decision is based on URL parsing rather than an actual WhatsApp verification adapter. It must not be described as a smart validator until the adapter, bounded job state, retry/error classification, and progress metrics are connected.

## Implementation order

| Order | Increment | Completion gate |
|---|---|---|
| P0-A | Session setup state machine and real pairing boundary | A user can label a session, submit a normalized international number, receive a real Baileys pairing request or an honest unavailable error, recover from retryable failures, and see persisted ownership/progress |
| P0-B | Force-join repository and `/start` gate | Owner can manage targets; users see honest join buttons and verification; dashboard is locked until required targets pass |
| P0-C | Durable users/sessions/auth metadata and distributed session lock | Restart and multi-process safety are tested; transient reconnect never purges credentials |
| P0-D | WhatsApp outbound adapter and quoted-media resolver | Commands resolve text/media/captions/quoted messages and call real Baileys methods behind rate/error boundaries |
| P0-E | Real outbound workers | `broadcast`, `allchat`, `allstatus`, and `tag` are durable, bounded, cancellable, idempotent, and report progress |
| P1-A | Real validator collector/worker/export pipeline | Links enter Main from all required sources, validate through sessions, classify correctly, and export TXT/HTML without blocking handlers |
| P1-B | Real Admin Control Plane | Force join, users, global bridge, jobs, Master bucket, broadcast, audit, emergency controls each have working subpanels |
| P1-C | Scheduling and auto-promote | User/admin quotas and Lagos timezone schedules are persisted, cancellable, and safe under restart |
| P1-D | Preview integration | Every outbound URL path routes through the centralized manager with preservation, hydration, metrics, and circuit breakers |
| P2 | UX polish, media enhancements, analytics, and future features | Only after operational behavior is real and tested |

## Safety decisions

The implementation will not promise “100 percent” preview success or “aggressive” behavior that bypasses platform limits. It will preserve complete previews, hydrate missing metadata when safe, use cached results, isolate host failures, and fall back without stalling a mass job. Bulk joining, tagging, all-group sends, and scheduling will use bounded queues, conservative rate controls, idempotency, cancellation, and explicit progress. Existing healthy WhatsApp sessions will not be purged because of transient reconnect or deployment changes.

## Acceptance standard

Pappy Omega Mini is complete only when a new user can honestly pass force-join, pair and recover a WhatsApp session, manage multiple isolated sessions, execute real session/global operations, collect and validate links through durable workers, use previews through every sender, and access owner controls that actually change and report system state. Menus, PM2 health, and green tests alone do not satisfy this standard.
