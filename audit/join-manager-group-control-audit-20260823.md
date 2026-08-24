# OMEGA-MINI Join Manager + Group Control Rebuild — First-Pass Audit

## Scope and safety boundary

This is an implementation audit against `OMEGA_MINI_JoinManager_GroupControl_Rebuild.txt`. No WhatsApp messages, broadcasts, joins, group creation, participant moderation, approval, rejection, or other destructive operations were executed during this audit. The findings below are based on repository inspection of the actual Telegram handlers, shared job runtime, Redis job store, and Baileys/panel transport adapter.

## Current architecture

The system already has a shared durable `JobOrchestrator` for `join-manager` jobs. A job record contains `jobId`, `jobCode`, workspace, optional session, payload, state, attempts, heartbeat/progress, cancellation state, and timestamps. Jobs are persisted in Redis, routed through BullMQ, and have startup/Inceptor recovery paths. This is a useful foundation and should be extended rather than replaced.

Local and panel sessions use the same higher-level `transport-adapter.ts` service layer. The panel socket allowlist already exposes the relevant low-level group/join primitives, including group inventory, invite inspection/acceptance/request, participant updates, group settings, and join-request list/update. This supports parity, but the current group-control and bulk-operation orchestration is not yet unified into durable service-level workflows.

## Join Manager findings

| Specification requirement | Current evidence | Assessment |
|---|---|---|
| Clean menu with Start/Pause/Stop/Live/Settings/Stats | Current keyboard offers Start/Pause/Stop, Edit Target, Edit Delay, Edit Batch, Full Settings, and Refresh Live View. | Partially implemented; UI is functional but not yet the requested hierarchy and has no dedicated Stats surface. |
| Delay 1–60 seconds, default 5 seconds | Workspace defaults currently use `defaultJoinDelayMs: 0`, `defaultJoinMode: "immediate"`; persisted settings and Telegram input clamp delay to 0–600 seconds. Runtime accepts 0–600, with min/max delay randomization. | Fails specification. Default and validation need correction. |
| Exact configured delay enforced | Runtime enforces `minDelayMs`/`maxDelayMs` between sequential attempts, but `requestMode: immediate` forces zero delay. | Partially implemented; semantics must be made explicit and bounded to the requested 1–60 seconds. |
| Configurable target/source/mode/retry/session | Target count, delay, retry, request mode, and session are passed into the job. Source is hard-coded to the shared Active bucket; no source-bucket setting is present. | Partially implemented. |
| No artificial rate limit | Runtime has `restrictionThreshold`, `rateLimitHits`, session cooldown, and stops after a configured number of classified rate limits. | Fails the specification’s wording unless classification and policy are separated: genuine WhatsApp restriction must be isolated, while internal queue/transport failures must never be called rate limits. |
| Full result classification | Current `join-operation.ts` returns success/already-member/request-required/rateLimited/error, then runtime collapses most failures into `failed`, `invalid-invite`, `rate-limit`, or `dead`. | Insufficient granularity for the required result taxonomy. |
| Request-to-join lifecycle | `groupRequestJoin` is called when request mode is selected and returns a `REQUESTED` result. | Initial request is supported; durable waiting/approval transition and explicit `REQUEST_SENT`/`REQUEST_PENDING` state are not yet modeled end-to-end. |
| Durable controlled queue | Shared orchestrator persists jobs and performs recovery. Join execution is sequential (`concurrency: 1`) and uses inline retry/sleep. | Durable base exists; bulk semantics, worker identity, lease fields, and adaptive concurrency are incomplete. |
| Live view without manual refresh | Join Manager UI has a `Refresh Live View` button. The underlying job progress is persisted, but the inspected surface is not yet proven to auto-edit without the user pressing refresh. | Fails acceptance criterion until live-update path is verified or implemented. |
| Accurate stats | Progress includes joined, requested, already-member, dead, failed, retrying, current link/action, and last result fields. | Partially implemented; queue depth, worker, elapsed time, retry state, and reliable ETA semantics need audit/extension. |

## Group retrieval and navigation findings

The transport adapter has a per-session cache, in-flight request coalescing, stale last-known fallback, timeout handling, and a panel `listGroupSummaries` path with fallback to `groupFetchAllParticipating`. It also recomputes admin metadata from full inventory when older panel workers omit role information. This is a sound base for scale and panel parity.

The Telegram Admin Groups renderer paginates at 20 groups per page, caches selected records for two minutes, and routes callbacks through an index. The per-group action then resolves the cached group or reloads the entire admin-group inventory. The current implementation lacks search and can still depend on shifting list indexes rather than a stable group JID in callback data. Refresh is explicit and the cache is not a durable per-session metadata store.

