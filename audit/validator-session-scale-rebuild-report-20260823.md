# OMEGA-MINI Validator and Session Scale Rebuild

**Audit date:** 23 August 2026  
**Scope:** Existing WhatsApp/Baileys control plane, external workload workers, validator hub, durable jobs, Redis/Mongo persistence, reverse proxy, and live production state.  
**Method:** Source-code tracing, local architecture inspection, read-only live production queries, live resource sampling, and targeted cleanup of orphaned diagnostic probe processes. No WhatsApp messages, group creation, broadcast, join, or destructive validator migration was performed during this audit.

## Executive conclusion

The supplied specification correctly identifies the major failure classes. The current system contains meaningful reliability work, but it is not yet a completed scale rebuild. The most important verified root cause is that **validator business state is currently stored only in Redis**, while the specification requires a durable database source of truth. The dashboard counts therefore come from Redis set indexes rather than canonical database records. This makes counter drift, state loss during Redis failure, non-atomic transitions, and confusing Main/Active movement possible.

The second verified production cause is **validator-wide retirement caused by broad growth-lock/rate-limit classification**. At the live sample, four sessions were ACTIVE/VALID but all were inside a validator retirement window, with rate-limit counters of 34, 32, 44, and 6. A fifth session was DEGRADED. The admission sweep consequently had no eligible validation session even though several authenticated sessions were online. This is not evidence of a single global WhatsApp limit; it is evidence that the current policy has retired every currently available validator session.

The third verified cause is **resource and coordination pressure**. The live Redis slowlog showed repeated expensive full-key scans over job and link namespaces, `SSCAN` of the global Main index, and `KEYS` over legacy master keys. Redis had more than 60,000 total error replies at the sample, while the control-plane Node process used approximately 40% CPU. The host was using approximately 2.4 GiB of swap. Numerous orphaned diagnostic Node processes had also been left running for 11–12 hours; these were terminated with targeted signals and temporary files were removed. Production control and panel services remained active after cleanup. An older purge process was intentionally not touched because its purpose was potentially destructive and had not been verified.

The correct implementation strategy is **not a large blind patch**. It is an incremental migration: first make session lifecycle and job recovery observable and safe, then introduce a durable validator record model, then move admission and workers to the new state machine, then harden worker isolation and HTTP/resource boundaries, and only then run large stress and failure-injection tests.

## Evidence matrix

| Area | Current classification | Verified evidence | Required direction |
|---|---|---|---|
| Session runtime deduplication | **REAL/PARTIAL** | Runtime map, start-promise map, one lifecycle key, one reconnect timer, and one heartbeat timer exist. | Persist supervisor ownership and make state transitions auditable across processes. |
| Socket lifecycle | **PARTIAL** | `connection.update`, `creds.update`, inbound message listeners, reconnect handling, and auth persistence exist. | Add a complete transition matrix, structured disconnect classes, and failure-injection coverage. |
| Heartbeat | **PARTIAL/UNSAFE** | A 10-second heartbeat calls `sendPresenceUpdate("available")`. | Prefer lifecycle and passive health signals; avoid unnecessary WhatsApp traffic; separate heartbeat failure from restriction. |
| Session locks | **PARTIAL** | Redis token lock with 30-second TTL and 10-second refresh; safe token release. | Add owner/job/created/expiry metadata and recovery diagnostics. |
| Durable jobs | **PARTIAL** | Redis-backed job records, BullMQ queues, idempotency keys, reaper, startup recovery, and checkpoints exist. | Add explicit STOPPING/RECOVERING states, durable recovery claims, and stronger ownership semantics. |
| Validator source of truth | **BROKEN relative to specification** | `LinkBucketStore` stores records and bucket indexes in Redis; no Mongo link schema is present. | Create canonical Mongo link records with uniqueness and transaction-safe transitions. |
| Validator state machine | **PARTIAL** | Main, validating, active, dead, and error movement exists with Redis leases. | Rename/normalize Processing, add full lease fields, enforce one canonical state, and prohibit silent Active→Main movement. |
| Duplicate protection | **PARTIAL** | URL canonicalization and Redis-key deduplication exist. | Add database uniqueness on normalized URL and merge duplicate source metadata safely. |
| Processing recovery | **PARTIAL** | Redis claim lock, validation token, stale guard, and job requeue exist. | Store worker/job/lease ownership on the link record and recover expired Processing records conservatively. |
| Validator workers | **PARTIAL** | Central sweep, five-link batches, one active validation job per session, and guard exist. | Add capacity-aware fair scheduling and structured per-session/resource backoff. |
| Rate-limit handling | **BROKEN relative to specification** | String classifier retires sessions for growth-lock/rate-limit phrases; all current validator sessions were retired live. | Use structured error classes, scope restrictions to affected sessions/resources, and avoid all-session retirement. |
| Panel isolation | **PARTIAL/UNSAFE** | Assignment/workspace authorization exists; panel commands are durable. | Replace dynamic socket-property fallback with explicit capability methods and per-user allowed session pools. |
| Control/work plane separation | **PARTIAL** | Panel broadcasts have worker-local inventory/checkpoints. | Remove synchronous long operations from request paths and isolate preview/media/validator resources. |
| Reverse proxy | **PARTIAL** | Live Nginx forwards `/workload/` with 90-second timeouts. | Add live/ready/worker/Redis health semantics, consistent timeout contracts, and explicit keepalive/body policy. |
| Redis usage | **RISK** | Redis carries business link state, jobs, indexes, locks, caches, and coordination; slowlog shows repeated scans. | Keep business truth in Mongo; use Redis for queue/cache/lease/coordination only; eliminate `KEYS` and repeated full scans. |
| Live dashboard | **PARTIAL** | Progress fields include current action and last result. | Derive counts from canonical records and expose processing/lease mismatch diagnostics. |
| Stress/failure validation | **MISSING for the rebuild** | Existing unit/regression coverage exists, but 5,000-link, multi-user, restart, and failure-injection acceptance has not been completed. | Add deterministic test fixtures and controlled fault injection before declaring done. |

