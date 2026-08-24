# PAPPY OMEGA-MINI High-Scale Release 1.2.14

## Release outcome

Release **1.2.14** implements the worker-local broadcast redesign for assigned panel sessions. The control plane now submits only a compact broadcast intent containing the job identifier, command kind, text/media reference, delay, repeat count, and optional source chat. The owning panel resolves its own WhatsApp groups and performs delivery locally.

The implementation was committed as `feeeab9` on `main` and pushed to `pappy999666-dotcom/pappy-omega-mini`. The live control plane and official panel worker both run the matching 1.2.14 artifact.

## Architecture changes

| Area | Result |
|---|---|
| Panel allstatus/allchat routing | Assigned panel sessions use `broadcast.start`; no pre-enqueue group inventory call is made by the control plane. |
| Group resolution | The panel calls `groupFetchAllParticipating()` locally and caches only its local group JIDs for five minutes. |
| Delivery | One delivery at a time per panel session, with pacing, bounded retry, permanent/inaccessible classification, and no group-wide `Promise.all`. |
| Checkpointing | Encrypted checkpoints are written under `DATA_DIR/broadcasts/{jobId}.json`; offsets are delivery-level so restarts do not replay completed repeats. |
| Progress | The panel reports only aggregate counts and current-group metadata through an authenticated workload endpoint. |
| Cancellation | Telegram cancellation is persisted in Redis and also delivered as `broadcast.cancel`; a restarted panel re-checks the durable cancellation marker. |
| Media | Control plane stores media and passes only a media reference; the worker retrieves the bytes through an authenticated reference endpoint. |
| Cleanup | Flush, clear-all, and session-purge paths remove worker-local progress and cancellation keys. |
| Auto-update | Worker package and release defaults were bumped to 1.2.14 so older panels can detect the release. |

## Verification evidence

| Check | Result |
|---|---|
| TypeScript strict typecheck | Passed |
| Production build | Passed |
| Regression suite | **124/124 tests passed across 14 files** |
| Scale contract tests | Passed for 10, 100, 1,000, 2,000, 5,000, and 10,000 group-count cases; intent remained below 4 KB and contained no group JIDs. |
| Worker source syntax | Passed with `node --check`. |
| Generated worker marker check | Passed; embedded source contains local group resolution, encrypted checkpointing, compact progress, start, and cancel paths. |
| Live HTTPS health | Passed: `ok=true`, `controlVersion=1`, `packageVersion=1.2.14`. |
| Live services | `pappy-omega-mini.service` active; `pappy-panel-v3.service` active. |
| Live artifact identity | Local and live panel worker SHA-256: `ae7ea22caf564adaa80b9f4c5ffb807da681073031517f71314987ce0d5eb250`. |
| Protected endpoint check | Unauthenticated progress access was rejected with `Bearer workload credential required.` |
| Panel heartbeat | Continued after restart; four recent heartbeat lines were observed in the final verification window. |
| New fatal workload errors | Zero in the final 90-second control-plane verification window. |

## Important qualification

The live checks verified deployment, service startup, HTTPS health, authentication protection, worker heartbeat, artifact identity, and compact-payload behavior. An unsolicited outbound WhatsApp broadcast was not generated during deployment verification; a real end-to-end send still requires the owner to invoke `.allstatus` or `.allchat` from an assigned active session and select a controlled test group. The implementation is therefore **code-complete and live-deployed**, while physical WhatsApp delivery parity remains an owner-triggered acceptance step.

The local test harness emitted existing `ioredis` connection-refused warnings because no local Redis daemon was running, but the suite completed successfully with all 124 tests passing. The live VPS uses its configured Redis service and passed workload health checks.

## Acceptance matrix state

The accompanying `high-scale-acceptance.md` marks compact intent, worker-local execution, checkpointing, cancellation, media references, bounded fan-out, and concrete acknowledgement logic as implemented with live transport verification recorded separately. Validator Hub, Join Manager, and full real-session WhatsApp parity remain outside this release’s new broadcast-specific smoke action and should not be marked fully accepted solely from this release report.
