# PAPPY OMEGA MINI Broadcast Dispatch Audit — 1.2.64

## Scope

This audit covers `.allstatus`, `.allstatusd`/`.dallstatus`, and `.allchat` from WhatsApp command parsing through durable enqueue, worker execution, panel dispatch, group inventory, checkpointing, progress reporting, and completion reporting.

## Root cause

The durable queue was not the primary source of the perceived delay. `message-router.ts` already persists the job and inserts the immediate-posting BullMQ record before returning to the WhatsApp command handler. The 1.2.62 change correctly removed the blocking foreground `listGroups()` scan, but introduced a user-visible acknowledgement that described the deferred inventory phase as `resolving on panel` or `resolving in worker`. That made a correctly accepted job look like it was waiting or not dispatched.

The panel worker also returned `broadcast.start` acceptance before its asynchronous target discovery completed. This is intentional and preserves command responsiveness, but the previous acknowledgement exposed the internal phase instead of a clean accepted receipt. A cold panel restart could additionally lose its in-memory last-known group list, causing totals to appear as zero until the socket inventory call completed.

The last known working pre-1.2.62 route synchronously scanned inventory for non-panel broadcasts, which produced exact totals but could hold the command handler for the duration of a WhatsApp group scan and could falsely prevent dispatch when inventory was temporarily unavailable. That behavior was not restored.

## Implemented architecture

The normal WhatsApp acknowledgement now renders `ALL-STATUS STARTED` or `ALL-CHAT STARTED` immediately. It contains the delay, durable live code, dispatch destination, and a direct instruction to open Telegram Live Show for live totals and completion. It no longer contains `resolving`, `calculating`, or a false `No broadcast was dispatched` message when the job has been accepted.

The panel worker now maintains an encrypted, atomically written inventory snapshot at `broadcast-inventory.json` under the worker data directory. The snapshot contains only group JIDs and a fetch timestamp. It is loaded during worker startup, reused while fresh, and refreshed through the existing coalesced inventory path. Snapshot persistence is best-effort and cannot block or abort the actual target-list result. Existing in-flight coalescing prevents concurrent broadcasts from creating duplicate inventory fetches.

When a fresh snapshot exists, `broadcast.start` can return its exact group total immediately while the delivery runner begins independently. On a cold start, acceptance still returns immediately and the runner performs the inventory fetch asynchronously. The user sees a clean accepted receipt; detailed totals appear only in the explicit live-progress view once the worker has them. A real transport or session failure remains visible as a genuine failure/waiting state.

Existing encrypted broadcast checkpoints and reconnect-aware resume behavior remain intact. Completed deliveries are not resent after a socket close; the runner pauses in `WAITING_FOR_SESSION`, obtains the reconnected runtime, and continues from `nextDelivery`.

## Validation

The complete local regression suite passed **154 tests across 15 files**. Strict TypeScript typecheck, production build, generated-worker build, and Node syntax validation passed. The deployed worker artifact hash was verified locally and remotely.

The control plane and panel are deployed on **1.2.64**. Both services are active. The active panel worker retained its assigned session. A non-sending live inventory diagnostic against that active panel session returned **57 groups**, **9,275 members**, and **0 zero-member groups**. The panel created the private encrypted inventory snapshot with mode `600`.

No all-group broadcast was sent during this audit because a 57-group test would create unsolicited messages. Existing controlled smoke evidence remains separate: self-chat completed in 2.598 seconds and a one-group status completed in 5.393 seconds. A new full post-1.2.64 broadcast still requires explicit approval before sending to all groups.

## Files changed for this audit

- `src/whatsapp/command-registry.ts`
- `src/jobs/runtime.ts`
- `tools/worker-runtime-source.mjs`
- `tests/broadcast-format.test.ts`
- `tests/high-scale-broadcast.test.ts`
- `src/config/env.ts`
- `worker-package/package.json`
- generated `worker-package/index.js`

No private release keys or signing material were added to the repository or deployment artifact.