The per-group submenu currently exposes name, description, set/get picture, moderation, invite link, and leave. The requested structured Info/Moderation/Approvals/Members/Settings/Profile/Executor hierarchy is not present as a unified surface.

## Group control findings

The adapter exposes real operations for group participant roles, join approval mode, member-add mode, chat/info locks, ephemeral settings, invite revoke, participant blocking, join-request listing, and join-request approval/rejection. Handlers check current admin status through live group metadata before most mutations and protect the bot/self in the existing bulk moderation path.

However, the inspected Telegram handlers still execute bulk moderation and approval operations inline in the callback/text handler. Bulk moderation is capped at 500 participants, uses fixed batches and sleeps, and reports a final result in one message; it is not a durable controlled bulk job. Approval-by-country and approval-by-amount also run inline, with batch fallback to individual calls, fixed sleeps, and no persisted job/lease/recovery record. Reject-country, reject-all, reject-country-amount, reject-amount, member-country filtering/kicking, and Executor are not yet represented as a complete mirrored durable workflow.

The current Join Manager invalid-invite text still says “returned to shared Main for revalidation” in one runtime report even though the earlier monotonic-state correction now moves such records to Dead. This is a truthful-output defect to correct before new group-control work is deployed.

## Immediate implementation priorities

First, correct Join Manager settings and classification without changing live account behavior: set the documented default to 5 seconds, constrain accepted delay to 1–60 seconds for normal joining, remove misleading application-level “rate limit” terminology from internal failures, and model result classes explicitly. Second, extend the existing orchestrator with a shared operation contract for Join Manager and group bulk operations, including user/session/job/worker/link or participant identifiers, durable state, leases, progress, cancellation, recovery, and one-message live updates. Third, move approval/rejection/member moderation/executor operations behind that service layer. Fourth, replace index-only group selection with stable JID-backed cached metadata and add search/pagination without repeated full inventory fetches.

Destructive production verification remains blocked until the user explicitly approves an exact scope, target group/session, and maintenance window. Read-only inventory, metadata, capability, and job-state checks can be used during implementation verification.

## Verified Baileys and panel capability audit

The installed dependency is `@crysnovax/baileys` version `2.7.12`, and the panel worker declares the same version. The installed fork exposes `groupFetchAllParticipating`, `groupGetInviteInfo`, `groupAcceptInvite`, `groupParticipantsUpdate`, `groupRequestParticipantsList`, `groupRequestParticipantsUpdate`, `groupSettingUpdate`, `groupMemberAddMode`, `groupJoinApprovalMode`, `groupToggleEphemeral`, and `groupRevokeInvite`.

The installed fork does **not** expose `groupRequestJoin` in its group socket implementation. The control-plane allowlist contains a `groupRequestJoin` name, but the actual installed Baileys package and worker source do not implement that method. Therefore the current Join Manager request mode cannot honestly claim request-to-join support; it must report the capability as unsupported or implement a separately verified fork method before enabling that flow.

The installed fork returns participant-level status arrays for `groupParticipantsUpdate` and `groupRequestParticipantsUpdate`, but the current adapter discards those returned statuses and treats a resolved promise as success. This can produce false bulk success when WhatsApp returns per-participant errors inside a successful response. The adapter should preserve and classify those statuses before any durable operation reports completion.

The installed `groupFetchAllParticipating` makes one WhatsApp group inventory query and emits a groups update; this is preferable to one network request per group. The current adapter uses it as a fallback and maintains an in-memory per-session cache/in-flight coalescer. The panel path can use `listGroupSummaries` when available and falls back to the installed group inventory method.

The current Join Manager failure classifier is too broad: unknown errors default to `transport`, strings containing `invite` are treated as invalid invites, and several platform/internal failures are conflated with retryable transport. The requested taxonomy needs a domain classifier that uses structured status/error evidence where available and never labels queue, Redis, panel, timeout, or internal errors as WhatsApp restriction without platform evidence.

The current Join Manager runtime still has a stale user-facing message at `runtime.ts` lines 996–997 saying a dead-looking Active link was returned to shared Main for revalidation, although the monotonic validator correction now moves it to Dead. This must be corrected before the next deployment.

## Join Manager foundation changes completed locally

The first implementation slice now sets new and legacy all-zero workspace defaults to automatic 5-second Join Manager cadence. Normal session settings accept 1–60 seconds and preserve explicit Immediate mode only when the session explicitly selects `immediate`. Runtime delay is bounded to that contract, and the configured per-job concurrency is honored within a safe maximum of three workers.

