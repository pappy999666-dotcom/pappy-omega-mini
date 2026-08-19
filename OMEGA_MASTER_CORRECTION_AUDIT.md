# Omega Master Correction Audit

**Source:** `omega_master_correction_prompt.txt`  
**Reference implementation:** `/home/ubuntu/omega-v1/artifacts/wa-bridge`  
**Current implementation:** `/home/ubuntu/pappy-omega-mini`  
**Audit date:** 19 August 2026

## Audit method

The correction prompt was read in full and compared against the actual Omega-v1 source, not only its menus. The most relevant Omega-v1 implementation areas were inspected: `telegram/handlers/session.ts`, `telegram/handlers/bucket.ts`, `services/join-manager.ts`, `services/validation-coordinator.ts`, `preview-engine/PreviewManager.ts`, `preview-engine/PreviewDispatcher.ts`, `preview-engine/PreviewResolver.ts`, and `preview-engine/PreviewCache.ts`. Current Pappy code was then checked across its session menu model, Telegram callbacks, WhatsApp router, job workers, link buckets, preview manager, session lifecycle, and tests.

> Functional parity is assessed at the execution-path level: UI → state → persistence → worker → real transport → classification → live state → restart behavior. A button or command is not counted as complete merely because it renders.

## Feature classification

| Correction-prompt area | Omega-v1 functional reference | Pappy current classification | Main finding | Priority |
|---|---|---|---|---|
| Session list and dashboard | Session list, status card, per-session controls, edit-in-place callbacks | **PARTIAL** | Pappy has a real session dashboard and isolated callbacks, but its session model is still flatter than Omega-v1’s functional account/group/pairing hierarchy. | P1 |
| Pairing and recovery | Native copy button, recovery-vs-new-pair distinction, saved-auth restoration, same-message updates | **REAL / PARTIAL** | Pappy has native copy buttons, encrypted auth, bounded recovery, and pairing notifications. Recovery path is real; pairing UX and post-pairing information remain less complete than Omega-v1. | P1 |
| Account submenu | Profile/PFP/name/bio operations with explicit real transport results | **PARTIAL** | Pappy supports profile, PFP, name, and bio paths, including HD/no-crop intent. Username capability and richer account submenu presentation are not fully implemented. | P1 |
| My Groups | Paginated group list, metadata, dedicated group submenu, invite/PFP/leave controls | **PARTIAL / REAL** | Pappy has group listing, pagination, group detail, invite, group picture, leave confirmation, and create-group actions. Search, role/permission metadata, locked state, and broader group settings are not fully represented. | P1 |
| Group controls | Real group settings and admin actions, hide unsupported controls | **PARTIAL** | Existing Pappy controls are real where implemented, but lock/unlock messaging, edit permissions, request settings, and richer participant/admin actions need capability-specific audit. | P1 |
| Create Group | Multi-step name/participants/bio/PFP, create confirmation, metadata, one-time promotion code | **PARTIAL** | Pappy creates a real group, applies description, obtains invite, and reports the actual JID. It does not yet provide the required one-time expiring admin promotion code and optional HD/no-crop PFP stage. | P0 |
| Session purge | Close socket, purge session state, locks, auth, DB/runtime records, preserve unrelated data | **REAL / NEEDS ACCEPTANCE** | Pappy has explicit purge cleanup across auth, jobs, links, traces, registry, and Join Result Store. Concurrent late-event and lock/listener cleanup needs dedicated acceptance coverage. | P1 |
| Join Manager target settings | Active source, target count/subset, delay, retry, mode, session, pause/stop/resume | **PARTIAL-TO-STRONG** | Pappy now has durable Join Result Store, complete bucket scan, mode-aware adapter, rate-limit stop, live counters, and settings. Selected-link/bucket target wizard, true concurrency setting use, and process-death cursor recovery remain incomplete. | P0 |
| Join Manager result classification | Durable claim/lease records, joined/skipped/failed/retry/rate-limited/session unavailable | **REAL FOR CURRENT SCOPE** | Pappy persists per-job/link/cycle outcomes and honestly reports unsupported request mode. It does not yet match Omega-v1’s claim lease/generation fencing model for all failure races. | P1 |
| AutoJoin | Validation coordinator feeds new active links into join manager with requested/joined distinction | **PARTIAL** | Pappy automatically collects and validates links and enqueues auto-join jobs. Distribution is health-aware, but coalescing, durable validator-to-join history, and dedicated request detection remain limited. | P1 |
| Validator Hub dashboard | Main hub can show activity; live monitor edits one message; return restores hub | **REAL / PARTIAL** | Pappy removed the unnecessary separate live-log design and renders live activity directly in the hub. Durable aggregate event history and richer activity persistence remain limited. | P1 |
| Validator worker | Per-session workers, claims, leases, stale-state recovery, session exclusion, immediate bucket transitions | **PARTIAL** | Pappy has BullMQ jobs, automatic collection, health-aware allocation, partial-failure reporting, and live progress. It lacks Omega-v1-style per-link validation lease/generation persistence and worker-backed validator history. | P0 |
| Validator input | Dedup, streaming/chunked ingestion, large-safe processing | **REAL FOR CURRENT SCOPE** | Pappy has URL deduplication, streaming Telegram text-file decoding with a 10 MB guard, and automatic WhatsApp collection. HTML is treated as text and full “unlimited” ingestion remains bounded by safe resource limits. | P1 |
| Active HTML export | Responsive cards, metadata, statistics, search/filter, asynchronous large generation | **PARTIAL** | Pappy now has uncapped responsive HTML cards with titles, URLs, status, members, duplicate counts, and timestamps. It lacks search/filter controls and a worker-backed asynchronous export job. | P1 |
| Link preview architecture | One universal dispatcher, URL detector, metadata preservation, multi-stage resolver, thumbnail cache, fallback | **PARTIAL / HIGHEST RISK** | Pappy has a Redis PreviewManager with canonicalization, timeout, TTL, fallback, and host circuit-breaker behavior, plus native `richPreview` flags. It does not yet use Omega-v1’s full shared outbound dispatcher for every command/media/status path, nor preserve complete incoming preview metadata through a reusable resolver. | P0 |
| Preview cache | TTL/LRU metadata, raw/normalized/HQ thumbnail caches, URL normalization | **PARTIAL** | Pappy caches durable preview records in Redis and protects against unsafe hosts. It lacks Omega-v1’s multi-layer thumbnail/HQ cache and in-flight deduplication for thousands of recipients. | P0 |
| Preview failure isolation | Bounded resolution, fallback sends, campaign-level resolve-once, per-recipient isolation | **PARTIAL** | Pappy has timeout/circuit-breaker fallback at the PreviewManager level and bounded workers. The send helpers still mostly rely on native Baileys preview flags instead of routing every URL through one explicit resolver. | P0 |
| Quoted messages | Shared resolver for text/image/video/audio/document/sticker/caption/metadata | **PARTIAL** | Pappy merges quoted text and carries real image/video media into queued jobs through persisted references. Audio, document, sticker, complete quoted metadata, and one universal resolver are missing. | P0 |
| GSTATUS/GSTATUSX | Shared preview send, media, quoted payloads, count semantics, quiet output | **PARTIAL** | Pappy keeps GSTATUS immediate by product decision and supports quoted text, count, and text posting. Media+caption, URL resolver integration, and complete shared behavior are incomplete. | P0 |
| ALLSTATUS/ALLCHAT/X variants | Durable jobs, repeat-per-target semantics, safe pacing, cancellation, progress, recovery | **PARTIAL-TO-STRONG** | Pappy has real BullMQ jobs, short job codes, Live Show, sequential pacing, soft failures, and image/video references. Durable per-target result records, audio/document/sticker, adaptive delay, and stale-job reaping remain incomplete. | P0 |
| Live Show | Short copyable code, same-message refresh, blockquote stats, stop controls | **REAL** | Pappy has workspace-scoped job codes, copy buttons, same-message live rendering, refresh, and progress counters. Detailed per-target historical reports remain limited. | P1 |
| Session stability | Cohort recovery, reconnect leases, bounded runtime stores, stale cleanup, isolated sockets | **PARTIAL-TO-STRONG** | Pappy has bounded startup recovery, heartbeat, session lock, reconnect classification, stale-socket handling, encrypted auth, and PM2 process isolation. It does not yet have Omega-v1’s per-session bounded runtime-store architecture or full reconnect-leasing/chaos test suite. | P0 |
| No-regression rules | Preserve auth, fields, working paths, unrelated services, and real error states | **REAL WITH CONTINUED RISK** | The current deployment preserved sessions/storage and kept omega-core/omega-test online. Every new correction must retain exactOptionalPropertyTypes safety, workspace isolation, and no false-success output. | P0 |

