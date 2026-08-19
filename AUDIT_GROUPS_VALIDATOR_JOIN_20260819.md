# Audit — My Groups, Validator Hub, Join Manager

## Reported failure matrix

| Area | Current finding | Omega-v1/reference comparison | Repair decision |
|---|---|---|---|
| My Groups | `listGroups()` calls `groupFetchAllParticipating()` without a timeout; the handler renders every group in one Telegram message with one button per group. A slow socket or large inventory can leave the callback at `Loading groups…`, and a large result can fail Telegram edit limits. | Omega-v1 paginates group inventory and handles loading, empty, missing metadata, refresh, and error states. | Add bounded transport timeout, safe paginated group listing, and explicit loading/error/empty states. |
| Validator Hub file upload | `collectLinksFromChunks()` correctly streams/deduplicates WhatsApp invite links into `main`, but the Telegram document handler never calls `enqueueValidatorJobs()`. A 5,000-link file therefore remains in Main indefinitely. | Omega-v1 collection flows feed the validation pipeline and expose live progress. | Auto-enqueue validation jobs for imported URLs using existing sharding/idempotency helper; report worker count and preserve Main when no session/runtime is available. |
| Validator Hub manual flow | `bucket:validate` is the only Telegram validation trigger. | Omega-v1 validation is a background capability, not a button-only dead end. | Keep manual callback for compatibility, but make file/text/WhatsApp collection automatically enqueue validation. |
| Join Manager settings | UI exposes settings callbacks, but the mutation block builds workspace-default patches first and then translates them to session settings. The visible controls are fixed cycles rather than free per-session editors; this is why the user experiences hard-coded settings. | Omega-v1 has interactive per-session controls and nested settings. | Replace quick cycles with real session-scoped input/edit controls for every setting while retaining safe bounds. |
| Already-member Join Manager result | `joinWhatsAppInvite()` returns `alreadyMember`; worker persists `ALREADY_JOINED` and returns `skipped`. `runBoundedBatch()` continues after skipped results. A single already-member link can therefore complete normally, and a job with only Main links can appear to stop immediately. | Omega-v1 treats already-member as a settled skip and continues; only rate-limit/session-unavailable states stop execution. | Preserve skip semantics, improve human-readable terminal status, ensure automatic validation promotes Main links to Active before Join Manager starts, and add regression coverage for continuation. |
| Large scale | Current Join Manager snapshots all workspace bucket records and creates all work items in memory. | Omega-v1 uses durable claiming and randomized traversal. | Immediate repair focuses on reported stop/validation behavior; randomized durable claim parity remains a separate follow-up increment. |

## Implementation order

1. Add transport timeout and pagination for My Groups.
2. Auto-enqueue Validator jobs after file and passive text collection, using existing sharding and idempotency.
3. Add real per-session Join Manager editors and persist through `updateSessionJoinSettings()`.
4. Add tests for file-to-validation scheduling, editable settings isolation, pagination/timeout, and already-member continuation.
5. Build, run all tests, compare the callback map again, then deploy atomically.

## Post-implementation comparison

The implementation now paginates My Groups at 20 rows per page, bounds the underlying `groupFetchAllParticipating()` call to 15 seconds, and renders a retryable error state instead of leaving a loading message permanently. File and passive Telegram link imports now call the existing `enqueueValidatorJobs()` helper, which shards URLs across active sessions and uses durable idempotency keys. Join Manager settings now open a per-session input editor for target, base/min/max delay, batch cycles, retries, retry backoff, cooldown, rate-limit threshold, concurrency, and mode; values are validated and persisted through `updateSessionJoinSettings()`.

The Join Manager worker already treats `alreadyMember` as a settled `skipped` item and `runBoundedBatch()` continues after skipped outcomes. The observed immediate completion is therefore explained by the pre-repair inventory: links were still in Main because the file import never scheduled validation, leaving little or no Active work for Join Manager. Automatic validation promotes valid invites into Active before the Join Manager is started.
