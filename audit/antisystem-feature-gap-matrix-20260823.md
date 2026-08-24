# OMEGA-MINI AntiSystem Feature-Gap and Risk Matrix

**Author:** Manus AI  
**Date:** 2026-08-23  
**Reference specification:** `/home/ubuntu/upload/OMEGA_MINI_ANTISYSTEM_FULL_AUDIT_REBUILD.txt`  
**Behavioral reference:** OMEGA-V1 at `/home/ubuntu/omega-v1/artifacts/wa-bridge/src/`

> This matrix separates source-confirmed behavior from proposed work. It is not a completion claim. Production changes must preserve one authoritative WhatsApp socket per session and must not purge, mutate, or send traffic during diagnosis.

## Component contract matrix

| Component | Purpose | Input / output | Owner | Storage | Lock / ownership | Timeout / retry | Failure mode | Recovery | Current metrics | Assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| WhatsApp local socket | One Baileys socket per local session | Session/auth → socket/events | Control process | Encrypted auth files + in-memory runtime | Redis lifecycle lock; local generation guard | Reconnect exponential backoff; no normal cap | Close, crypto storm, heartbeat failure | End socket, schedule reconnect, preserve auth for non-terminal events | Session timestamps, reconnect count, last error | **Partially compliant**; lifecycle exists but state/reason taxonomy is weaker than V1. |
| Assigned panel socket | Run assigned session on external panel | Signed workload command/status ↔ panel socket | Panel worker | Encrypted worker auth files; Mongo assignment/status | Durable assignment + worker credential; no shared socket fence | Worker reconnect backoff; RPC retries 429/502/503/504 | Worker unavailable, session close, heartbeat timeout | Panel reconnect; control marks assignment/session degraded; logged-out path purges | Worker heartbeat/status events, assignment state | **Partially compliant**; separate implementation drifts from local lifecycle. |
| Auth persistence | Preserve Baileys credentials across restarts | creds/key writes → encrypted files | Socket runtime/auth store | Encrypted JSON files | Per-key pending-write chain | No explicit bounded retry beyond chained write | Read failure appears as absent; write failure is often swallowed | Flush on stop; startup reads if decryptable | No auth persistence latency/failure counter | **Risk**; temporary storage failure can be under-observed. |
| Lifecycle state | Define what socket events mean durably | connection/status/error → session row | Session manager + registry | In-memory registry asynchronously persisted to Mongo | Lifecycle key and generation | Reconnect timer; worker heartbeat | State can be overwritten by delayed persistence/refresh | Refresh registry; reconnect; purge only terminal path | `status`, `authHealth`, timestamps, reason | **Risk**; no single shared lifecycle boundary across local/panel. |
| Functional health | Distinguish connection from usefulness | event/operation/heartbeat → health snapshot | Lifecycle/health subsystem | Mostly in-memory lifecycle; session row fields | No durable health lease | Heartbeat interval with thresholded failures and overlap guard | Repeated probe failures reach recovery callback; one/two transient failures remain telemetry | Reconnect scheduling | Heartbeat age/failure count/last failure plus lifecycle fields | **Improved / partial**; reasons are stronger, but full cross-subsystem health snapshot remains. |
| Protocol pressure | Avoid overload from recoverable crypto/session pressure | error fingerprint → pressure mode | Socket/runtime | In-memory only | No lock | Rolling window in V1; Mini crypto storm threshold 12/30s | Mini triggers socket recovery rather than background cooldown | Socket rebuild | No public pressure snapshot in Mini | **Missing** in parity form; V1 behavior should be adapted, not copied blindly. |
| Inbound ingestion | Return quickly from Baileys event callback | raw event → normalized task | Socket listener + inbound admission | In-memory bounded per-session queues | Process-local task lifecycle | Global concurrency 12, per-session active 2, max pending 500 | Queue-full drop is counted and recorded as a subsystem error | Fair round-robin pump; task errors are isolated | Active/pending/oldest wait/dropped | **Implemented / partial**; bounded but not durable across process restart. |
| Inbound admission | Fairly execute inbound work | task(session, priority) → execution | OMEGA-MINI admission scheduler | In-memory pending queues | Per-session active cap + global cap | Global 12; per-session 2; max pending 500 | Queue-full drop calls subsystem error hook | Round-robin session selection; task errors isolated | Active/pending/oldest/dropped | **Implemented / partial**; priority and fairness are covered by deterministic tests. |
| Command router | Authorize and dispatch commands | message context → reply/job/transport call | `message-router.ts` | Session registry + job store | Operation lock for heavy job classes | Direct commands often await transport; jobs durable | Wrong route or route failure | Reply/error or job retry | Job traces in some paths | **Partially compliant**; lacks universal request identity and ingress queue. |
| Outbound scheduler | Prioritize interactive over bulk | outbound intent → WhatsApp send | Per-session outbound admission | In-memory per-session queues | One active send per session | Global concurrency 24; priority sorting; max pending 1,000 | Queue-full rejects the send; caller traces failure | Round-robin sessions; preview/send remains executor | Active/pending/oldest wait | **Implemented / partial**; producers still need differentiated P0–P4 labels. |
| Preview/media pipeline | Generate previews without freezing commands | URL/media → canonical content/send | Preview helpers + job runtime | Preview caches + temp buffers | Cache scope by workspace/session | Existing bounded preview timeouts; RPC retries | Scrape/thumbnail/upload failure | Fallback/send plain content; retry safe jobs | Some job and trace metrics | **Partially compliant**; inbound media resolution remains in event callback. |
| Bulk jobs | Run all-status/all-chat/status work | intent → durable job/progress | JobOrchestrator or panel worker | Redis records, BullMQ, broadcast checkpoints | Job ID/idempotency + operation lock | Attempts/backoff, reaper/Inceptor | Worker stall, send failure, partial result | Recovery child/retry/flush | Progress, state, heartbeat | **Partially compliant**; queue isolation exists but user/session fairness needs load proof. |
| Job orchestration | Persist and execute durable work | job record → handler result | `JobOrchestrator` | Redis job store + BullMQ | Lease token and expiry in record; Redis recovery claim | Worker lock 30s-ish config; stale reaper | Heartbeat expiry, handler error | Retry/recover/fail/flush | State/attempts/heartbeat/progress | **Mostly present**; needs strict cancellation and child cleanup tests. |
| Inceptor | Recover stale jobs and flush dead-session work | all jobs + sessions → actions | `Inceptor` every 45s | Job store | Uses orchestrator recovery claim | 3m stuck grace; bounded recovery/flush | Stuck state or missing/dead session | force recover, fail exhausted, flush terminal/missing | Last sweep and action counts | **Present**; must be verified under races and avoid false flush. |
| Session operation lock | Serialize per-session mutations | workspace/session → Redis lease | Runtime/operation callers | Redis key with TTL containing token/owner/createdAt | Random token plus owner metadata; Lua exact-value fencing | TTL 30s, refresh 10s | Redis unavailable or expired lease | TTL recovery; safe token-checked release; redacted snapshot helper | Owner/createdAt/TTL can be inspected; stale counts still pending | **Improved / partial**; cross-process stale-recovery tests remain. |
| Workload command RPC | Route panel requests to assigned worker | command + request ID → result | Control/workload service | Mongo command record + waiter map | Assignment authorization; requestId | Wait up to 45s; worker poll up to 20s; retries at worker HTTP layer | Unreachable/expired/failed command | Requeue/mark unavailable/return error | Command state/events | **Partially compliant**; retry semantics need method safety. |
| Worker heartbeat | Keep panel and assignments ready | heartbeat → worker/assignment/session state | Workload service + worker | Mongo worker/assignment rows | Credential auth | Timeout configured; status promotion | Missed heartbeat → worker UNREACHABLE and assigned session DEGRADED | Worker reconnect and recovered state | Worker status/events/last heartbeat | **Partially compliant**; one worker outage affects assigned sessions, as intended, but not WhatsApp evidence. |
| Redis | Queues, locks, job state, caches, waiters | commands/events → records | Control process/panel | Redis logical prefixes | Redis server | ioredis reconnect; many catches swallow failures | Redis timeout/outage | Reconnect or degrade subsystem | Limited Redis error logs | **Risk**; responsibilities are prefixed but health attribution is incomplete. |
| Session registry | Memory + Mongo session view | persisted snapshot → session objects | Control process | Mongo + in-memory maps | No version/monotonic lifecycle revision | Refresh every 10s minimum | Async persistence failure hidden; stale merge by three timestamps | Refresh/hydrate | Status/timestamps only | **Risk**; lifecycle updates need revision/fencing. |
| Telegram UI | Render list/detail/control views | callback/message → edit/send | Telegram bot | In-memory UI/session selection caches | Owned-session authorization | Callback edits often catch errors; fixed group path now has visible errors | Telegram API edit failure or expired token | Reload/visible alert | No aggregate callback latency/failure metric | **Partially compliant**; requires callback/open smoke tests. |
| Startup restoration | Restore valid sessions/jobs after restart | durable records → runtimes | Index/startup + managers | Mongo + auth dirs + Redis jobs | Session lock | Async startup with waits | Stale auth/worker unavailable | Restore or retain degraded state | Startup logs, health | **Partially compliant**; needs acceptance test for exact one socket/listener. |
| Shutdown cleanup | Prevent listener/timer/socket leaks | stop signal → closed runtime | Index/session/job managers | Auth flush + Redis | Release locks | Close workers; auth flush; socket stop | Stop timeout/SIGKILL | Force terminate after bounded grace; next boot recovers durable jobs | No central cleanup count | **Risk**; V1 has more explicit listener/store/dependent cleanup. |
| Observability | Make every degradation explainable | state/event → redacted logs/dashboard | Cross-cutting | Mongo events + logs + Redis progress | Request/job correlation | N/A | Missing correlation or raw secret risk | Audit event and safe user error | Partial per-job/workload logs | **Partially compliant**; missing one health snapshot. |