## Root causes and their consequences

### Redis is carrying canonical validator state

The current `LinkBucketStore` writes a JSON link record to a Redis key and separately updates Redis sets for each bucket. The update is not a database transaction. A process failure between the record write and set-index updates can produce missing or stale indexes. A concurrent writer can read the same record and overwrite a newer state. Reconciliation repairs some index inconsistencies, but it does not provide a durable transition log or prove that exactly one writer owns a Processing record.

The current snapshot counts `SCARD` values from Redis sets. Consequently, the displayed numbers are projections of Redis index health, not authoritative counts of canonical records. This directly explains why Main/Active can appear to move unexpectedly under retries, cleanup, requeue, or Redis index drift.

### The validator scheduler is globally coupled

The admission sweep reads global Main, finds healthy sessions across all workspaces, and creates jobs under the global validator scope. This is compatible with an admin-owned master validator, but it is not sufficient for user-scoped validation. The current record does not contain a durable owner user, validator job ID, worker ID, or explicit allowed session pool. A future panel user can therefore be authorized at the workload layer while validator state remains globally shared.

### Broad rate-limit text causes validator starvation

`isInviteValidationRateLimited` matches phrases including growth-locked, rate-limit, 429, flood, throttle, spam-limit, temporary ban, and try again later. The guard then retires a session for fifteen minutes, and repeated failures can retire it again. This is a plausible policy for a confirmed session-level restriction, but it is not proof that the WhatsApp account itself is restricted. A worker timeout, server response, or resource error containing one of those words can produce the same retirement behavior. The live state confirms the operational consequence: every ACTIVE/VALID validator session was retired.

### Background work shares session and control resources

Bulk posting obtains a per-session operation lock around delivery and retries, while inbound message handling can resolve media and start link collection/validation. Panel transport calls synchronously queue a bridge command and wait for completion. The system has separate queues, but not a complete priority scheduler that guarantees session events and interactive commands ahead of preview, validation, joins, and bulk posting. Redis scans, synchronous preview/media calls, and full group inventory calls remain resource competitors.

### Recovery is implemented but not yet a complete durable protocol

The job reaper and startup recovery can reschedule records whose Bull job is missing or whose heartbeat is stale. However, the job contract does not include the specification’s explicit STOPPING and RECOVERING states, and recovery is still coordinated with Redis claims and process-local waiters. The session lock itself is not represented as a durable record with owner/job identity. This makes it difficult to prove whether a reported ghost lock is a crashed worker, an expired Redis lease, a stale job, or an actual busy session.

## Migration design

### Phase A — Session supervisor safety

Introduce an explicit persisted supervisor record or extend the session record with `supervisorOwnerId`, `supervisorGeneration`, `socketState`, `lastHeartbeatAt`, `lastEventAt`, `lastReceiveAt`, `lastSendAt`, `reconnectAttempt`, `reconnectStartedAt`, and `supervisorLeaseExpiresAt`. Keep the existing lifecycle module as the in-process state machine, but require every transition to pass through a structured transition function that records reason and generation.

