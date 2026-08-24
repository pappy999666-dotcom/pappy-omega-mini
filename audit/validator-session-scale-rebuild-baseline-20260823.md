# OMEGA-MINI Validator Session Scale Rebuild — Initial Audit Baseline

**Date:** 23 August 2026
**Scope:** Existing WhatsApp/Baileys bot, Telegram control plane, external panel workers, validator buckets, leases, queues, and session lifecycle.

## User-supplied acceptance principles

The supplied rebuild specification requires an audit before blind patching, explicit session state and supervision, safe heartbeat/reconnect behavior, separation of control and work planes, durable canonical validator state, lease recovery, truthful counters, per-user/per-session isolation, adaptive bounded concurrency, structured logs, durable jobs, failure injection, and stress tests. Success must not be claimed from button/UI checks alone.

## Current source architecture

| Area | Current modules |
|---|---|
| Session registry/lifecycle | `src/core/session-registry.ts`, `src/whatsapp/session-manager.ts`, `src/whatsapp/session-lifecycle.ts`, `src/core/session-lock.ts` |
| WhatsApp transport/routing | `src/whatsapp/transport-adapter.ts`, `src/whatsapp/workload-transport.ts`, `src/whatsapp/message-router.ts`, `src/whatsapp/remote-bridge.ts` |
| Jobs and scheduling | `src/jobs/job-orchestrator.ts`, `src/jobs/runtime.ts`, `src/jobs/scheduler.ts`, `src/jobs/inceptor.ts`, `src/jobs/bounded-batch.ts` |
| Validator/link state | `src/links/link-bucket-store.ts`, `src/links/validator-operations.ts`, `src/links/validator-snapshot.ts`, `src/links/link-collector.ts`, `src/links/url-canonicalization.ts` |
| Workload plane | `src/workload/control-server.ts`, `src/workload/service.ts`, `src/workload/events.ts`, `src/workload/readiness.ts`, `src/workload/security.ts`, `tools/worker-runtime-source.mjs` |
| Persistence | `src/persistence/mongo.ts` |
| Redis/coordination | `bullmq`, `ioredis`, `src/core/session-lock.ts`, `src/core/redis-events.ts`, validator snapshot, broadcast progress, link collector |
| Telegram control | `src/telegram/bot.ts`, `src/telegram/moderator.ts`, `src/telegram/ui.ts`, `src/telegram/renderer.ts` |
| Media/preview | `src/whatsapp/baileys-native-preview.ts`, `src/whatsapp/job-media-store.ts`, `src/media/menu-media-store.ts` |

## Existing verified findings carried forward

The prior Validator Hub audit documented three root causes for bucket regression: duplicate intake could overwrite an existing canonical record back into Main; manual maintenance could merge Active into Main; and validator guard retirement could replay historical failures or scheduler-level no-healthy-session outcomes. Those code paths were changed previously, with a reported live state of Main 3,863, Validating 0, Active 751, Dead 41, Error 0.

The prior high-scale audit documented that panel `.allstatus` still resolved the full group list on the control plane before creating a job, transferring large arrays through the generic workload command result. It also documented likely upstream 413s, scoped `rate-overlimit` confusion, command-chain serialization risks, and the need for worker-local durable broadcast intents and compact progress events. These findings remain part of this rebuild audit until reverified against the current source and production behavior.

## Safety constraints for this rebuild

No healthy WhatsApp session will be purged, re-paired, or intentionally disconnected without explicit authorization. No WhatsApp test message, group creation, group join, broadcast, or other outbound write will be used as a default diagnostic. Existing unrelated working-tree changes will not be reset, discarded, or committed. Production changes must be incremental, backed up, and control-plane-only unless a worker artifact change is specifically required.

## Next audit actions

1. Trace every session state/lifecycle/heartbeat/reconnect/lock writer and reader.
2. Trace every link bucket transition and direct database mutation.
3. Trace job ownership, queue boundaries, HTTP request lifetimes, and Redis failure behavior.
4. Map panel-worker assignment and per-user isolation boundaries.
5. Produce a root-cause matrix before implementation.

## Early code-level findings

The persisted `WhatsAppSession` type currently has lifecycle fields for status, auth health, connected/healthy/message/command/outbound timestamps, reconnect count, socket generation, validator retirement, worker assignment, and error/disconnect notes. The authoritative in-memory lifecycle module separately tracks `CREATING`, `PAIRING`, `PAIRING_CODE_READY`, `AUTHENTICATED`, `CONNECTING`, `ONLINE`, `RECONNECTING`, `DEGRADED`, `LOGGED_OUT`, `BANNED_OR_RESTRICTED`, `FAILED`, and `PURGED`, with one runtime map, one start-promise map, one reconnect timer, and one heartbeat timer per lifecycle key.

