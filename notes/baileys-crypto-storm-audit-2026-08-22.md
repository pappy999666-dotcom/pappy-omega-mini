# Baileys Decryption-Error Storm Audit

**System:** PAPPY OMEGA MINI control plane  
**Date:** 22 August 2026  
**Deployed control package:** 1.2.67  
**Scope:** Baileys crypto/decryption failures, event-loop pressure, session isolation, restart behavior, systemd stop timeout, and panel continuity.

## Finding

The storm was produced inside the local control process by Baileys processing encrypted group and status traffic whose sender-key state was unavailable or malformed. The observed errors included `No session found to decrypt message`, `Received message with old counter`, and `Expected Buffer instead of: Object`. The errors were emitted while the control process held multiple local WhatsApp sockets and were accompanied by sustained process CPU near 100 percent. This is distinct from the panel worker’s authenticated control path; the panel continued fresh heartbeats while the local control process was busy.

The original logging hook converted large Baileys error objects into strings and then forwarded every error to the logger. That made a high-frequency crypto failure expensive in both crypto processing and synchronous log formatting/output. The previous shutdown improvements also exposed a second risk: even after the application printed `transports closed; shutdown complete`, the event loop could remain busy or retain library-owned handles long enough for systemd to reach its 30-second stop boundary.

## Implemented isolation policy

A per-session crypto-error circuit breaker now runs at the Baileys logger boundary. It identifies only the known undecryptable-message signatures, counts them independently for each socket, and uses a 30-second window with a threshold of 12 failures. Below the threshold, the full noisy error payload is suppressed from the application logger. At the threshold, the affected socket receives one bounded recovery request and the recovery message includes only the session identifier and failure count. The session’s auth directory is preserved; no session purge or re-pair is performed automatically. Other session sockets continue independently.

The existing reconnect lifecycle handles the resulting non-terminal socket close with its normal backoff and state update. The circuit breaker resets when a new error window begins. A valid explicit start or re-pair path remains available, and the terminal logout tombstone logic is unchanged. This prevents the safeguard from turning a recoverable transport problem into credential deletion.

## Shutdown protections retained

| Protection | Purpose |
|---|---|
| Stop control HTTP first | Prevents new workload requests while shutdown is in progress. |
| Destroy active control sockets | Ends panel long-poll connections instead of waiting for their polling timeout. |
| Force-close BullMQ workers | Prevents a long broadcast or validation task from holding shutdown open. Durable job records remain recoverable. |
| Close known Redis singletons | Removes explicit Redis handles and attaches rate-limited error observers. |
| Per-step cleanup isolation | A failed Telegram, Redis, MongoDB, preview, worker, or bridge close does not abort subsequent cleanup. |
| Bounded final exit fence | After explicit cleanup completes, the process exits cleanly instead of waiting forever for hidden library handles. |
| Per-session crypto breaker | Prevents one damaged Baileys session from flooding the process and starving unrelated sessions. |

## Verification results

| Check | Result |
|---|---|
| TypeScript typecheck | Passed. |
| Full regression suite | Passed: 15 test files and 160 assertions. |
| Preview regression | Passed, including WhatsApp invite URL isolation, rate-limit fallback, media preservation, and source URL correctness. |
| Build and syntax checks | Passed for the control plane and affected session-manager output. |
| Deployment | Control-plane-only artifact deployed with an on-host backup. Worker bundle and panel authentication state were not changed. |
| Service state | Control and panel services active; `Result=success`, `ExecMainStatus=0`, `NRestarts=0` in the final check. |
| Control health | `/workload/health` returned `ok: true`, control version 1, 20-second heartbeat interval, and package version 1.2.67. |
| Panel continuity | Panel remained active and continued fresh heartbeats for its assigned session. |
| WhatsApp traffic | No test message, self-chat, group message, or broadcast was sent. |

A final controlled restart after the complete shutdown changes exited cleanly in approximately 488 milliseconds. The earlier 30-second restart failures occurred under the old or partially hardened process and during a high-load period. One later restart during a transport-heavy period still reached the old systemd timeout before the final bounded-fence behavior could be observed, which is why the conclusion remains careful rather than claiming absolute immunity.

After the crypto circuit breaker was deployed, the recent 90-second log window contained zero matching crypto-storm messages. The control process remained CPU-heavy during the first few minutes of recovery, at approximately 87–98 percent, but this was accompanied by seven local persisted sessions completing normal recovery and no new crypto-error records. The panel continued fresh heartbeats and reported no panel-side error. The current evidence supports that the storm’s log amplification and repeated-error path were isolated, but it does not yet prove that all post-recovery CPU cost is gone.

## Remaining risk and next step

The correct next investigation is a CPU profile of the local control process after all seven sessions have been stable for several minutes. If CPU remains high with zero crypto errors, the remaining cost is likely contact-store synchronization, message backlog replay, or another Baileys event handler rather than the decryption-error logger. That investigation should use per-session counters and bounded event processing, not a global process restart. If one session repeatedly crosses the 12-error threshold, it should be marked `DEGRADED` and isolated with exponential recovery backoff while all other sessions remain active.

Increasing `TimeoutStopSec` is not the primary fix. It would hide event-loop starvation and prolong panel downtime. The safest operational posture is to retain the current 30-second systemd ceiling, keep the explicit cleanup and final exit fence, and separately profile the remaining local transport CPU before making any further Baileys-state change.

No session was purged, no account was re-paired, and no user-facing WhatsApp traffic was generated during this work.

## Evidence references

[1]: `notes/shutdown-risk-audit-2026-08-22.md` — shutdown timeline and live service evidence.  
[2]: `notes/shutdown-risk-review-final-2026-08-22.md` — previous stop-timeout analysis.  
[3]: `src/whatsapp/session-manager.ts` — per-session Baileys logger circuit breaker.  
[4]: `src/workload/control-server.ts` — active control-socket shutdown.  
[5]: `src/index.ts` — shutdown order, error isolation, and final exit fence.  
[6]: `src/core/redis-events.ts` — Redis error observation and duplicate-log suppression.
