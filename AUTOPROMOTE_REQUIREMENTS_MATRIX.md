# Pappy Omega Mini — Auto Promote Requirements Matrix

**Source:** user-provided `AUTO PROMOTE — COMPLETE CORRECTION & IMPLEMENTATION PROMPT` (1,411 lines) and the current Pappy Omega Mini repository.

## Executive finding

The repository already has durable generic jobs, a Mongo-backed scheduler, WhatsApp all-status/all-chat workers, media persistence, native link previews, and Telegram live views. It does **not** yet have a first-class Auto Promote configuration/run model, three-scope ownership model, daily slot planner, per-session Auto Promote lock/priority queue, or a complete guided Auto Promote Telegram UI. The implementation must extend the current architecture rather than create a parallel send system.

## Requirement-to-code matrix

| Prompt area | Current repository state | Gap | Implementation decision |
|---|---|---|---|
| Three scopes | Sessions and workspaces exist; no Auto Promote scope model | Session, user/all-session, and owner/global jobs are not represented separately | Add durable `AutoPromoteConfig.scope` with `SESSION`, `USER`, and `GLOBAL`; resolve targets at run time with ownership checks |
| Command selection | Existing workers support `allstatus`, `allchat`, and repeat counts | No Auto Promote command wizard | Add buttons for All Status, All Chat, All Status X; map directly to existing job kinds |
| Duration | Generic schedules have no start/end-day model | No 2–30 day validation or day counters | Store start/end dates, total days, timezone, and deterministic occurrence dates |
| Times per day | Generic scheduler supports only `intervalMs` | No daily named slots | Add slot planner for 1–5 occurrences: evening; morning/evening; morning/afternoon/evening; morning/afternoon/evening/night; plus late-night |
| Timezone | Workspace settings have timezone, currently defaulting to UTC | No per-config timezone and no explicit slot timestamps | Add per-config timezone, default `Africa/Lagos`, and central slot definitions |
| Custom times | No slot abstraction | Scheduler would be hard-coded around one interval | Store slot key plus timestamp; keep default clock definitions centralized and replaceable |
| Payload preservation | `job-media-store` preserves media bytes, MIME, filename, and PTT; existing commands preserve text/media | No Auto Promote payload record or quoted-message model | Store immutable payload references and original text/caption/URL/quote metadata; reuse media store and central preview path |
| All Status | Existing `allstatus` worker supports groups, media, delay, delivery markers, retries, and progress | No scheduler adapter | Auto Promote occurrence enqueues existing allstatus logic with a run ID and preserved payload |
| All Chat | Existing `allchat` worker supports media and hidden mentions | No scheduler adapter | Auto Promote occurrence enqueues existing allchat logic; no duplicate sending implementation |
| All Status X | Existing repeat count executes per group before next group | No guided posts-per-group setting or run dashboard | Store 1–10 posts/group and pass as the existing repeat count; expose group/repetition progress |
| Safety | Existing bounded workers, delivery markers, retries, and session recovery exist | No Auto Promote-specific rate/lock/priority queue | Add Redis per-session lock, priority ordering, cooldown state, cancellation, and checkpoint metadata |
| Session scope | `listSessions(workspaceId)` and session ownership exist | No session-scoped Auto Promote config | Store session ID and enforce owner/session checks in every callback and worker target resolution |
| User scope | Workspace maps to Telegram user ownership in current bot | No all-owned-session config | Store owner Telegram user ID and resolve only sessions owned by that user; do not mutate session settings |
| Global scope | Owner/admin authorization exists | No cross-workspace global Auto Promote config | Store owner ID and explicit selected target sessions; never overwrite user/session configurations |
| Conflict priority | Generic workers have no Auto Promote queue ordering | Session/user/global jobs could collide | Queue by priority `SESSION > USER > GLOBAL`, then scheduled time and creation time |
| Session lock | Broadcast markers exist but no shared session execution lock | Auto Promote can compete with normal jobs | Add a shared Redis session-operation lock usable by scheduled mass-send jobs and Auto Promote |
| Cooldown | Join cooldown exists only inside Join Manager | No 30-minute cross-scope cooldown | Persist `cooldownUntil` per run/session and schedule the next eligible run; never use process-local sleeps |
| Restart recovery | Generic stale jobs recover; schedules are claimed atomically | No Auto Promote occurrence/run recovery | Persist config/run/occurrence identity; recover due and in-progress runs with deterministic idempotency |
| Job identity | Generic jobs have job IDs/codes | No config ID vs run ID distinction | Add `AutoPromoteConfig.id`, `AutoPromoteRun.id`, and occurrence identity `configId:date:slot:sessionId` |
| States | Generic job states exist but omit waiting/cooldown/expired | Auto Promote needs explicit lifecycle | Add Auto Promote state machine: SCHEDULED, QUEUED, WAITING_FOR_SESSION, RUNNING, COOLDOWN, COMPLETED, PARTIAL, FAILED, CANCELLED, EXPIRED |
| Cancellation | Generic orchestrator supports cancel cooperatively | No scope-authorized Auto Promote cancellation UI | Add owner/session/user authorization around cancel and map to occurrence/run cancellation checkpoints |
| Pause/resume | Generic workers support pause/resume | No Auto Promote dashboard controls/checkpoint restoration | Add pause/resume on config/run; preserve current session/group/repetition via run progress |
| Media reuse | Media store exists; preview subsystem is centralized | No Auto Promote payload reference | Store media reference once; workers read it per send while reusing preview/cache resources |
| Preview | Canonical Baileys-native preview resolver exists | Auto Promote has no integration | Route URL/media payloads through existing transport and preview resolver only |
| User UI | Existing dashboards, inline keyboards, and same-message edits exist | No Auto Promote wizard/dashboard | Add main Auto Promote entry, scope selection, command/day/times/posts-per-group/payload/confirm flow |
| Payload collection | Existing Telegram message/document/media handlers exist | No Auto Promote pending state | Add Auto Promote pending wizard state and reuse media persistence/quoted payload extraction |
| Confirmation | Existing settings flows edit same messages | No pre-create summary | Render command, duration, slots, timezone, scope, target sessions, payload, and confirm/edit/cancel |
| Active dashboard | Existing job live screens show progress | No config/run dashboard | Add user dashboard filtered by owner and owner dashboard across scopes, with run metrics and next execution |
| Session status | Existing session menus show health/groups | No three-scope Auto Promote state | Add per-session status rows: Session/User/Global, next run, lock, cooldown |
| Smart queue | BullMQ queue exists | No per-session Auto Promote ordering | Add scheduler admission/lock layer before dispatch; no duplicate send loops |
| Normal-command collision | Existing allstatus/allchat jobs use orchestrator | No shared operation lock | Acquire same session lock for Auto Promote and mass-send command workers; release at terminal state |
| Rate limiting | Existing broadcasts have configurable delay and bounded loops | No Auto Promote-specific pacing policy | Reuse command delay with per-session cap, adaptive backoff, and safe continuation on group failures |
| Failure handling | Generic jobs retry and report; session lifecycle recovers | No run-specific pause/resume/partial state | Persist run checkpoints and classify disconnect/logged-out/Redis/Mongo failures without false completion |
| Multi-day execution | Schedules are interval/one-shot | No explicit occurrences | Generate deterministic occurrences per config date/slot and dispatch only unclaimed occurrences |
| Misfire policy | Generic scheduler has no grace/misfire field | Missed events could run late or duplicate | Add grace window and default skip-stale/continue-next policy; never replay every missed occurrence |
| Persistence | Mongo schedules/configs exist; Redis queues/markers exist | No durable Auto Promote configs/runs | Add Mongo `auto_promote_configs`, `auto_promote_runs`, and occurrence uniqueness; Redis for locks/transient progress |
| Security | Existing owner/session authorization exists | Callback/job ID ownership is not Auto Promote-aware | Authorize all config/run/cancel/pause/view operations by scope and owner; never trust callback IDs alone |
| Scale | Existing bounded workers and group inventory timeout exist | No Auto Promote-level backpressure | Use bounded target resolution, durable queueing, per-session locks, and stable payload references |
| Testing | Existing suite covers transport, UI, preview, join, and workers | No Auto Promote scope/collision/restart tests | Add unit/integration coverage for all three scopes, queue priority, cooldown, missed schedules, payloads, lock release, and restart recovery |

## Implementation order

First, add the durable domain model and persistence operations. Second, add the deterministic daily occurrence planner and scheduler admission layer. Third, adapt existing all-status/all-chat workers to carry Auto Promote run metadata and shared session locks. Fourth, add the Telegram wizard and owner/user dashboards. Fifth, add payload capture and media/preview reuse. Finally, add collision, restart, and multi-scope regression coverage before deployment.

## Explicit safety decisions

Auto Promote will not use an unbounded `setInterval` send loop or a 30-minute process-local sleep. It will not bypass WhatsApp restrictions, create a second preview system, mutate another session’s configuration, or treat a missed occurrence as permission to dump all missed posts immediately. The scheduler will use durable timestamps, deterministic occurrence IDs, bounded worker concurrency, cooperative checkpoints, and a session lock shared with mass-send operations.
