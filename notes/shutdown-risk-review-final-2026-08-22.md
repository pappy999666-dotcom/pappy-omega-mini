# Control-Plane Shutdown Risk Review

**System:** PAPPY OMEGA MINI control plane and published panel worker  
**Reviewed:** 22 August 2026  
**Current deployed package:** 1.2.67  
**Scope:** systemd stop timeout, socket cleanup, Redis shutdown errors, Telegram polling, job workers, MongoDB, panel long-poll connections, and WhatsApp transport load.

## Executive assessment

The original 30-second systemd stop timeout was real. It was not caused by the panel authentication state or by a deliberate WhatsApp purge. The control process received SIGTERM, completed part of its shutdown work, remained alive beyond `TimeoutStopSec=30s`, and was then killed with SIGKILL. The investigation found two separate classes of risk: ordinary shutdown resource cleanup and sustained event-loop pressure from Baileys decryption failures.

The ordinary shutdown path has been hardened and verified. It now stops accepting new workload traffic first, destroys active control-server sockets including panel long-poll connections, closes local WhatsApp sockets before durable workers, force-closes BullMQ workers rather than waiting for long-running handlers, closes every known long-lived Redis singleton, and continues cleanup if one close operation fails. A bounded final exit fence was also added after explicit cleanup.

The important remaining risk is **not fully eliminated under peak transport load**. A final controlled restart at low enough load exited cleanly in approximately 488 milliseconds with `ExecMainStatus=0`, no restart count increase, and no systemd timeout. However, another restart while the process was under a Baileys decryption-error storm still reached the 30-second SIGKILL boundary even though the application logged `transports closed; shutdown complete`. This means the Node event loop can remain starved by synchronous or high-frequency transport work, preventing the final timer or process exit from being serviced promptly.

## Measured timeline

| Scenario | Observed result | Interpretation |
|---|---:|---|
| Original shutdown | SIGTERM → approximately 30 seconds → systemd SIGKILL | Long-lived resources and/or event-loop work outlived the systemd stop budget. |
| Socket-destruction fix under one restart | Approximately 6.2 seconds to the systemd restart command | Destroying panel HTTP sockets removed the long-poll wait, but did not prove all high-load handles were gone. |
| Final controlled restart after cleanup and error guards | Approximately 488 ms; `Result=success`, `ExecMainStatus=0`, `NRestarts=0` | Clean shutdown is achievable when the event loop is responsive. |
| Restart during transport error storm | Approximately 30 seconds; systemd sent SIGKILL after the process had logged shutdown completion | Residual event-loop starvation or a hidden library-owned handle remains possible under high Baileys load. |

The unit remains configured with `TimeoutStopSec=30s`, `KillSignal=SIGTERM`, and `FinalKillSignal=SIGKILL`. Keeping the 30-second ceiling is preferable to simply increasing it while the transport storm remains unresolved; a larger ceiling would hide the responsiveness problem and prolong panel unavailability during deployments.

## Implemented safeguards

| Area | Change | Safety property |
|---|---|---|
| Control HTTP | Active sockets are tracked and destroyed before awaiting `server.close()` | Panel long-poll requests cannot hold shutdown open for their full wait period. |
| Shutdown order | Control listener stops before schedulers, sockets, and workers | No new workload event or command is accepted while resources are being closed. |
| BullMQ | Workers use forced close during process shutdown | A 20-minute broadcast or validation handler cannot block process termination. Its durable record remains available for later recovery. |
| Redis | Shared error observer, duplicate-log suppression, and explicit close hooks were added to long-lived clients | Expected close-time Redis errors no longer become unhandled process crashes; live Redis failures remain logged. |
| WhatsApp | Socket shutdown and auth flushing occur before final process exit | Auth state is flushed without purging credentials or touching panel auth. |
| Cleanup isolation | Individual cleanup failures are logged and do not abort later cleanup steps | Telegram, WhatsApp, MongoDB, Redis, preview, remote bridge, and panel cleanup are isolated. |
| Final exit | A short post-cleanup fence calls `process.exit(0)` after explicit cleanup completes | Hidden library handles cannot keep systemd waiting once the event loop reaches the fence. |

## Remaining root cause to investigate

The live control process continues to show Baileys errors such as `No session found to decrypt message`, `Received message with old counter`, and `Expected Buffer instead of: Object`. A final read-only sample showed approximately 110% CPU for four consecutive one-second samples, three `No session found to decrypt message` events, and two `Expected Buffer instead of` events in the preceding minute. The panel itself remained active, continued fresh heartbeats, and reported no panel-side error.

These errors are transport-level state failures and should not be treated as ordinary user commands. Their frequency and crypto/state-processing cost can delay timers and signal cleanup even when shutdown code is correct. The next separate maintenance task should therefore profile and bound undecryptable-message handling, verify the deployed Baileys dependency alignment, and determine whether malformed group sender-key state should be isolated per session or trigger a bounded socket recovery. That work must not delete or re-pair sessions automatically.

## Production state after review

The control health endpoint currently returns `ok: true`, control version 1, a 20-second heartbeat interval, and package version 1.2.67. Both the control service and the panel service are active, the control listener is bound on `127.0.0.1:8788`, and the panel continues to report fresh heartbeats with `ERROR none`. No WhatsApp message, self-chat, group message, or broadcast was generated by this review.

## Recommendation

The control-plane shutdown improvements are safe to retain, and the measured sub-second clean restart demonstrates that the normal path is now efficient. The system should not yet be described as immune to the 30-second timeout under peak load because the Baileys decryption storm can still starve the event loop. The correct next action is a separate, non-destructive transport-load investigation—not a larger systemd timeout, not a session purge, and not a forced re-pair. Until that investigation is complete, production deployments should continue using the existing on-host backup procedure and should verify the control health endpoint and panel heartbeat immediately after restart.

## Evidence files

[1]: `notes/shutdown-risk-audit-2026-08-22.md` — measured shutdown timeline, Redis findings, and production restart evidence.  
[2]: `src/workload/control-server.ts` — active control-socket tracking and shutdown.  
[3]: `src/jobs/job-orchestrator.ts` — forced worker shutdown.  
[4]: `src/index.ts` — shutdown ordering, cleanup isolation, Redis handlers, and final exit fence.  
[5]: `src/core/redis-events.ts` — rate-limited Redis error observation.