## Omega-v1 behaviors worth refurbishing, not cloning

Omega-v1’s strongest reusable behavior is architectural rather than visual. The Join Manager uses durable claims, leases, generation fencing, per-session eligibility, retry classification, session exclusion, recoverable jobs, and subscriber-driven live updates. The Validator coordinator uses independent per-session workers, stale-state recovery, immediate result moves, and event/activity buffers separate from Telegram rendering. The preview engine has one universal send entry point, explicit stage routing, complete-preview passthrough, partial-preview enrichment, cache layers, broadcast resolve-once behavior, and plain-text fallback after preview failure.

Pappy already has better tenant isolation and a cleaner compact Telegram/WhatsApp presentation than the Omega-v1 card style. The correction work should therefore import **functional depth** into Pappy’s existing design rather than copying Omega-v1’s UI or replacing Pappy’s current callback architecture wholesale.

## Highest-priority correction sequence

1. **Unify outbound URL handling through a reusable Pappy preview pipeline.** Preserve complete incoming previews, enrich only missing fields, resolve WhatsApp group/channel links through the socket, cache normalized metadata/thumbnails, resolve once per mass campaign, and fall back to plain text without failing unrelated work.
2. **Complete shared quoted-message/media resolution.** Normalize quoted text, captions, image/video/audio/document/sticker payloads and metadata into one transport-neutral object, then use it for immediate commands and background jobs.
3. **Finish Join Manager target configuration and recovery.** Add explicit source bucket/subset/session-selection state, persist a resumable cursor/claim lease, make concurrency and repeat counts affect the worker, and expose per-session statistics.
4. **Complete Validator durable coordinator behavior.** Add per-link validation claims/leases/generation fences, immediate event persistence, stale-state recovery, and controlled multi-session workers without consuming a user session unpredictably.
5. **Finish Create Group.** Add optional no-crop PFP, actual metadata confirmation, and a single-use expiring admin promotion code with native copy control.
6. **Add mass-job per-target result records and stale-job reaping.** Persist every repeat attempt, support safe restart/resume, clean media references, and maintain worker heartbeat.
7. **Move large exports into real `link-export` jobs.** Preserve the responsive HTML design, add search/filter/statistics, and expose short job-code Live Show progress.

## Phase-1 conclusion

The new correction prompt materially raises the standard beyond the previous audit. The existing release closed several P0 gaps, but the **shared preview pipeline**, **full quoted-media resolver**, and **Omega-v1-style durable validation claims** remain the most consequential unfinished paths. Implementation should begin with those backend seams rather than adding more menu buttons.

## References

1. [Omega-v1 reference repository](https://github.com/pappy999666-dotcom/omega-v1)
2. [Pappy Omega Mini repository](https://github.com/pappy999666-dotcom/pappy-omega-mini)
3. `omega_master_correction_prompt.txt`, supplied by the user.