Automatic execution no longer uses the configurable artificial restriction threshold to decide whether healthy sessions should stop. A classified WhatsApp restriction stops the current job after the affected link and applies the configured cooldown; internal, timeout, network, and permission failures are not labeled as WhatsApp restrictions.

Join Manager result persistence now has explicit outcomes for invalid links, expired links, unavailable groups, permission denial, real WhatsApp restrictions, network errors, timeouts, and internal errors. Only confirmed inaccessible link classes move an Active link to Dead. Permission, transport, timeout, and internal failures retain the canonical link in Active while recording their exact result classification.

Shared job records now persist a process-scoped worker identifier, lease token, and lease expiry. Job heartbeats renew the lease, and terminal completion records the expiry for truthful inspection and recovery diagnostics.

Focused typecheck and regression validation passed: 19 test files and 174 tests passed, including the updated default-cadence and explicit-Immediate compatibility tests. Redis connection-refused messages in local tests are expected because the deterministic test environment does not start production Redis.

## Group Control implementation slice completed locally

Group selection refresh now preserves an existing index-to-group cache entry until its two-minute TTL expires, preventing a refresh from rebinding an already-open action to a different group. The underlying adapter still revalidates live group metadata and admin status before mutations.

Participant and join-request adapter methods now inspect Baileys per-item response statuses. A resolved low-level request is no longer automatically reported as success when WhatsApp returned participant-level errors.

A new durable `group-control` job kind uses the shared orchestrator and mass-operation safety gate. It persists the selected group JID and participant identifiers, revalidates session readiness and administrator access, supports pause/cancellation, renews worker leases through the common job record, applies bounded sequential operations with a 350 ms inter-item delay, and reports partial progress. The Telegram flows for Approve All, approve-by-amount, approve-by-country, Reject All, reject-by-amount, reject-by-country, single promote/demote, and confirmed bulk remove/block/demote now enqueue this job rather than executing long inline loops.

Live Show now labels Join Manager and Group Control actions correctly and displays worker identity and lease expiry. The group detail surface has a functional Approvals entry point.

Typecheck and focused UI, transport, Telegram flow, and job tests passed after these changes: 19 test files and 174 tests. No WhatsApp mutation was executed.

Remaining Group Control scope is intentionally not claimed complete: member list/search/country-filter actions, a separate Executor workflow, richer stable-JID group navigation, and durable group-operation audit records still require implementation and verification.

## Member-country and Executor workflow slice

The Group Moderation screen now exposes a read-only Members submenu. It reports total, admin, and non-admin counts, shows a bounded participant preview, and offers Remove by Country, Block by Country, and existing capped Bulk Actions.

Country actions normalize a calling code, exclude administrators from the candidate set, show the matching participant preview, and require an explicit confirmation callback. Only after confirmation is a durable `group-control` job created. The worker revalidates administrator access, applies the protected participant action sequentially, and records partial progress. Pending country state is isolated from unrelated Telegram commands and callbacks.

The shared durable Group Control worker is the Executor for these operations. Existing administrator controls remain available through the moderation surface, including approval mode, member-add mode, disappearing messages, invite revocation, group subject/description, single-member promotion/demotion, and capped bulk operations. No WhatsApp mutation was executed during this implementation or test cycle.

Focused validation after the member-country workflow passed: typecheck, 19 test files, and 175 tests.

## Regression and deployment evidence

The complete local regression suite passed after the final implementation slice: 19 test files and 175 tests passed. `git diff --check`, TypeScript typecheck, and the production TypeScript build all passed. Expected local Redis `ECONNREFUSED 127.0.0.1:6379` messages remained confined to tests that intentionally run without production Redis.

The verified `dist` artifact was deployed with a timestamped remote backup. Only `pappy-omega-mini.service` was restarted; `pappy-panel-v3.service` was not restarted. The control process took several seconds to initialize, then exposed the expected health endpoint. Final read-only verification returned `ok:true`, `controlVersion:1`, `heartbeatIntervalMs:20000`, and package version `1.2.72`. Both systemd services were active, the remote staging directory was gone, no temporary deployment archive remained, and no fatal, syntax, TypeError, ReferenceError, or address-in-use error appeared after startup.

No live WhatsApp group mutation, join, approval, rejection, member removal, member blocking, broadcast, or group creation was performed. Production verification was limited to service health, process state, startup logs, and deployment cleanliness.
