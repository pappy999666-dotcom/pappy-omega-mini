# Audit — Pairing Cleanup, Active Bridge, and Restart Resume

## Findings

| Requirement | Current behavior | Gap | Repair direction |
|---|---|---|---|
| Abandoned pairing sessions disappear | `startPairing()` creates a persisted `PAIRING` session immediately; pairing requests have `updatedAt` but no TTL/cleanup. | Unpaired sessions remain in registry and Admin Bridge. | Add a bounded pairing TTL cleanup that deletes only pairing-created sessions still lacking valid persisted auth and removes the pairing request. |
| Logged-out sessions must not appear in Bridge | Admin Bridge uses `listAllSessions()` with no status filter and displays PAIRING, LOGGED_OUT, ERROR, RECONNECTING, and DEGRADED rows. | Dead sessions are selectable and misleading. | Render only transport-eligible `ACTIVE` sessions in Global/Admin Bridge; hide terminal/unready states rather than pretending they are bridge targets. |
| Bridge should be simple | Admin Bridge has per-row Open buttons, Clear, Refresh, and separate single-session/fan-out routes. | Too much protocol and duplicate paths. | Active session rows become selection toggles; a single `Send Command` button opens one input; sending fans out only to selected active sessions. Remove Open/Clear/Start/Stop fan-out controls from the user-facing keyboard. |
| Bridge must listen only while open | Pending bridge maps exist, but selected state and old bridge flow are spread across multiple maps/routes. | A closed Bridge can retain selection/input context. | Central cancellation clears pending global/admin bridge state and active selection when Bridge is closed or another command is clicked; unprefixed input is routed only while the bridge input state exists. |
| All sessions active after restart | Startup skips only LOGGED_OUT/INVALID, then opens every remaining persisted session, including stale PAIRING records without auth (which are reset to PAIRING). | Stale rows remain and can create noisy reconnecting states. | Cleanup stale pairing before recovery; only sessions with valid auth are recovered. Retryable transport failures continue through the lifecycle supervisor; terminal logged-out sessions remain hidden until explicitly purged/repaired. |
| Join Manager/Validator continue after restart | Worker records and stale-job reaper are durable; Telegram-local maps (`joinJobs`, `joinStates`) are not. | UI may show idle/stopped after restart even though durable jobs continue. | Rehydrate active Join/Validator job state from `listRecent()` when rendering, and ensure worker runtime starts before session recovery (already true). Do not create duplicate jobs. |
| “Reconnect” status | RECONNECTING is a legitimate transitional transport state, but current Bridge UI exposes it like a selectable session. | User sees “always reconnecting” as a bridge target. | Keep lifecycle status truthful; filter it from Bridge and expose recovery only in per-session Health/Session controls. |

## Safety constraints

Automatic cleanup must not purge authenticated sessions or terminal sessions with recoverable auth. The cleanup targets only pairing-created sessions with no valid credentials and an expired pairing request/session age. Existing worker records must remain durable; no new in-memory-only recovery mechanism should be introduced.

## Final comparison after implementation

The user and Admin Bridge keyboards now expose only active-session selection and direct Send Command. Non-active rows are filtered in the route layer even if an old Telegram message still contains a stale callback. Opening or closing the Bridge clears the pending command listener; an unprefixed Telegram message is dispatched only while the corresponding pending Bridge input exists.

Pairing cleanup now runs at startup and every five minutes. The default pairing TTL is 30 minutes and is bounded by configuration. New sessions persist `createdAt`. Cleanup purges only expired PAIRING sessions without valid auth and terminal LOGGED_OUT/invalid-auth sessions; authenticated sessions are never selected by the cleanup predicate.

Join Manager and Validator jobs remain in Redis/BullMQ. Stale-job recovery is called after all worker handlers are registered, and the existing 30-second reaper remains as a fallback. This prevents recovery from running before the link-validation, join-manager, broadcast, and cleanup handlers exist.

The final local verification passed the strict TypeScript build and 89/89 tests. Redis ECONNREFUSED lines are expected sandbox test noise because no local Redis daemon is running; they are not assertion failures.