## Requirement-by-requirement gap matrix

| Spec area | Current evidence | Status | Priority | Safe action |
|---|---|---:|---:|---|
| Health states beyond connected | Mini has lifecycle `ONLINE`, `DEGRADED`, `RECONNECTING` and session `status/authHealth`; V1 has functional health snapshot. | Gap | P0 | Add session-scoped health snapshot and reason code without changing user-visible state until thresholds are met. |
| Measurable degradation reason | Mini stores `disconnectReason`/`lastError`, but not all subsystems. | Gap | P0 | Add typed reason categories and latest subsystem details. |
| Heartbeat thresholds/hysteresis | Mini local heartbeat fails the probe and ends socket immediately. | Risk | P0 | Count consecutive failures and require threshold; record heartbeat age. |
| False-degradation prevention | Panel timeout and command/worker failures can mark session degraded without direct WhatsApp evidence. | Risk | P0 | Degrade worker/operation subsystem first; only session-degrade on session-level evidence. |
| Non-blocking inbound events | Mini performs media resolution and trace/link work in `messages.upsert`. | Broken relative to spec | P0 | Introduce bounded per-session/global admission queue around event processing. |
| Dedicated outbound scheduler | Jobs have separate queues, but direct replies and media sends are not one priority scheduler. | Missing | P0 | Implement per-session prioritized outbound intent queue; keep current send path as executor. |
| Global bottleneck avoidance | Four BullMQ workers and panel-broadcast separation exist. | Partial | P1 | Add fair scheduling metrics and load gates; do not duplicate sockets. |
| Safe duplication | Worker pool separation exists; one socket per runtime map/assignment. | Partial | P1 | Add duplicate-start/generation/fencing tests. |
| Panel parity | Panel has separate runtime and reports status through control APIs. | Partial | P0 | Align classification, request IDs, and health reasons; preserve panel isolation. |
| 502/503/504 | Worker retries these three statuses; control wait is bounded. | Partial | P0 | Classify separately and retry only idempotent/read-only operations automatically. |
| Idempotency | Job idempotency key, jobId, command requestId exist in several paths. | Partial | P0 | Audit every producer; require stable key for pairing, status, moderation, broadcasts, and media. |
| Ghost locks | Token-checked TTL locks prevent deleting another owner’s lock. | Partial | P0 | Add owner metadata/fencing/metrics and stale lease inspection; never blind-delete. |
| Reconnect storms | Backoff and session lock exist; local close classification can be terminal too early. | Risk | P0 | Centralize recoverable/terminal classification and cap concurrent recovery. |
| Startup restoration | Auth/session/worker recovery code exists. | Partial | P1 | Prove exact one socket/listener and durable job resume via restart test. |
| Listener cleanup | Local runtime removes runtime but does not expose listener/store count audit; panel replaces runtimes. | Risk | P1 | Add lifecycle cleanup counters/tests and generation assertions. |
| Credential persistence | Encrypted atomic writes and per-key serialization exist. | Partial | P0 | Record failure, bounded retry, and preserve valid session on temporary storage error. |
| Redis responsibility separation | Namespaced Redis keys and separate clients exist. | Partial | P1 | Add subsystem health and latency metrics; avoid hot scans in request paths. |
| Event-loop protection | Runtime monitor now reports event-loop lag, CPU, and memory; inbound work is admitted through bounded queues. | Improved | P0 | Extend metrics to dashboards and validate under multi-session load. |
| Memory protection | Runtime health now reports RSS, heap, external, and array-buffer usage. | Improved / partial | P1 | Add leak/cleanup tests across reconnect and media cycles. |
| Preview/media isolation | Canonical preview and worker media paths exist, but inbound media is resolved in socket event callback. | Partial | P0 | Move resolution to admission/worker; preserve URL cache scope. |
| AntiSystem as smart scheduler | Inceptor and locks exist; no complete health/backpressure controller. | Partial | P0 | Implement typed pressure/backpressure for background work only. |
| Platform restrictions | Some runtime logic recognizes rate/locked/growth conditions. | Partial | P0 | Separate genuine WhatsApp restrictions from internal timeout, worker, Redis, and HTTP failures. |
| Adaptive backpressure | Broadcast/job concurrency is bounded; no unified per-session adaptive controller. | Partial | P1 | Track queue growth and reduce only affected background operation. |
| Priority/fairness | BullMQ queues and priorities exist; no ingress/output per-session fairness. | Partial | P0 | Add P0–P4 scheduler lanes and round-robin per-session admission. |
| Health dashboard | Telegram workload/job dashboards exist; no full per-session health fields. | Gap | P1 | Add redacted aggregate health snapshot, edit in place. |
| Staged recovery | Job retries/reaper and socket reconnect exist; failure levels are not explicit. | Gap | P0 | Add recovery level/reason state, without direct purge escalation. |
| Purge safety | Local classifier now treats bare 401 and 403/405/440/500 as recoverable; explicit logout evidence remains terminal. Panel worker still needs the same shared classifier. | Improved / partial | P0 | Align panel-worker classification and add end-to-end purge-preservation tests. |
| Structured logging | Many logs include session/workspace/reason; request/job/duration/error class not universal. | Partial | P1 | Add common redacted correlation fields. |
| Metrics | Workload health now exposes process event-loop, CPU/memory, inbound, and outbound aggregates; session/job/HTTP/Redis metrics remain incomplete. | Improved / partial | P1 | Add durable per-session health and HTTP/Redis counters. |
| Load test 1–100 sessions | Existing high-scale tests are mostly contract/source tests, not live concurrency. | Missing | P1 | Add synthetic socket-boundary load harness without sending WhatsApp traffic. |
| Failure injection | Some tests cover lifecycle/jobs; no complete 502/Redis/socket/duplicate-event matrix. | Missing | P0 | Add deterministic failure-injection tests and safe live read-only checks. |
| Panel stress A/B/C | No end-to-end stress evidence in current reviewed records. | Missing | P1 | Run isolated control/worker simulation and read-only panel route load. |
| Single points of failure | Global Redis/Mongo and control process remain common dependencies; panel worker isolated by assignment. | Risk | P1 | Measure, then partition schedulers/connections where necessary; do not create duplicate session sockets. |
| No fake success | Several command paths return durable progress; status promotion must be evidence-backed. | Partial | P0 | Require verified worker response before ACTIVE/COMPLETED claims. |
| No hidden global limiter | Multiple caps exist (`QUEUE_CONCURRENCY`, broadcast, validator, locks). | Risk | P0 | Expose caps/queue wait; prove one user cannot consume all interactive capacity. |

