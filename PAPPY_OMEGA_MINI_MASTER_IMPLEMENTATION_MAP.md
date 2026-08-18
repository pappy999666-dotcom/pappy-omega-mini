# Pappy Omega Mini — Master Implementation Map

## Purpose

This document is the active delivery map for the attached Master Implementation Prompt. It replaces feature-by-feature interpretation with one dependency-ordered program. The repository is treated as an existing production foundation: healthy behavior is preserved, current sessions are not purged, and no UI is considered complete unless its backend operation, persistence, authorization, queue behavior, progress, failure path, audit record, and tests exist.

## Current state classification

| Domain | Classification | Evidence | Completion dependency |
|---|---|---|---|
| Telegram visual system and authorization primitives | Partial / real foundation | Central UI primitives, blockquotes, styles, owner gates, session isolation | Preserve while replacing placeholder routes |
| Pairing wizard | Partial, recently corrected | Label → phone → native pairing-code state machine exists; persistence and durable conversation state remain incomplete | Durable state, duplicate-attempt protection, lifecycle notifications |
| Force Join | Missing | No target repository, membership verification, or `/start` gate | Database/repository and Telegram membership adapter |
| Session registry | Partial | Workspace/session ownership exists in memory | Durable repository, migration, state events, session locks |
| Baileys transport lifecycle | Partial | Encrypted auth store, socket lifecycle, reconnect helper, text routing | Capability adapter, distributed lock, durable runtime state, graceful shutdown |
| Per-session Telegram operations | Mostly placeholder | Several actions return generic guided-input/feature text | Application services and Baileys adapters |
| WhatsApp command registry | Partial / misleading | Registry exists, but profile/group commands return readiness text and mass commands are absent | Central metadata registry plus transport adapters and queue services |
| Quoted messages/media | Missing | Router has shallow text fallback only | Message normalization and media resolver |
| Group/profile operations | Missing or capability-unknown | No general adapter/service boundary | Capability detection and Baileys adapter |
| Join Manager | Partial | Queue worker and active-bucket input exist | Rich settings, idempotency, retry classification, progress and audit |
| Link intake/buckets | Partial | Redis bucket store and dedupe foundation exist | Telegram/WhatsApp/file/forward collectors and exports |
| Validator | Placeholder worker | URL parsing currently moves records to Active without WhatsApp verification | Verification adapter, worker classification, error/retry state |
| Live validator view | Partial UI | On/off/refresh lifecycle exists; worker metrics are incomplete | Real progress fields and live job state |
| Global user bridge | Partial | Session selection and direct registry fan-out exist | Queue-backed execution, confirmation, cancellation, audit |
| Global sudo | Missing | No persisted workspace sudo policy | Permission repository and inheritance |
| allstatus/allchat/tag/broadcast | Missing real execution | Job kinds exist, but real Baileys outbound workers are absent | Transport adapter, bounded worker, idempotency, stop commands |
| Scheduler/auto-promote | Missing | No durable schedule repository or scheduler worker | Persistence, quota, timezone, recovery |
| Preview manager | Partial foundation | Redis cache and host cooldown exist | Complete/partial preservation, hydration, SSRF controls, metrics, sender integration |
| Admin Jobs | Real first increment | Redis recent-job view, progress, cancel, audit are implemented | Extend same standard to every Admin panel |
| Admin Force Join/Users/Global Bridge/Master/Broadcast/Inbox/Audit | Placeholder or missing | Generic acknowledgement route remains for most actions | Repositories, services, callbacks, confirmations, progress |
| Admin media | Partial / real foundation | Upload and WhatsApp menu media selection exist | Durable metadata, dedupe, reuse across all senders |
| Audit and emergency mode | Partial | Audit/control-plane primitives exist; UI and persistence incomplete | Persistent audit repository and full action coverage |
| Data model/Mongo persistence | Missing as source of truth | Mongo is health-checked but domain state remains in memory/Redis/files | Schemas, indexes, migrations, repositories |
| Distributed safety | Partial | Local reconnect/backoff and queues exist | Per-session Redis locks, stale-job reaper, worker heartbeat |
| Deployment/doctor | Partial / real foundation | PM2, build, doctor, backups used | Bootstrap/migrations, no-manual-setup, health integration |
| Tests | Partial | Current suite covers UI/settings/workers/hardening | Unit/integration/e2e coverage for all acceptance-critical state machines |