Replace the presence heartbeat as the default health proof with passive connection/event evidence and a bounded safe probe only when the socket library provides one that does not create unnecessary account traffic. Keep one socket generation per session and reject stale event handlers whose generation no longer matches the active runtime. Add a bounded reconnect policy with jitter and a supervisor-level circuit breaker so repeated failures do not create reconnect storms.

### Phase B — Control/work plane boundary

Keep Telegram, admin APIs, authentication, job creation, and health endpoints in the control plane. Move validator execution, group inventory, preview hydration, media transformation, and bulk delivery to the worker plane. Every long operation must create or update a durable job and return a job identifier; HTTP waiters may subscribe or poll but must not own the operation.

Define separate request budgets for command acknowledgement, job creation, progress update, and worker command completion. Align Nginx timeouts with those contracts. Add `/health/live`, `/health/ready`, `/health/worker`, and `/health/redis` with clear semantics. A Redis or worker failure must make readiness false or degraded without purging WhatsApp auth or sessions.

### Phase C — Durable validator records

Create a Mongo `ValidatorLink` model with a unique normalized URL and fields equivalent to:

`linkId`, `normalizedUrl`, `originalUrl`, `state`, `workspaceId`, `ownerUserId`, `sourceSessionId`, `firstSeenAt`, `lastSeenAt`, `validatedAt`, `validationAttempts`, `lastError`, `lastErrorClass`, `validatorJobId`, `workerId`, `sessionId`, `lockOwner`, `lockExpiresAt`, `createdAt`, and `updatedAt`.

Use a state transition function that performs conditional updates: `MAIN → PROCESSING` only if the current state is Main and no unexpired lease exists; `PROCESSING → ACTIVE/DEAD/ERROR` only if the job and lease owner match; expired Processing returns to Main or Error according to retry policy. Active, Dead, and Error must not move to Main automatically. Revalidation must first create a new Processing attempt and then transition to the result.

Use Mongo as canonical state and counts. Redis may cache snapshots, coordinate a short lease, and carry queue entries. During migration, read Redis records in bounded pages, insert missing Mongo records with deterministic conflict handling, compare Redis and Mongo counts, and only remove legacy Redis state after a verified parity report and a rollback checkpoint exist.

### Phase D — Validator scheduler and worker isolation

Replace full Main scans with a durable query for eligible Main records ordered by `createdAt`/priority and indexed by state, owner, and next-attempt time. Assign work through a scheduler that considers worker capacity, session capacity, current session operation, cooldown, restriction status, and per-user policy. Use a per-session lease and a per-user/job lease; never use one global validator lock.

Represent validation errors with structured classes: `NETWORK_ERROR`, `TIMEOUT`, `SOCKET_ERROR`, `AUTH_ERROR`, `WHATSAPP_RESTRICTION`, `PERMISSION_ERROR`, `INVALID_LINK`, `NOT_FOUND`, `REQUEST_REQUIRED`, `ALREADY_JOINED`, `TEMPORARY_ERROR`, and `INTERNAL_ERROR`. Only a confirmed session-level WhatsApp restriction should retire a session. A worker timeout or Redis error must not be shown as a WhatsApp restriction.

### Phase E — Panel/user isolation

Every validator job must include `userId`, `jobId`, `workerId`, `allowedSessionIds` or a policy reference, and result ownership. The central scheduler must validate that the requested session belongs to the job’s allowed pool. User-scoped buckets and admin/master buckets must be separate namespaces in Mongo. Aggregate admin views may read across scopes but must not silently rewrite user-owned records.

Replace the panel proxy’s dynamic alphanumeric fallback with an explicit capability map. Each capability should declare whether it is read-only, messaging, group mutation, profile mutation, or session control. Authorization must be checked before queueing, and destructive capabilities must require a separate confirmation token or command policy.

### Phase F — Dashboard, logs, and reconciliation

The live Validator Hub should read canonical counts and expose `MAIN`, `PROCESSING`, `ACTIVE`, `DEAD`, and `ERROR`, plus job ID, link ID, worker ID, session ID, user ID, attempt, result, error class, and duration. Refresh should edit the existing message. A reconciliation worker should detect duplicate normalized URLs, impossible state/index mismatches, expired Processing leases, orphaned jobs, orphaned locks, missing ownership, and counter differences. Repairs must be conditional, logged, and never move Active to Main without an explicit revalidation or retry policy.

## Safe implementation order

