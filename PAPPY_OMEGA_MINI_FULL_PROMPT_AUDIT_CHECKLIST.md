# Pappy Omega Mini — Full Master Prompt Audit Checklist

**Source of truth:** `Pappy_Omega_Mini_MASTER_IMPLEMENTATION_PROMPT.txt` supplied by the product owner.

**Audit rule:** A feature is not complete because a button renders, a callback returns acknowledgement text, PM2 is online, or a unit test covers only the presentation layer. Each item must have a real service/adapter operation, durable state where required, authorization, failure handling, observability, and focused tests.

## Non-negotiable architecture and safety

| ID  | Requirement                                                         | Evidence                                        | Status   |
| --- | ------------------------------------------------------------------- | ----------------------------------------------- | -------- |
| N1  | Preserve healthy WhatsApp auth and never purge on transient failure | Session lifecycle, deployment procedures        | TO AUDIT |
| N2  | No fake functionality; unsupported capability must be explicit      | Command registry, Telegram callbacks, adapters  | TO AUDIT |
| N3  | Durable state machines for multi-step interactions                  | Pairing, text/media input, schedulers, jobs     | TO AUDIT |
| N4  | Per-user/workspace/session isolation                                | Mongo repositories, Redis keys, authorization   | TO AUDIT |
| N5  | Bounded queues, retries, cancellation, backpressure, idempotency    | BullMQ workers and job records                  | TO AUDIT |
| N6  | External-system timeouts, duplicate-event handling, reconnects      | Baileys/Telegram boundaries                     | TO AUDIT |
| N7  | Security, privacy, abuse prevention, and compliance take priority   | SSRF, auth storage, rate limits, command policy | TO AUDIT |

## Telegram control plane and onboarding

| ID  | Requirement                                                                                             | Evidence                                | Status   |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| T1  | `/start` force-join gate                                                                                | Bot entry handler and target repository | TO AUDIT |
| T2  | Unlimited configurable force-join targets with ordering and enable/disable                              | Admin callbacks and persistence         | TO AUDIT |
| T3  | Membership checks and final Check Membership action                                                     | Telegram API adapter                    | TO AUDIT |
| T4  | Main menu: Help, Pair, Session, Groups, Create GC, My Groups, Join Manager, Validator, Bridge, settings | UI model and callback coverage          | TO AUDIT |
| T5  | Inline keyboards, pagination, confirmations, quoted/edited progress                                     | Telegram UI primitives and handlers     | TO AUDIT |
| T6  | Persisted text-input states with expiry and retry                                                       | Conversation-state repository           | TO AUDIT |

## Pairing and session lifecycle

| ID  | Requirement                                                                                                                                                        | Evidence                                                                                                    | Status         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------- |
| P1  | Label → phone → persisted session → native pairing code                                                                                                            | Pairing wizard, persisted request, native requestPairingCode; readiness correction deployed                 | PARTIAL        |
| P2  | Custom configured pairing code with compatibility handling                                                                                                         | 8-character configured code validation and native requestPairingCode; pairing transport correction deployed | PARTIAL        |
| P3  | Duplicate pairing protection and durable pairing request state                                                                                                     | Locks and PairingRequest repository                                                                         | TO AUDIT       |
| P4  | Explicit lifecycle: CREATED, WAITING_FOR_PHONE, PAIRING_REQUESTED, CODE_ISSUED, CONNECTING, CONNECTED, RECONNECTING, LOGGED_OUT, BANNED_OR_BLOCKED, ERROR, DELETED | Lifecycle state and persistence                                                                             | TO AUDIT       |
| P5  | Immediate Telegram and WhatsApp-side success notification where supported                                                                                          | Pairing notifier and outbound transport                                                                     | TO AUDIT       |
| P6  | Persist timestamps, retry count, disconnect reason, last healthy state                                                                                             | Session model/state events                                                                                  | TO AUDIT       |
| P7  | Safe reconnect, terminal-state purge only, graceful shutdown                                                                                                       | Session manager                                                                                             | BROKEN/PARTIAL |
| P8  | Live lifecycle dashboard and health diagnostics                                                                                                                    | Telegram UI and health service                                                                              | TO AUDIT       |

## Session center, profile, and groups

