# PAPPY OMEGA-MINI Hybrid Workload SaaS Rebuild

## Pre-Implementation Audit

**Audit date:** 20 August 2026  
**Repository:** `pappy999666-dotcom/pappy-omega-mini`  
**Audited baseline:** commit `830de7b` plus the current production two-VPS deployment  
**Status:** Audit complete; implementation of the attached rebuild specification has not started.

## Executive Verdict

The attached specification describes a **second product layer**, not a small menu feature. The current project already has a strong centralized Telegram control plane, a durable Mongo/Redis job system, Baileys session lifecycle management, per-session ownership fencing, and an internal main-to-worker bridge. It does **not** yet have the SaaS workload plane required by the specification: external worker registration, secure worker credentials, human-facing workload keys, worker heartbeat registry, user-to-worker assignments, workload mode, downloadable worker package, panel onboarding, worker version compatibility, or worker administration.

The current architecture can be extended safely. The correct strategy is to preserve the existing Telegram bot and Baileys runtime, add a narrowly scoped authenticated worker control channel, and introduce workload assignment as a persisted control-plane concern. The existing Redis bridge must not be exposed to user panels or reused as the external protocol because it has no worker identity, signed request envelope, replay protection, tenant authorization, or public registration lifecycle.

> No destructive implementation should begin until the current tree is checkpointed in Git and the baseline gates remain recorded as `typecheck: pass`, `tests: 103/103`, and `build: pass`.

## Baseline Evidence

| Area | Current evidence | Audit result |
|---|---|---|
| TypeScript | `tsc -p tsconfig.json --noEmit` exited `0` | Pass |
| Regression tests | 11 Vitest files, `103/103` tests passed | Pass, with noisy Redis `ECONNREFUSED` test stderr |
| Production build | `tsc -p tsconfig.json` exited `0` | Pass |
| Main Telegram bot | Single central Telegraf bot on owner VPS | Present and must remain central |
| Owner VPS worker | `PROCESS_ROLE=full`, `QUEUE_CONCURRENCY=16` | Present |
| Secondary worker | `PROCESS_ROLE=worker`, eight assigned sessions after the latest controlled expansion | Present internally |
| Internal worker bridge | Redis pub/sub RPC for worker-owned bridge commands | Present, internal-only |
| External worker package | No separate package, `index.js`, archive, or download route | Missing |
| Worker registry | No Mongo worker collection or heartbeat registry | Missing |
| Workload mode | No persisted ON/OFF setting or admin toggle | Missing |
| Workload keys | No display key or secure worker credential lifecycle | Missing |
| Worker assignment | No persisted user-worker assignment entity | Missing |
| Public control API | No HTTP/API server in `src` or `package.json` | Missing |

The test suite’s Redis connection warnings are an existing baseline issue rather than a test failure. They should be converted into deterministic test doubles or an explicit test Redis fixture during the implementation phase so the final acceptance report can distinguish expected infrastructure absence from real errors.

## Current Architecture Map

### Control Plane

The current application bootstrap in `src/index.ts` connects MongoDB, hydrates the menu media and session registry, starts the worker runtime, starts schedulers and moderator reconciliation on the full node, recovers owned sessions, and launches the single Telegram gateway. The worker role skips Telegram, schedulers, and moderator reconciliation. This is a valid owner-VPS/worker-VPS split, but it is still an **operator-configured internal split**, not a user-managed SaaS workload system.

The current control-plane module in `src/core/control-plane.ts` provides quotas, audit events, and emergency safe mode. It does not manage workers, workload mode, heartbeat, version compatibility, assignments, or panel authorization.

### WhatsApp / Baileys Plane

`src/whatsapp/session-manager.ts` preserves Baileys auth state in encrypted file-backed storage, acquires a Redis-backed per-session lifecycle lock, stamps `workerNodeId`, handles reconnect and logout classification, and marks sessions `ACTIVE`/`VALID` after transport readiness. This is the correct foundation for moving runtime execution without replacing Baileys.

The session placement mechanism currently uses environment-owned session lists plus distributed locking. It does not authorize a worker against a persisted assignment before allowing the worker to request or open a session. An external worker must be restricted to a signed assignment token and must never receive arbitrary session data.

### Queue Plane

BullMQ and Redis provide durable job records, idempotency, recovery, Inceptor maintenance, broadcast scheduling, Join Manager, Validator Hub, and worker ownership filtering. The current worker can release or skip non-owned internal jobs based on `PROCESS_ROLE`, `WORKER_SESSIONS`, and `EXCLUDED_SESSIONS`.

This queue is suitable for internal job execution, but it should not become the public worker registration protocol. A user panel needs authenticated control messages, worker heartbeat, assignment delivery, and session control. Those messages require explicit tenant and worker authorization rather than only a Redis queue membership assumption.

### Telegram UI