## Integrated dependency order

### Gate P0 — Durable safety and tenancy

Completion requires durable User, Workspace, Session, Permission, SessionStateEvent, and PairingRequest repositories; workspace-scoped indexes; migration/bootstrap; per-session Redis locks using `workspace:{workspaceId}:session:{sessionId}:lock`; duplicate pairing protection; bounded reconnect; stale runtime detection; graceful shutdown; and explicit terminal-state handling. No mass operation is expanded before this gate passes.

### Gate P1 — Real onboarding and control plane

Completion requires Force Join targets and `/start` membership verification, the existing pairing wizard upgraded to durable conversation state, real session diagnostics, explicit destructive confirmations, and a real Admin Panel for Force Join, Users, Sessions, Jobs, Health, and Emergency Controls. Every visible callback must either execute a real operation or report a precise unsupported state.

### Gate P2 — Transport and command boundary

Completion requires a feature-oriented WhatsApp adapter layer over Baileys, capability detection, normalized inbound messages, quoted text/media/caption resolution, profile/group services, command metadata, permission policy, and real success/failure results. Unsupported Baileys operations must be reported, never simulated.

### Gate P3 — Durable operational workers

Completion requires real `allstatus`, `allchat`, `tag`, `broadcast`, `link-collection`, `link-validation`, `link-export`, and `join-manager` workers with idempotency keys, bounded concurrency, retry/backoff, cancellation, pause/resume where applicable, progress, queue pressure handling, and audit records. Stop commands must map to cancellation semantics rather than only changing a screen.

### Gate P4 — Validator, buckets, and previews

Completion requires all intake paths, canonical dedupe, Main/Active/Dead/Error/Master transitions, real validation classification without blind joining, TXT/HTML exports, metadata cards, live progress metrics, centralized preview integration, complete-preview preservation, partial hydration, SSRF protection, timeouts, cache reuse, circuit breakers, and safe fallback.

### Gate P5 — Scheduling and complete administration

Completion requires persisted user/admin schedules, Lagos timezone handling, quota enforcement, auto-promote, global bridge across authorized scopes, Master Bucket aggregation, user ban/unban, support inbox, Telegram broadcasts, audit search, analytics, and emergency controls that actually pause the relevant operation classes.

## Per-operation completion contract

Every Telegram callback must have a callback ID, authorization policy, input state, application service, repository writes, queue behavior if long-running, progress/result message, retry/terminal behavior, audit event, and tests. Every WhatsApp command must have parser metadata, permission rule, quoted-message behavior, payload handling, Baileys adapter call, queue policy, result message, cancellation path, capability requirement, and tests.

## Deployment gates

Before every production deployment, run typecheck, build, lint, unit tests, focused integration tests, doctor, secret checks, and session-isolation checks. Back up source/runtime configuration and never touch unrelated PM2 services. For a connected session, never wipe its encrypted auth store or silently change its identity. Verify `pappy-omega-mini` independently after restart and verify `omega-core` and `omega-test` remain online.

## Honest completion standard

Pappy Omega Mini is complete only when a user can pass force-join, create multiple isolated sessions, pair and recover through realistic reconnects, operate groups/profile/status/chat/tag functions through real adapters or precise unsupported results, ingest and validate links through durable workers, export buckets, use previews through every sender, schedule recoverable jobs, and use an Admin Panel that changes and reports system state. PM2 online, Redis PONG, a green menu, or “Owner Verified” do not satisfy this standard.