| ID  | Requirement                                                                        | Evidence                                     | Status   |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------- | -------- |
| S1  | Paginated isolated session list with status/phone/last seen                        | Telegram session list                        | TO AUDIT |
| S2  | Per-session profile, bridge, groups, diagnostics, safe reconnect, confirmed delete | Session menu/callbacks                       | PARTIAL  |
| S3  | PFP get/change/remove with photo buffer, HD/capability detection, no forced crop   | Transport adapter and Telegram media handler | PARTIAL  |
| S4  | Name/about get/set; unsupported username explicitly reported                       | Profile adapter                              | PARTIAL  |
| S5  | Paginated cached group inventory with invite links                                 | Group adapter/cache                          | PARTIAL  |
| S6  | Create GC wizard: name, bio, optional image, durable mapping                       | Group service and repository                 | PARTIAL  |
| S7  | Secure one-time hashed expiring admin promotion code                               | Promotion-code repository and verifier       | TO AUDIT |
| S8  | My Groups management and capability detection                                      | Managed group service                        | TO AUDIT |
| S9  | Confirmed Leave Group flow and local-state update                                  | Group adapter/callback                       | PARTIAL  |

## Permissions and WhatsApp command surface

| ID  | Requirement                                                                                                                                             | Evidence                                                                                                                                         | Status                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| W1  | Session sudo add/remove/list and explicit owner/sudo roles                                                                                              | Command registry and Telegram handlers                                                                                                           | PARTIAL                       |
| W2  | Global sudo persisted and inherited by existing/future sessions                                                                                         | Workspace settings/repository                                                                                                                    | PARTIAL                       |
| W3  | Prefix and no-prefix parsing without accidental execution                                                                                               | Router and settings                                                                                                                              | TO AUDIT                      |
| W4  | Registry metadata generates WhatsApp menu/help                                                                                                          | Command registry/menu renderer                                                                                                                   | PARTIAL                       |
| W5  | Minimum commands: ping, menu, pair, setsudo, setprefix, gstatus, allstatus, stopstatus, allchat, stopchat, tag, stoptag, allstatusx, gstatusx, allchatx | Central registry now contains all named commands; gstatus/gstatusx are real bounded workers and `.pair` reports the Telegram ownership boundary  | PARTIAL                       |
| W6  | Owner/self-message, participant, participantAlt, remoteJidAlt resolution                                                                                | Inbound normalizer                                                                                                                               | BROKEN/RECENTLY FIXED         |
| W7  | Unknown and unauthorized commands silent                                                                                                                | WhatsApp router                                                                                                                                  | COMPLETE/TEST                 |
| W8  | Quoted text/media/caption payload handling                                                                                                              | Message normalizer                                                                                                                               | PARTIAL                       |
| W9  | Real status/chat/tag operations with bounded queue/cancel/progress/audit                                                                                | gstatus/gstatusx, allstatus, allchat, tag use durable workers; complete payload/media coverage remains to audit                                  | PARTIAL                       |
| W10 | Explicit `.pair` ownership and authorization chain                                                                                                      | Owner-gated WhatsApp command directs pairing to Telegram so workspace ownership is preserved; WhatsApp-side account creation remains unsupported | PARTIAL / EXPLICIT LIMITATION |

## Validator, buckets, intake, exports, and live view

| ID  | Requirement                                                     | Evidence                               | Status         |
| --- | --------------------------------------------------------------- | -------------------------------------- | -------------- |
| V1  | Main, Active, Dead, Error, Master buckets with strict ownership | Bucket repository                      | PARTIAL        |
| V2  | Canonical normalized-link deduplication and source metadata     | Link collector/store                   | PARTIAL        |
| V3  | Text, forwards, TXT, HTML, large-batch intake                   | Collectors and Telegram media handlers | PARTIAL        |
| V4  | Async validation classification without blind joining           | Validator worker                       | BROKEN/PARTIAL |
| V5  | Retryable/non-retryable error state and bounded retry           | Validator worker                       | TO AUDIT       |
| V6  | TXT/HTML asynchronous exports                                   | Export worker                          | TO AUDIT       |
| V7  | Live edited progress with counts, rate, retries, workers, ETA   | Validator UI/metrics                   | PARTIAL        |
| V8  | Immediate ingest and queue when feature/session active          | Intake state machine                   | TO AUDIT       |

## Join Manager and bridges