The dashboard contains Pair Number, Sessions, Validator Hub, Auto Promote, Global Bridge, Scheduled Jobs, Live Show, Settings, Support, Help, and Admin Panel. The session menu contains Overview, WhatsApp Tools, My Groups, Session Bridge, Validator Hub, Auto Promote, Join Manager, Health & Jobs, Session Settings, Reconnect, Access/Sudo, and Purge.

The admin panel contains Force Join, Global Auto Promote, Users, Media, Global Bridge, Global Jobs, Master Bucket, Inceptor, Clear All Jobs, Broadcast, Support Inbox, Audit Log, and Emergency Mode. It contains no workload mode, worker registry, worker health, panel key, download package, deployment guide, worker disable/re-enable, assignment inspection, or version management controls.

The pairing flow currently creates the session as soon as the user supplies a label and then requests a Baileys pairing code after the phone number is supplied. It has no workload-mode gate and no verified-worker selection step.

### Persistence

The Mongo layer currently contains users, workspaces, WhatsApp sessions, pairing requests, audit events, schedules, media, auto-promote configurations/runs, emergency state, support, force-join, and moderation collections. The session document already contains `workerNodeId`, `authHealth`, reconnect fields, and error fields.

The following control-plane entities are absent:

| Required entity | Current status | Required purpose |
|---|---|---|
| Worker registry | Missing | Worker identity, owner, version, capabilities, status, heartbeat, error state |
| Worker credential metadata | Missing | Store only a hash/reference, never the raw credential |
| Display workload key | Missing | Human-friendly five-digit identifier separate from authentication |
| Worker assignment | Missing | Authorized relationship between workspace/session and worker |
| Workload events | Missing | Registration, heartbeat, assignment, migration, disconnect, errors |
| Workload mode | Missing | Persisted owner setting controlling default placement for new sessions |
| Worker package version | Missing | Compatibility gate and update path |

### Packaging and Deployment

The project has one TypeScript application package and one Docker image that starts the unified `dist/src/index.js`. It has no worker archive, no standalone `index.js` package, no panel-neutral deployment guide, no package version endpoint, and no download handler.

The current Docker and PM2 deployment are appropriate for owner-controlled infrastructure but must not be copied wholesale to user panels. A user worker package must not include the Telegram token, admin secrets, Mongo credentials, owner-only controls, or the entire Telegram bot source.

## Requirement Gap Matrix

| Specification area | Current implementation | Gap | Priority |
|---|---|---|---|
| Full pre-change audit | Source and deployment audit performed; no checkpoint for this rebuild yet | Create a dedicated legacy checkpoint branch and audit artifact | P0 |
| One central Telegram bot | Existing single Telegraf bot | Preserve; external workers must not run Telegram | P0 |
| Workload ON/OFF | No setting | Add persisted workspace/owner workload mode with explicit migration policy | P0 |
| Owner VPS workload | Existing full node | Integrate as the default placement when mode is ON | P0 |
| External user worker | Internal worker role only | Build a restricted external runtime/package | P0 |
| Worker registration | None | Authenticated registration handshake and registry | P0 |
| Five-digit key | None | Collision-resistant display key plus separate secure credential | P0 |
| Heartbeat | Session-level health only | Worker-level heartbeat and reachability state machine | P0 |
| Worker assignment | Environment lists only | Persisted, tenant-scoped, auditable assignment | P0 |
| Pairing with workload OFF | Always local pairing path | Require verified active worker and offer Use This Panel | P0 |
| Multiple panels | None | Data model should support multiple workers per user | P1 |
| Admin worker controls | None | Disable, re-enable, disconnect, inspect, check, version policy | P0 |
| User workload menu | None | Add native dashboard section with Add Key, My Panel, Download, Guide, Status | P0 |
| Download package | None | Generate/version official worker package | P0 |
| Panel-neutral guide | README only for unified bot | Add Node.js panel deployment tutorial and env template | P0 |
| Secure transport | Internal Redis tunnel only | External worker needs authenticated TLS control endpoint or equivalent secure channel | P0 |
| Replay/key guessing protection | None for external workers | Hash credentials, rate-limit display-key lookup, nonce/timestamp/request IDs | P0 |
| Session authorization | Distributed lock and env ownership | Validate worker assignment on every session/control request | P0 |
| Baileys preservation | Strong existing runtime | Keep file auth, reconnect, media, group events, pairing semantics intact | P0 |
| Failure recovery | Internal worker restart recovery | Add external worker offline/reconnect/assignment recovery without purging session | P0 |
| Version compatibility | Package version only | Worker handshake and minimum-compatible-version policy | P1 |
| Observability | Session/job/bridge logs | Add worker registration, heartbeat, assignment, migration, and errors | P0 |
| Media/link previews | Existing centralized Baileys/Sharp pipeline | Ensure external worker has required media dependencies and no control-plane secrets | P0 |
| No unnecessary infrastructure | Redis/Mongo already required internally | Add only the minimal external control channel; do not expose Redis/Mongo | P0 |
| Existing UI/features | Broad current feature set | Add workload controls without replacing current menus/callbacks | P0 |
| Legacy panel/API cleanup | No active panel/API found in current tree | Record negative audit; preserve any historical code in Git before cleanup | P1 |

