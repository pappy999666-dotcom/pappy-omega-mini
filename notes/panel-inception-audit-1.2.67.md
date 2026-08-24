# PAPPY OMEGA MINI Panel Inception Audit

**Release audited:** 1.2.67  
**Date:** 22 August 2026  
**Author:** Manus AI  
**Scope:** Published panel worker, control-plane bridge, WhatsApp session lifecycle, command dispatch, broadcast startup, retry behavior, failure isolation, and link-preview preservation.

## Executive conclusion

The panel and control-plane paths were audited from the worker socket boundary through the authenticated workload API, session registry, command router, transport bridge, broadcast runner, and persistence layer. The most important production defects found during the audit were corrected in a narrowly scoped release and deployed with rollback backups. The panel worker then auto-updated to release 1.2.67, restored its assigned session, refreshed its group inventory, and continued sending fresh heartbeats without a panel restart initiated by the deployment.

The release improves terminal logout cleanup, prevents stale commands from accumulating or completing after expiry, removes unnecessary database polling while a workload command is waiting for its result, and makes inbound control retries safe against duplicate WhatsApp replies when a message ID is available. Link-preview code was not altered; the existing preview isolation and fallback suite continued to pass. No WhatsApp test message, self-chat, group message, or broadcast was sent during this audit.

This is a hardening result, not an unrealistic guarantee that WhatsApp, Baileys, a user’s network, or a provider rate limit can never fail. The design now contains bounded failure handling and isolation so one session or one job does not intentionally share its command chain, auth state, inventory cache, or terminal cleanup with another session.

## Route map audited

| Route | Primary path | Isolation and failure behavior |
|---|---|---|
| Panel inbound command | Baileys `messages.upsert` → worker `/workload/event` → worker authentication → exact assignment/workspace check → `routeWhatsAppText` → assigned `sendMessage` bridge | The command is scoped by workspace, session, and assignment. A five-minute message-ID dedupe guard prevents a transient HTTP retry from executing the same inbound command twice. |
| Panel outbound command | Control `queueWorkloadCommand` → Mongo command record → worker long-poll `/workload/poll` → per-session command chain → `/workload/result` | New commands wake the worker long-poll immediately. Completion waiters are signalled in-process rather than polling Mongo every 250 milliseconds. Commands remain bounded by TTL and lease ownership. |
| Broadcast start | WhatsApp router enqueues a durable job → panel broadcast queue → `broadcast.start` → worker-local broadcast runner → local group inventory and per-group delivery | Broadcast execution uses a separate per-session broadcast chain. Normal commands and invite-validation background methods do not wait behind the broadcast chain. Initial acknowledgement does not wait for a full group scan. |
| Terminal logout | Worker classifies WhatsApp code 401 → removes local auth and session-specific broadcast artifacts → reports `LOGGED_OUT` → control marks assignment offline and performs scoped central purge | The session’s own jobs, traces, auth directory, inventory, and assignment are removed. Other workers and sessions are not purged. A persisted terminal tombstone prevents stale heartbeat data from resurrecting the logged-out account. |
| Link preview | Canonical preview preparation → source URL metadata/fallback path → native Baileys payload | The audit did not replace or weaken this route. Existing source-URL isolation, group-invite handling, media preservation, cache coalescing, and exact-content fallback tests remained green. |

## Findings and corrections

| Finding | Severity | Evidence | Correction |
|---|---:|---|---|
| Panel-reported WhatsApp logout did not reliably remove the central session because the periodic cleanup filter excluded workload-owned sessions. | High | `src/index.ts`, `src/workload/service.ts`, `tools/worker-runtime-source.mjs` | Panel logout now invokes a scoped central purge. The periodic cleanup pass also includes panel-owned terminal sessions. |
| Local panel auth and broadcast artifacts could remain after a 401 logout, allowing stale data to survive a session removal. | High | `tools/worker-runtime-source.mjs` | The worker flushes pending auth writes, removes only that session’s local auth directory, removes attributable broadcast checkpoints, and removes its inventory snapshot. |
| A logged-out session could be returned again by a durable assignment during a control outage and then be started by heartbeat recovery. | High | Worker heartbeat reconciliation and `startSession` path | Release 1.2.67 persists terminal session IDs in encrypted worker state, excludes them from heartbeat restoration, and refuses bridge or broadcast starts until an explicit start or re-pair command clears the tombstone. |
| Expired queued or leased workload commands remained in the command collection and could be mistaken for live work during diagnosis. | Medium | `workload_commands` inventory showed abandoned records; post-release expiry count increased as the sweeper processed them | Added bounded per-worker expiry sweeping. Expired commands are marked `EXPIRED`, their lease is removed, and late completion is rejected. |
| `waitForWorkloadCommand` used repeated database reads even when the worker had already posted a result. | Medium | `src/workload/service.ts` | Added in-process completion signals with a one-second race fallback. This reduces Mongo read pressure and shortens the response path without changing command semantics. |
| Retried panel inbound HTTP requests could repeat a command or duplicate a reply if the first response was lost after execution. | Medium | `/workload/event` handler and panel retry behavior | Added a bounded in-process dedupe keyed by workspace, session, and WhatsApp message ID. Failed first attempts are removed from the cache so a genuine retry can execute. |
| A future control-plane restart can take long enough to reach the systemd 30-second stop timeout when many local sockets are closing. | Medium, remaining | The 1.2.66 deployment showed a stop-timeout kill of the old control process; panel-hosted work recovered independently | No risky socket-lifecycle rewrite was included in this release. The risk is recorded for a separate maintenance change; panel-hosted sessions remain isolated in their own service. |