| ID  | Requirement                                                              | Evidence                 | Status   |
| --- | ------------------------------------------------------------------------ | ------------------------ | -------- |
| J1  | Active Bucket-only source                                                | Join manager             | PARTIAL  |
| J2  | Bounded delay, concurrency, retries, cancellation, classification, audit | Join worker/settings     | PARTIAL  |
| J3  | Start/stop/pause/refresh/settings live same-message UI                   | Telegram callbacks       | PARTIAL  |
| B1  | General Bridge with explicit session targeting and workspace isolation   | Bridge service/callbacks | PARTIAL  |
| B2  | Per-session Bridge visible and real                                      | Session menu/handler     | PARTIAL  |
| B3  | Quoted/media/file forwarding where practical                             | Bridge payload adapter   | TO AUDIT |
| B4  | User-level scheduled Auto Promote with durable recurrence and quotas     | Scheduler                | TO AUDIT |
| B5  | Explicit repeat variants x with progress and cancel                      | Queue workers            | PARTIAL  |

## Preview pipeline and URL handling

| ID  | Requirement                                                         | Evidence                          | Status   |
| --- | ------------------------------------------------------------------- | --------------------------------- | -------- |
| R1  | Preserve complete native previews                                   | Preview manager and outbound path | TO AUDIT |
| R2  | Hydrate partial/missing previews with metadata/thumbnail            | Preview service                   | PARTIAL  |
| R3  | Cache reuse, timeouts, retries, circuit breakers, size limits       | Preview manager                   | PARTIAL  |
| R4  | SSRF/private-network protections and safe hostname validation       | Fetcher                           | PARTIAL  |
| R5  | URL detection across text, media, status, chat, tag, quotes, bridge | Delivery adapters                 | TO AUDIT |

## Admin, support, observability, and data model

| ID  | Requirement                                                                                                                                     | Evidence                     | Status         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------- |
| A1  | Real Admin: Force Join, Users, Global Bridge, Auto Promote, Master Bucket, Broadcast, Inbox, Sessions, Jobs, Audit, Health, Emergency, Settings | Telegram admin panel         | PARTIAL/BROKEN |
| A2  | Paginated users with ban/unban and session/job details                                                                                          | Admin service/repository     | TO AUDIT       |
| A3  | Queue-backed broadcast for text/media/docs with progress/cancel                                                                                 | Broadcast worker             | TO AUDIT       |
| A4  | Durable Support Inbox and owner replies                                                                                                         | Support repositories/routing | PARTIAL        |
| O1  | Structured redacted audit events for all critical actions                                                                                       | Audit service/repository     | PARTIAL        |
| D1  | Durable User, Workspace, Session, StateEvent, Permission, Pairing, Group, Bucket, Job, Schedule, Audit, Preview, Support entities               | Mongo schemas/indexes        | PARTIAL/BROKEN |
| D2  | Mongo source of truth, transactional/idempotent writes, indexes                                                                                 | Persistence layer            | TO AUDIT       |

## Deployment, security, testing, and handoff

| ID  | Requirement                                                                                                         | Evidence                | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------- |
| C1  | Doctor validates env, Mongo, Redis, Telegram, owner, encryption, storage, workers, PM2                              | `src/doctor.ts`         | PARTIAL  |
| C2  | Bootstrap/migrations and zero-manual-setup path                                                                     | Deployment scripts/docs | TO AUDIT |
| C3  | Strict auth, one-time tokens/codes, redaction, file limits, SSRF, rate limits, replay protection                    | Security modules        | PARTIAL  |
| C4  | Success/retryable/terminal/error state with safe diagnostics and correlation ID                                     | Services/UI             | TO AUDIT |
| Q1  | Unit/integration/e2e matrix from Prompt §33                                                                         | Tests                   | PARTIAL  |
| Q2  | Before/after deployment typecheck/build/lint/focused tests/doctor/isolation                                         | Deployment logs         | PARTIAL  |
| H1  | Architecture, env, doctor, queues, commands, capabilities, admin, buckets, previews, troubleshooting, recovery docs | README/docs             | TO AUDIT |
| H2  | Final handoff must distinguish preserved, completed, unsupported, tests, deployment, migration, owner input, risks  | Final report            | PENDING  |

## Dependency order

1. **P0:** Session safety, durable state, locks, pairing lifecycle, force-join, permission policy, transport boundary.
2. **P1:** Real onboarding, Admin Panel, diagnostics, confirmations, and capability detection.
3. **P2:** Normalized transport events, quoted/media handling, profile/group services, command registry.
4. **P3:** Durable outbound workers, validator, buckets, Join Manager, exports, and cancellation.
5. **P4:** Preview integration, scheduler, global administration, support, audit search, and documentation.

## Audit update policy

Every implementation change must update this checklist with evidence, tests, deployment status, and any explicit runtime limitation. A green PM2 status is never sufficient evidence of completion.
