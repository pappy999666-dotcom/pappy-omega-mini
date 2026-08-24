# Panel dispatch reconnect incident — release 1.2.63

## Scope

The verified VPS test panel is worker `pappy-v3`, worker ID `3d45149e-a536-42b3-9363-870af82d68dd`, with active assigned session `0776b9ca-e4ff-4882-82a2-409d287e536a` (`Pappy`, phone ending `5217750`). Older sessions using the same phone number exist, but they are logged out or degraded; they are not assigned to the active test worker.

## Root cause

The panel worker could start a broadcast and deliver many groups, but the runner retained the original Baileys socket for the complete job. When WhatsApp closed that socket during a long broadcast, the runner classified `Connection Closed` as transient and retried the same dead socket. The historic panel job `aeb7ca9c-bbd1-455a-a274-61f7f4332081` resolved 59 groups, completed 45, failed 14 with `Connection Closed`, and ended `PARTIAL`. This explains the appearance that the panel stopped dispatching; it was no longer using a live socket after the disconnect.

## Fix

The self-contained panel worker now detects socket-close errors, records `WAITING_FOR_SESSION`, waits for the normal reconnect path or reacquires the assigned session, swaps the runner to the new ready runtime, clears the transient error, and resumes from the durable `nextDelivery` checkpoint. It does not re-send completed groups. If the session is truly logged out, it fails truthfully rather than looping forever.

## Live evidence

The assigned worker and session were both active and valid after deployment. The panel group inventory diagnostic returned 57 groups, 8,734 members, and zero zero-member groups. A controlled one-group `sendGroupStatus` command was inserted for the known test group and completed through the real workload poll, lease, panel socket, and WhatsApp send path in 5,393 ms. The returned Baileys message had `remoteJid: 120363429710580264@g.us`, `fromMe: true`, and a real message ID.

A controlled self-chat `sendMessage` command also completed in 2,598 ms, proving the panel command poll and ordinary outbound path are operational.

## Deployment

Release 1.2.63 is active on both the control plane and `pappy-v3` panel worker. Control and panel services are active, the worker heartbeat is fresh, and the assigned session reports `ACTIVE` / `VALID`. The full local release gates passed 152 tests, strict typecheck, production build, generated worker syntax validation, and the worker artifact deployment hash check.

No mass broadcast was started during verification. The reconnect logic was verified by source contract and the live direct-send path; a full all-group run would create unsolicited messages in 57 groups.

## Boundary

The direct send path and inventory path are live-confirmed. The last observed all-group failure was specifically a mid-run socket close, not an inventory-resolution failure. The next real allstatus/allstatusd job on this panel will resume from its checkpoint after a reconnect instead of treating all remaining groups as failures.