The session manager registers `creds.update`, `messages.upsert`, and `connection.update` listeners once per newly created socket and deduplicates runtime creation with the runtime map. On open it starts a 10-second heartbeat using `sendPresenceUpdate("available")`, which is a real WhatsApp presence operation rather than a passive socket check. On close it classifies the disconnect, releases the session lock, marks terminal classifications invalid and purges them, and schedules unbounded exponential reconnect for nonterminal failures. This requires further verification against the specification because the documented state names differ, heartbeat traffic is not entirely passive, and terminal classification/purge safety must be checked against all Baileys codes.

The current validator link store defines canonical buckets `main`, `validating`, `active`, `dead`, `error`, and `master`, but its record keys, bucket indexes, claims, moves, counters, and reconciliation are implemented in Redis. The Mongo persistence layer has no visible canonical validator link model/schema. This directly conflicts with the rebuild requirement that the database be the persistent source of truth and Redis only provide queue/cache/lease/coordination. The validator claim uses a Redis NX lock with a 60-second expiry and token-safe release, but the link record itself does not expose a general owner/job/worker/start/expiry lease structure; it stores only a validation lease token inside metadata.

The current `upsert` path does preserve an existing bucket on duplicate input, and `mergeValidatorBuckets` only requeues Error records after earlier fixes. However, the atomicity of record/index updates, cross-process concurrency, and behavior during Redis failure still require testing. A Redis outage in this path can therefore affect the only copy of validator bucket state unless a separate durable migration or database-backed transition layer is added.

## Session and job lifecycle audit findings

The current session lifecycle does enforce a runtime map keyed by workspace/session and a start-promise map, so duplicate local socket creation is guarded. A Redis lifecycle lock has an owner token, 30-second TTL, 10-second refresh, and token-safe release; a separate operation lock is used by background posting/join work. There is no explicit persisted lock owner/job/created/expiry record for session locks, so post-crash diagnosis is limited to the Redis key and token, and lock purpose/owner is not visible in Mongo.

The in-memory lifecycle state supports one reconnect timer and one heartbeat timer per key, with exponential backoff and jitter. Reconnect has no normal retry ceiling. On connection open, the session manager starts a 10-second heartbeat that calls Baileys `sendPresenceUpdate("available")`; this is not a passive health check and may generate WhatsApp traffic. The heartbeat failure path marks the session degraded and ends the socket; the close handler then schedules reconnect. The close classifier marks terminal conditions as invalid and immediately invokes `purgeWhatsAppSession`, while nonterminal conditions are degraded/reconnecting. This behavior is safer than treating every close as logout but still needs a complete classification matrix and failure-injection test before being considered production-safe.

Socket event listeners are installed on each newly created socket: credentials persistence, inbound messages, and connection updates. Inbound message handling performs media resolution before routing for media-looking commands, then dispatches command replies asynchronously. Automatic invite collection can start validator sweeps from inbound message handling. The current code does not place a dedicated priority queue between socket events, interactive commands, media/preview resolution, and background work; it relies on separate job queues and a session operation lock for some posting paths.

Startup recovery hydrates the registry, starts the job runtime, then starts all locally owned recoverable sessions with concurrency six and waits for ACTIVE/VALID. Panel-assigned sessions are excluded from the main process and are expected to be started by the external worker. Sessions with missing persisted auth are set to PAIRING rather than purged. Logged-out/invalid sessions are periodically purged, while ordinary restart preserves auth. Shutdown stops control/schedulers, then WhatsApp sockets, then job workers and shared clients; long handlers are intentionally not awaited, leaving durable records for later recovery.

The durable job model has QUEUED, RUNNING, PAUSED, CANCELLING, CANCELLED, COMPLETED, PARTIAL, FAILED, RETRYING, WAITING_FOR_SESSION, COOLDOWN, SCHEDULED, and EXPIRED states. Job records are persisted in Redis-backed job storage with Redis idempotency keys; BullMQ workers are split into general, broadcast, panel-broadcast, and validator queues. A reaper and startup recovery can reschedule stale jobs, guarded by Redis recovery keys. The rebuild specification’s explicit STOPPING/RECOVERING states are not represented by the current contract, and the idempotency/recovery source is still Redis rather than a database transaction.