1. Add structured audit events, transition reasons, and non-destructive diagnostics.
2. Harden session generation checks, heartbeat classification, reconnect deduplication, and lock metadata.
3. Eliminate orphaned diagnostic processes and add process/resource observability.
4. Add Mongo validator schema and migration/parity tooling without switching reads yet.
5. Implement conditional Mongo transitions and dual-read comparison.
6. Switch validator admission and dashboard counts to Mongo truth behind a feature flag.
7. Replace broad rate-limit retirement with structured classification and per-session cooldown.
8. Enforce capability-based panel transport and explicit user/session ownership.
9. Add bounded stress fixtures and failure injection.
10. Switch off legacy Redis bucket writes only after parity and rollback checks pass.

## Acceptance gates

No production declaration should be made until all of the following are demonstrated with recorded evidence: ordinary restart preserves healthy sessions without pairing; one session failure does not alter another; stale session and job leases recover; Active does not silently return to Main; duplicate normalized links collapse into one canonical record; 5,000-plus link fixtures preserve state and counts; concurrent users and sessions remain isolated; control-plane commands remain responsive during validation and media load; Redis failure does not purge sessions; worker restart recovers jobs; and the live dashboard matches canonical database counts.

The current implementation is therefore **not ready for the implementation-complete claim**. The audit has produced enough evidence to begin Phase 7, but Phase 7 must be implemented incrementally and verified at each gate rather than released as a single broad rewrite.

## Local evidence references

- [Session lifecycle baseline](./validator-session-scale-rebuild-baseline-20260823.md)
- [Validator transition matrix](./validator-transition-matrix-20260823.txt)
- [Canonical session domain type](../src/types/domain.ts)
- [Session lifecycle implementation](../src/whatsapp/session-lifecycle.ts)
- [Session manager](../src/whatsapp/session-manager.ts)
- [Validator bucket store](../src/links/link-bucket-store.ts)
- [Validator operations](../src/links/validator-operations.ts)
- [Validator runtime](../src/jobs/runtime.ts)
- [Job orchestrator](../src/jobs/job-orchestrator.ts)
- [Workload transport](../src/whatsapp/workload-transport.ts)
- [Workload service](../src/workload/service.ts)
- [Mongo persistence](../src/persistence/mongo.ts)
- [Supplied rebuild specification](../../upload/OMEGA_MINI_Validator_Session_Scale_Rebuild.txt)

## Implementation and deployment evidence from this pass

The first safe implementation slice is now deployed. It includes socket-generation guards so stale Baileys sockets cannot process events, overwrite credentials, or close a newer socket; corrected lifecycle heartbeat age telemetry; passive heartbeat checks by default with presence probes opt-in; a durable Mongo `ValidatorLink` schema with unique `(scopeId, normalizedUrl)` protection and conditional claim/complete/recovery APIs; a disabled-by-default `VALIDATOR_DURABLE_DUAL_WRITE` parity flag; explicit panel transport capability allowlisting including the existing group-request method; panel-aware job recovery queue selection; and SCAN-based legacy validator-key migration instead of Redis `KEYS`.

The durable validator model is registered during startup, but **dual-write remains disabled by default**. No live Redis bucket data was migrated, deleted, or switched to Mongo truth during this pass. This is deliberate: migration requires a parity report, rollback checkpoint, and controlled production window.

The expanded local verification completed successfully:

| Check | Result |
|---|---:|
| Regression files | 19 |
| Regression tests | **173 passed** |
| TypeScript no-emit check | Passed |
| Production build | Passed |
| Worker artifact build | Passed earlier in the same pass |
| 5,000-link deterministic validator fixture | Passed |
| Git whitespace check | Passed |
| Latest diagnostic probes remaining | None |

The control-plane dist was deployed with a timestamped remote backup and only `pappy-omega-mini.service` was restarted. The first health request raced the startup window and failed to connect; service logs then showed a clean start, the workload listener bound successfully, both persisted paired sessions reopened, and the next health check returned HTTP 200 with `ok: true`. The external `pappy-panel-v3.service` remained active and was not restarted. No WhatsApp message, group creation, join, broadcast, or destructive production validator action was performed.

The system is **not yet the final definition of done in the supplied specification**. Specifically, Mongo is not yet the active validator source of truth, panel-user validator ownership is not fully migrated, structured WhatsApp restriction/error codes are not yet complete, 5,000-link production workload and 50-user/100-session isolation tests have not been run against live services, and full failure injection for Redis/database/VPS/socket interruption remains outstanding. Therefore the accurate status is: **audit completed, first hardening slice implemented and deployed, rebuild still in progress; no claim of complete scale readiness is made.**