## Prioritized implementation decision

### P0 — safe reliability boundaries

The first production slice should implement typed failure classification, session health reasons, heartbeat hysteresis, per-session inbound admission, safe outbound prioritization, lock diagnostics/fencing tests, and panel/control request correlation. These changes can be made without sending WhatsApp traffic or purging sessions.

### P1 — scale and observability

The second slice should add event-loop and memory metrics, dashboard aggregates, fair-load tests, Redis latency/failure metrics, and listener/timer cleanup counters. These are required to demonstrate improvement under the specification’s 50-session scenario.

### Explicitly deferred until evidence

Automatic purge policy changes, live reconnection policy changes, Redis topology changes, and worker release changes must not be applied solely from static analysis. They require deterministic tests and, where relevant, read-only live verification first. No genuine platform restriction should be bypassed.

## Acceptance gate mapping

| Acceptance gates | Planned proof |
|---|---|
| 1–8: lifecycle, heartbeat, logout/restriction, gateway | Unit classification matrix, heartbeat hysteresis tests, worker/control status tests |
| 9–12: locks, duplicate sockets/listeners/jobs | Fencing race tests, generation tests, idempotency tests |
| 13–18: traffic, priority, fairness, panel parity | Inbound/outbound scheduler tests and panel A/B/C load harness |
| 19–24: Redis, restart, jobs, media, metrics | Redis failure injection, restart simulation, media isolation tests, health snapshot assertions |
| 25–32: staged recovery, no purge, load, no hidden limiter | Recovery-level tests, session-preservation tests, concurrency stress, cap telemetry |

