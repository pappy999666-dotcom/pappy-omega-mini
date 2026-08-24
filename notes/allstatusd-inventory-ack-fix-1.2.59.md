# `.allstatusd` Inventory Error Fix — Release 1.2.59

## Root cause

The `.allstatusd` alias correctly mapped to the designed `dallstatus` command and correctly set `styled: true`. The failure happened afterward in the WhatsApp command acknowledgement layer.

For panel-assigned sessions, `message-router.ts` intentionally skips control-plane group inventory and submits the job as `workerLocal: true`. The owning panel worker is responsible for resolving its own groups after the job is accepted. Because the immediate enqueue result therefore contains only a job code and no control-plane `totalGroups`, the generic acknowledgement formatter interpreted the result as a failed inventory resolution and returned:

> All-status was not started: WhatsApp group inventory was not resolved. No broadcast was dispatched.

That message was false for panel jobs: the worker-local job had been accepted for dispatch, but the acknowledgement path treated the asynchronous panel inventory as a pre-dispatch failure.

## Fix

`EnqueueJobResult` now carries an explicit `workerLocal` marker. Panel worker-local results are acknowledged as accepted and dispatched to the owning panel worker, with the live code and delay shown while the worker resolves its own inventory. The original hard failure remains in place for genuine non-panel jobs where the control-plane inventory is required and unavailable.

The designed payload itself was not changed: `.dallstatus` and `.allstatusd` continue to send `styled: true` through the control-plane/panel boundary.

## Verification

The focused broadcast contracts passed **18/18**, including direct `allstatusd` styled-payload execution and the new panel worker-local acknowledgement regression. The complete release gates passed strict typecheck, production build, worker generation, worker syntax validation, and **149/149 tests across 15 files**.

Release **1.2.59** is deployed. The control service is ACTIVE and reports package version 1.2.59. The test panel auto-updated to worker version 1.2.59, remains ACTIVE, and still has the assigned test session with a fresh heartbeat.

A prior live inventory diagnostic against this assigned panel path resolved 59 groups and 9,419 members with zero zero-member groups. The final allstatusd correction was verified through the real control-plane code path and the panel worker artifact was updated; no mass all-group broadcast was sent during validation to avoid unsolicited posts to every group.
