# KbDj Preview and Immediate Dispatch Fix — Release 1.2.62

## KbDj live finding

The actual panel-assigned session was tested through the control process with the KbDj and BnoEt URLs in serial and concurrent runs. Baileys continues to return `not-authorized` for KbDj and resolves BnoEt as `♡₊˚ KAWAII HAVEN ˚₊♡`. Despite the native lookup denial, the source-only fallback now returns KbDj-specific metadata:

- Matched URL: `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN`
- Canonical URL: the same KbDj URL
- Title: `Gc closed`
- Description: `Group chat invite`
- Thumbnail: source-specific digest `b745f27be2a188925af8449c2e0c5e441c806690fd2fd30ac899d4ebfb6ab113`

BnoEt received separate title and thumbnail values. No destination-group metadata was substituted for KbDj in either serial or concurrent resolution.

## Immediate-dispatch root cause

`message-router.ts` was performing a full `listGroups()` inventory scan before creating an `allstatus` or `allchat` job for non-panel sessions. That made the WhatsApp command wait on group inventory before it could acknowledge or enqueue the work. The worker runtime already had the correct inventory-resolution stage after durable enqueue, so the pre-scan was redundant and was the direct source of the visible delay/failure behavior.

## Fix

The pre-enqueue inventory scan was removed. Broadcast commands now create the durable job immediately and mark the result as `inventoryDeferred`. The worker resolves inventory after the job is accepted and reports live progress. Panel jobs retain their `workerLocal` path and are acknowledged as dispatching to the owning panel worker. Genuine job failures still surface through the existing job-progress and completion paths.

The acknowledgement now says `ALL-STATUS DISPATCHING`, shows the live code and configured delay, and states whether inventory is resolving in the worker or on the panel. It no longer claims `No broadcast was dispatched` merely because totals are not known at the moment of enqueue.

## Deployment verification

Release **1.2.62** is deployed. The control service is ACTIVE and reports package version 1.2.62. The test panel is ACTIVE and reports worker version 1.2.62 with a fresh heartbeat. The deployed router contains `inventoryDeferred` and no longer contains the old pre-enqueue `Unable to resolve WhatsApp groups before` path.

The focused regression suite passed **45/45**. The complete release gates passed strict typecheck, production build, worker generation, worker syntax validation, and **152/152 tests across 15 files**.

No mass broadcast was sent during validation. The real preview diagnostic exercised the active panel transport and the actual KbDj/BnoEt preview resolver; the dispatch fix was verified through the production enqueue contract and deployed artifact without posting to every group.

## Limitation

A WhatsApp client may continue displaying an already-sent generic card for an old message because that message is immutable. New messages generated through the current control/panel path now preserve KbDj’s source URL and source-specific metadata; the live diagnostic confirms this before send.
