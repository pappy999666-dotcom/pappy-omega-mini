# Pappy Bot Master Build & Correction — Compliance Audit

**Source prompt:** `Pappy_Bot_—_Master_Build_&_Correction_Prompt.md`  
**Reference:** `OMEGA_MASTER_CORRECTION_AUDIT.md`  
**Repository:** `pappy999666-dotcom/pappy-omega-mini`  
**Audit date:** 19 August 2026

## Scope reconciliation

The newly supplied master prompt repeats and broadens the previous correction requirements. Its most consequential architectural rule is that **session-specific state must remain inside the WhatsApp session**, while Validator Hub, user bridge, and user Auto Promote are user-global, and force-join, master buckets, user management, and owner controls are system-global.

The current correction increment therefore focused first on the highest-risk scope and execution paths instead of adding disconnected menu surfaces.

| Master-prompt requirement        | Current state after this increment             | Evidence / implementation                                                                                                                                                   | Remaining limitation                                                                                                          |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Session-specific prefix          | **Implemented**                                | `setprefix null                                                                                                                                                             | none` stores an empty prefix on the selected session. Workspace defaults no longer overwrite existing session prefixes.       | Workspace default remains available for newly created sessions. |
| Session-specific auto-join       | **Implemented for existing-session isolation** | Workspace default changes no longer mutate existing sessions.                                                                                                               | A fuller per-session settings migration UI is still possible for auto-join beyond the existing session action.                |
| Session-specific Join Manager    | **Implemented**                                | Added durable `SessionJoinSettings`, Mongo persistence, migration from legacy workspace defaults, per-session Telegram reads/writes, and per-session worker payloads.       | Selected-link UI is still less rich than the desired Omega-v1 target picker.                                                  |
| Session isolation                | **Implemented and tested**                     | Added regression proving two sessions in one workspace retain independent Join Manager settings.                                                                            | Multi-user live acceptance remains recommended.                                                                               |
| `.tag` exact payload             | **Implemented**                                | Non-numeric payloads remain unchanged, including repeated `.tag` tokens.                                                                                                    | Numeric participant selection is bounded at 1,000 to protect transport safety.                                                |
| `.tag <count>`                   | **Implemented**                                | Numeric count is passed to real hidden-mention transport; no raw participant identifiers are rendered.                                                                      | WhatsApp platform limits and group membership availability still govern the final count.                                      |
| No-prefix mode                   | **Implemented**                                | `setprefix null` and `setprefix none` both produce prefixless command routing.                                                                                              | No-prefix mode should receive a live WhatsApp acceptance check after deployment.                                              |
| GSTATUS media and quoted payload | **Implemented in code path**                   | Shared quoted resolver and immediate media-aware GSTATUS transport preserve caption/media and repeat semantics.                                                             | Requires owner-approved live send smoke test.                                                                                 |
| ALLSTATUS / ALLCHAT media        | **Implemented for supported media model**      | Durable media references now carry image, video, audio, document, sticker, filename, MIME, caption, and PTT state.                                                          | Per-target result ledger and asynchronous export remain separate gaps.                                                        |
| Shared link preview              | **Implemented in code path**                   | Universal outbound preparation, complete-preview preservation, partial enrichment, safe redirects, cache/in-flight dedupe, timeout, fallback, and media-caption safeguards. | External-host matrix and live WhatsApp preview verification remain recommended.                                               |
| Large-account behavior           | **Partially implemented**                      | Queues, bounded workers, pagination/caching seams, safe pacing, and heartbeat recovery exist.                                                                               | Validator claims/leases and mass-job per-target ledgers are not yet equivalent to Omega-v1.                                   |
| Validator Hub                    | **Partially implemented**                      | User-workspace aggregation, automatic collection/validation, healthy session allocation, streaming file intake, live dashboard, and responsive export exist.                | Durable per-link leases/generation fencing and worker-backed asynchronous exports remain incomplete.                          |
| Create Group                     | **Partially implemented**                      | Real create, description, invite, and PFP transport exist.                                                                                                                  | One-time expiring admin-promotion code and redemption transport are not yet implemented.                                      |
| Auto Promote                     | **Partial / not accepted as complete**         | Durable scheduling and user/session job foundations exist.                                                                                                                  | A complete user-global Auto Promote wizard and all-status/all-chat scheduling surface still needs a dedicated implementation. |
| Force Join                       | **Partial**                                    | Admin force-join target records and callbacks exist.                                                                                                                        | Unlimited production-scale requirements and full validation-state UX need acceptance.                                         |
| Admin broadcast                  | **Partial**                                    | Queue/job and admin broadcast flows exist.                                                                                                                                  | Full Telegram media/document recipient ledger with retry dashboard remains incomplete.                                        |
| Session lifecycle                | **Strong but not chaos-tested**                | Encrypted durable auth, reconnect classification, bounded recovery, stale-socket handling, heartbeat, and session purge isolation exist.                                    | Live failure-injection and multi-session chaos tests remain recommended.                                                      |

## Verification snapshot

The implementation has passed strict TypeScript compilation and the final full repository regression suite. The latest run passed **52 tests across 7 files** with zero failed tests. The sandbox emits Redis connection-refused warnings because no local Redis server is running; these warnings do not cause test failures and production uses the configured Redis service.


## Implementation files in this increment

| File                                | Purpose                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/types/domain.ts`               | Adds `SessionJoinSettings` to the session model.                                                                              |
| `src/persistence/mongo.ts`          | Persists nested per-session Join Manager settings.                                                                            |
| `src/core/session-registry.ts`      | Migrates, reads, and updates session Join Manager settings; stops workspace defaults from overwriting existing session state. |
| `src/telegram/bot.ts`               | Uses session Join Manager settings in start, display, and mutation callbacks.                                                 |
| `src/telegram/ui.ts`                | Removes Join Manager controls from global workspace settings and points to per-session controls.                              |
| `src/whatsapp/command-registry.ts`  | Supports `setprefix null` and numeric TAG count semantics.                                                                    |
| `src/whatsapp/message-router.ts`    | Carries structured TAG count and complete media metadata to real transport.                                                   |
| `src/whatsapp/transport-adapter.ts` | Bounded hidden-mention selection and complete media delivery.                                                                 |
| `src/whatsapp/job-media-store.ts`   | Persists original filenames and PTT state for queued media.                                                                   |
| `src/jobs/runtime.ts`               | Restores complete media metadata in background workers.                                                                       |
| `tests/menu-and-media.test.ts`      | Adds no-prefix and numeric TAG regressions.                                                                                   |
| `tests/live-settings.test.ts`       | Verifies workspace-default/session isolation.                                                                                 |
| `tests/v2-hardening.test.ts`        | Verifies per-session Join Manager settings isolation.                                                                         |

## Release gate

No deployment should occur until the new full suite passes after the final commit. The deployment must preserve `.env`, session/auth storage, and unrelated PM2 services exactly as in the prior atomic deployment procedure.

## References

1. [Pappy Omega Mini repository](https://github.com/pappy999666-dotcom/pappy-omega-mini)
2. [Omega-v1 reference repository](https://github.com/pappy999666-dotcom/omega-v1)
3. `Pappy_Bot_—_Master_Build_&_Correction_Prompt.md`, supplied by the user.