## References

1. [Attached AntiSystem Full Audit Rebuild specification](file:///home/ubuntu/upload/OMEGA_MINI_ANTISYSTEM_FULL_AUDIT_REBUILD.txt)
2. [OMEGA-V1 session lifecycle manager](file:///home/ubuntu/omega-v1/artifacts/wa-bridge/src/services/session-lifecycle-manager.ts)
3. [OMEGA-V1 functional session health](file:///home/ubuntu/omega-v1/artifacts/wa-bridge/src/services/session-health.ts)
4. [OMEGA-V1 protocol pressure](file:///home/ubuntu/omega-v1/artifacts/wa-bridge/src/services/session-pressure.ts)
5. [OMEGA-V1 inbound admission](file:///home/ubuntu/omega-v1/artifacts/wa-bridge/src/whatsapp/inbound-admission.ts)
6. [OMEGA-MINI session manager](file:///home/ubuntu/pappy-omega-mini-migration/src/whatsapp/session-manager.ts)
7. [OMEGA-MINI session lifecycle](file:///home/ubuntu/pappy-omega-mini-migration/src/whatsapp/session-lifecycle.ts)
8. [OMEGA-MINI workload service](file:///home/ubuntu/pappy-omega-mini-migration/src/workload/service.ts)
9. [OMEGA-MINI job orchestrator](file:///home/ubuntu/pappy-omega-mini-migration/src/jobs/job-orchestrator.ts)
10. [OMEGA-MINI panel worker runtime](file:///home/ubuntu/pappy-omega-mini-migration/tools/worker-runtime-source.mjs)