## Dispatch and failure-isolation assessment

The command runtime now has three deliberate execution lanes. Ordinary per-session commands use the session command chain, invite metadata and invite acceptance use the background chain, and broadcast start/cancel uses the broadcast chain. A slow broadcast therefore does not intentionally block an unrelated `.ping`, profile, settings, pairing, or preview operation for the same worker. Different sessions are keyed independently, and the control API requires the exact worker assignment and workspace before it accepts a command or inbound event.

The panel does not fall back from a panel-owned WhatsApp session to the control plane’s local Baileys socket. That boundary is intentional: using a local socket as an emergency fallback for a remote session would risk duplicate sockets, cross-session credentials, and replies sent from the wrong account. The safe fallback is instead bounded control retry, durable command state, lease recovery, panel restart rollback, session-specific reconnect, and a clear terminal state when WhatsApp has actually logged out.

The first response for panel broadcasts is now created after the durable job is accepted, not after a complete group inventory scan. The worker can report a truthful “started” state while it resolves inventory locally. Existing allstatus/allchat acknowledgement formatting and the designed `dallstatus` route were not changed by this hardening pass.

## Test and deployment evidence

| Check | Result |
|---|---|
| TypeScript typecheck | Passed. |
| Production build | Passed. |
| Worker source and generated single-file bundle syntax check | Passed. |
| Focused workload, worker, broadcast, and preview tests | Passed; 160 assertions available in the suite. |
| Full functional suite | All 160 assertions passed. The default five-second test ceiling occasionally timed out three preview cases under concurrent sandbox load without assertion failures; the isolated preview suite and the full suite with a fifteen-second ceiling both passed. |
| Control health after deployment | `ok: true`, control version 1, heartbeat interval 20 seconds, package version 1.2.67. |
| Services after deployment | Control and panel services active; zero systemd restarts in the final live check. |
| Panel update | Panel verified release 1.2.67, restarted safely through its update mechanism, restored one assigned session, and cached 56 groups. |
| Terminal-session safety | Final live snapshot showed 0 persisted `LOGGED_OUT` sessions. No logout test was forced because doing so would alter a real account. |
| Resource snapshot | Approximately 2.97 load average, 4.4 GB available memory, and 46% root disk usage at the final check. |
| Traffic policy | No WhatsApp message, self-chat, group message, or broadcast was generated by this audit. |

One transient socket-restart message and one invalid group-metadata response appeared during the panel’s normal reconnect/inventory activity. The worker recovered, refreshed the 56-group inventory, and returned to an error-free matrix state. One 502 appeared during the expected short control/update restart window; subsequent heartbeats were healthy. These were observed recovery paths, not silently presented as a perfect no-error run.

## Remaining controlled verification

The final production check intentionally stopped before sending a WhatsApp command. Therefore, the last user-visible edge—an actual inbound `.ping` or other harmless command from the affected account through the live panel—still requires an approved controlled verification. This can be performed later with a normal user-sent command or with explicit permission for one controlled self-chat test. No automatic test message was sent because the audit requirement prohibited unsolicited WhatsApp traffic.

The remaining operational follow-up is to design a separate graceful-shutdown improvement for locally hosted sockets so a control release does not approach the 30-second systemd stop timeout. That change should be isolated from panel worker logic and should receive its own focused lifecycle tests before deployment. It was deliberately not mixed into release 1.2.67 because socket-close behavior is high risk and the panel workload service already recovered independently.

## Changed artifacts

The verified source changes are in `src/index.ts`, `src/workload/service.ts`, `src/persistence/mongo.ts`, and `tools/worker-runtime-source.mjs`. The generated panel artifact is `worker-package/index.js`, with `worker-package/package.json` at version 1.2.67. The deployment created an on-host backup before extraction. No commit was created, no unrelated uncommitted work was discarded, and no secret, credential, private key, or enrollment token is included in this report.

## Evidence references

[1]: `notes/whatsapp-inbound-audit-2026-08-22.md` — read-only audit and live deployment evidence.  
[2]: `src/workload/service.ts` — workload command, heartbeat, assignment, expiry, and completion handling.  
[3]: `tools/worker-runtime-source.mjs` — panel runtime session, broadcast, heartbeat, retry, and local cleanup handling.  
[4]: `src/whatsapp/baileys-native-preview.ts` and `tests/preview-manager.test.ts` — canonical preview path and regression coverage.  
[5]: `tests/workload-security.test.ts`, `tests/workers.test.ts`, and `tests/broadcast-format.test.ts` — workload and broadcast regression coverage.