## Critical Architectural Risks

### 1. The Current Redis Bridge Is Not a Public Worker Protocol

`src/whatsapp/remote-bridge.ts` uses a shared Redis pub/sub channel and response keys. It is appropriate for the two controlled VPS nodes because both nodes are operated by the owner and connect through a private tunnel. It is not safe for arbitrary user panels. It has no external worker identity, signed request authentication, authorization lookup, replay protection, rate limiting, or tenant isolation beyond the session ID contained in the message.

The external worker protocol should therefore be separate from this internal bridge. The internal bridge may remain for owner-operated workers; the external protocol should use a minimal authenticated control channel, preferably outbound worker connections to the control plane so user panels do not require inbound firewall ports.

### 2. Workload OFF Must Not Delete or Corrupt Sessions

The specification requires graceful migration. Switching the mode must only affect new placement by default. Existing sessions should remain on their current worker until an explicit migration is requested or a defined reconnect policy moves them. Session auth files must not be copied continuously or deleted during a temporary worker outage.

### 3. Pairing Must Become Assignment-Aware

The current pairing flow creates a session and immediately asks the local runtime for a pairing code. When workload mode is OFF, the flow must first select a verified active worker, issue a scoped assignment, and only then allow the worker to start the Baileys session. The central bot remains the UI and must receive status/notifications from the worker.

### 4. Worker Credentials Must Be Separate from the Five-Digit Key

The display key is not a secret. The actual worker credential must be generated with high entropy, transmitted only during registration or explicit enrollment, stored as a hash/reference, rotated or revoked, and used for every authenticated control message. Display-key lookup must be rate-limited and must not reveal ownership or status to unauthenticated callers.

### 5. The External Worker Must Not Be a Copy of the Telegram Bot

The current application entrypoint bundles Telegram, Mongo hydration, schedulers, worker runtime, session recovery, and owner controls. The external package must be a smaller runtime containing only the worker protocol, assigned-session Baileys runtime, required media/preview dependencies, durable local auth state, and safe diagnostics. It must never receive the Telegram bot token or Mongo/Redis credentials.

## Proposed Safe Architecture

The implementation should use three explicit placement classes:

| Placement | Runtime | Registration | Session authorization |
|---|---|---|---|
| Owner VPS | Existing full Pappy process | Static owner deployment | `PROCESS_ROLE=full` plus internal ownership fence |
| Owner-operated worker VPS | Existing worker process | Static owner deployment | Internal worker session allow-list plus assignment fence |
| User panel worker | Downloadable restricted worker | Authenticated outbound registration | Signed/rotated worker credential plus persisted assignment |

The control plane remains the Telegram bot and Mongo persistence. A small authenticated worker control service should handle registration, heartbeat, assignment, worker status, and control messages. The worker should maintain an outbound authenticated connection and reconnect with backoff. The server must authorize every assignment and session operation by workspace, worker, and session.

The assignment lifecycle should be explicit:

`PENDING → VERIFIED → ASSIGNED → RUNNING → DEGRADED/OFFLINE → RECONNECTING → RUNNING`, with `DISABLED`, `REVOKED`, and `INCOMPATIBLE` terminal/control states as appropriate.

A worker outage should set worker and assignment health to `OFFLINE` or `DEGRADED`; it should not delete the session or auth metadata. When the worker returns and authenticates again, assignments should be replayed only after authorization and compatibility checks.

## Implementation Order After Checkpoint

1. Create a Git branch containing the current production implementation and preserve all untracked audit artifacts outside destructive changes.
2. Add worker/workload domain types and Mongo collections with indexes and additive migrations.
3. Add workload mode with default `ON` so existing behavior is unchanged for current users.
4. Add an authenticated outbound worker registration/heartbeat protocol.
5. Build the restricted external worker package with version and capability reporting.
6. Add user workload UI and panel deployment/download guide.
7. Gate new pairing only when workload mode is `OFF`; preserve existing sessions and define explicit migration controls.
8. Add admin worker registry, disable/re-enable, health check, assignment inspection, and version controls.
9. Add security, failure-recovery, migration, and package tests before production deployment.
10. Deploy in shadow/registration mode first, then enable workload OFF behavior only after acceptance tests pass.

## Audit Conclusion

The current bot is a viable foundation but does not yet satisfy the attached hybrid SaaS specification. The largest missing boundary is not Baileys or the current internal worker split; it is the **authenticated external worker control plane and its user/admin lifecycle**. Implementing only a download button or only a five-digit key would be unsafe and incomplete. The implementation must add the registry, credential, assignment, heartbeat, package, pairing gate, and failure recovery as one coherent system, while leaving the current Telegram and Baileys paths intact.