The operation lock is held around each broadcast delivery and retry, but the broadcast handler waits for the inter-post delay before acquiring it. This reduces lock hold time but still lets background work contend with interactive operations on the same session. The current worker-local panel broadcast design is partially implemented; large panel group catalogs were previously transferred through control-plane commands, and this remains an acceptance gap until the worker-local path is independently verified at scale.

## Live control/work-plane and resource evidence

The live production host currently exposes the control service on `127.0.0.1:8788` behind Nginx. The effective workload proxy uses 90-second read/send timeouts and forwards `/workload/` to the control service. The application parser accepts up to 8 MiB JSON bodies, while the Nginx workload site does not set an explicit client body limit in the active file; the repository example uses 512 KiB. This mismatch requires route/body instrumentation rather than simply increasing limits.

The live systemd unit uses a single control-plane Node process with `CPUQuota=200%`, `MemoryMax=2G`, `TimeoutStopSec=30`, and `Restart=always`. The control process was observed around 40% CPU and 8% memory at the time of sampling. The host had load averages around 1.5–2.0, about 2.9 GiB available memory, and 2.4 GiB swap in use. Redis showed approximately 44 operations/sec, zero rejected connections and evictions, but over 60,000 total error replies. MongoDB had ample connection capacity but 107 current connections and 16 active at the sample. These are signals for deeper error-command and connection-pool analysis, not proof of a single root cause.

The host also had numerous orphaned diagnostic Node processes running under `/tmp/probe-*` for 11–12 hours, plus an older `/tmp/purge-local-vps-sessions.mjs` process running for about 16 hours. The probe processes are not production services and can consume handles/connections and interfere with live diagnostics; they should be terminated and their temporary files removed. The purge process is potentially destructive and must not be stopped or altered until its purpose and current operation are verified.

## Worker-local and Redis findings

The worker runtime now has a worker-local group inventory cache and encrypted broadcast checkpoint files. It can fetch participating groups locally with a 20-second timeout and three transient retries, reuse a last-known snapshot, and report compact progress through `/workload/progress`. This is a real partial implementation of the required worker-local direction. However, the worker still performs synchronous control requests for media and preview resolution during local broadcast execution, and the broadcast path can call group metadata for styled status or mention delivery. These paths need latency/failure isolation tests.

The Redis slowlog shows repeated expensive `SCAN` calls over `pappy-omega-mini:job:*` and `pappy-omega-mini:link:*`, plus `SSCAN` over the global Main bucket and `KEYS pappy-omega-mini:links:*:master`. One observed scan exceeded 100 ms server time. The live Redis command profile is dominated by hundreds of millions of `GET` calls, tens of millions of `SCAN` calls, and large `SSCAN`/Lua volumes. This is consistent with repeated full-key/index scans contributing to CPU and latency pressure. The current `LinkBucketStore.listAll`, migration, reconciliation, job stores, and cleanup paths must be reviewed for scan frequency and replacement with indexed/paginated durable queries.

The control-plane/work-plane boundary is therefore partial rather than complete: control requests create durable commands/jobs, but the control service still performs direct group inventory/preview/media operations and maintains in-memory waiter notification maps. Waiters are process-local; durable command records survive a process restart, but an in-flight HTTP caller does not. The live proxy’s 90-second timeout is longer than the ordinary 45-second command wait in the control plane and can produce inconsistent client/proxy timing. The production systemd service still has a 30-second stop timeout, which remains a shutdown-risk boundary for active Baileys and Redis/Mongo cleanup.

## Validator state-machine audit findings

All current canonical link records are stored under the global validator scope, even though APIs retain a workspace parameter. Intake writes new links to Main and duplicate intake preserves the existing record bucket. Validation claims move Main to Validating under a Redis 60-second NX lock and attach a lease token, but the link record has no explicit job ID, worker ID, started-at, or lease-expiry fields beyond the token and `lastCheckedAt`.

Normal validator completion moves Validating to Active only after invite metadata is obtained and a concrete group result is available. Permanent validation failures move Validating to Dead; temporary/network/rate-limit failures move back to Main. Untouched batch items are returned to Main on rate-limit failure. A periodic guard returns stale Validating records to Main when they are older than the configured stale window and not present in recent active validation jobs.

Join Manager also writes directly into the shared validator buckets. Successful and already-member joins move records to Active. Approval-required requests move to Active with a retryable request classification. Invalid-invite results are intentionally returned to Main for Guard revalidation rather than Dead, and other retryable failures return to Main; only non-retryable join failures move to Dead. This means Active is not a pure validation terminal state: it can include joined, already-member, request-pending, and possibly join-derived records. The rebuild must define whether Active means link usability, join eligibility, or both, and separate those concepts if necessary.

The dashboard snapshot counts Redis set cardinalities rather than counting canonical records from a durable database. `reconcileGlobalIndexes` removes index entries whose records are absent or whose bucket field disagrees, and restores records into their bucket indexes, but it does not enforce one-record/one-state semantics across competing writes or provide a durable audit trail. Redis failures therefore risk both data loss and counter drift. Legacy migration scans the entire Redis keyspace and uses `KEYS` for legacy master keys, which is unsuitable for a large production keyspace.

## Validator worker allocation and panel isolation findings

Validator eligibility currently requires `ACTIVE`, `authHealth === VALID`, a recent healthy/connected timestamp within five minutes, and no active validator retirement window. Selection is score-based on authentication/health/message/command recency, with optional preferred-session promotion or deterministic affinity hashing. The model does not yet include explicit capacity, per-session validation rate, cooldown, lease ownership, or per-worker concurrency in the eligibility decision.

Admission performs a global registry refresh, builds all healthy sessions across workspaces, excludes any session with a queued/running/retrying link-validation job, reads the entire Redis Main index, and admits five links per available session in round-robin chunks. Each batch receives one Redis validation lease token and one durable job record. This prevents one session from receiving unlimited work, but it is not a true fair scheduler: the global Main list is read in full, ordering is newest-first, and session selection is score-based rather than least-loaded/round-robin across repeated sweeps. A session is effectively limited to one validation job at a time, while the worker queue itself has an independent validator concurrency setting.

Rate-limit classification includes growth-lock, rate-limit, 429, flood, throttle, spam-limit, temporary-ban, and try-again-later phrases. Such results retire the session for 15 minutes and stop the batch; generic transport failures remain retryable. A guard counts failed/recent jobs and retires after three failures or a rate-limited result. The implementation explicitly avoids treating “no healthy validation session” as a socket failure, preventing a self-lock, but the classification remains string-based and needs structured error codes and a failure-injection matrix.

Panel sessions use a proxy socket that queues every method call as a `bridge.command` and waits synchronously for command completion. The proxy exposes a declared method list but also dynamically turns any alphanumeric unknown property into a remote method. The worker-side executor blocks only a short unsafe-name list (`constructor`, `end`, `ev`, `ws`, `auth`, `authState`, `user`) and otherwise invokes arbitrary socket methods if present. Assignment/workspace authorization protects the command envelope, but this is broader than a capability-based transport allowlist and can expose future/internal Baileys methods unintentionally. It also means a panel command may wait up to the control timeout while holding a caller’s request, rather than being an async typed operation with a durable result subscription.

## Live validator evidence

A read-only production query found 10 workload-worker records, 9 marked ACTIVE, 38 total assignment records, 7 non-revoked assignments, and only 2 RUNNING plus 1 ASSIGNED assignment. There were 5 persisted WhatsApp sessions, 4 ACTIVE/VALID, and 3 panel-assigned sessions. Four sessions were currently inside a validator retirement window. The active panel worker used by the previously verified Pappy session was on worker version 1.2.72 with a fresh heartbeat; several other active workers had no current assignment. One older worker remained UNREACHABLE on version 1.2.45.

The current session records showed Pappy, Pappy1p1, Main, and Aura as ACTIVE/VALID but all retired due to rate-limit/growth-lock classifications, with failure/rate-limit counters of 34/34, 32/32, 44/44, and 6/6 respectively. Paddy was DEGRADED/DEGRADED with a stale healthy timestamp and 12/12 failures/rate limits. Thus the live validator admission sweep currently has no eligible sessions even though four sockets are marked ACTIVE/VALID; this is a direct explanation for “no healthy validation session” and zero active validator work.

Redis contained 536 job records at the sample, with 189 completed link-validation jobs, 311 partial link-validation jobs, and no queued/running/retrying/failed/waiting link-validation jobs. Recent partial records repeatedly reported `growth-locked`; one reported no healthy validation session and one had a successful Active result alongside partial outcomes. This confirms that broad string-based growth-lock classification and mixed per-link outcomes, rather than an empty Main bucket alone, are currently dominating validator behavior.
