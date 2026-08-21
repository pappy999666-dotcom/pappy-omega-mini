# PAPPY OMEGA-MINI High-Scale Rebuild Acceptance Matrix

This matrix is derived from `PAPPY_OMEGA_MINI_HIGH_SCALE_REBUILD.txt` and governs the rebuild. The pre-rebuild baseline is commit `8ea9171`, branch `backup/pre-high-scale-rebuild-20260821`, and tag `pre-high-scale-rebuild-20260821`.

## Release blockers

| ID | Requirement | Evidence required | Status |
|---|---|---|---|
| RB-01 | VPS and panel workers use equivalent workload semantics and Baileys behavior | Same command contract, same lifecycle, same failure policy, parity test results | Pending |
| RB-02 | 413 is root-caused and eliminated by payload redesign | Route, method, body size, response, serialized fields, and reproduction record | Implemented · live verification pending |
| RB-03 | Rate-overlimit source is identified and isolated | Classified producer, bounded policy, no infinite retry, no unrelated command blockage | In progress |
| RB-04 | Heavy WhatsApp work executes on the owning worker | Control payload contains intent/references, not full groups/participants/session state | Implemented · live verification pending |
| RB-05 | 1,000/2,000/5,000/10,000-group tests pass | Scale test reports with memory, latency, queue depth, and failure outcomes | Pending |
| RB-06 | Restart and failure recovery preserve jobs and checkpoints | Worker, VPS, control-plane, network, 5xx, rate-limit, and reconnect tests | Pending |

## Architecture and transport

| Area | Acceptance condition | Status |
|---|---|---|
| Control intent | Commands carry job/session identifiers, parameters, and references only | Implemented · live verification pending |
| Payload bounds | No giant group objects, participant lists, auth state, message history, or heavy media in control requests | Implemented · live verification pending |
| Group resolution | Local-first state, worker-local cache, incremental refresh, pagination/chunking | Worker-local cache implemented · live verification pending |
| Panel worker | Official `index.js`, package manifest, deployment guide, secure registration, heartbeat, auto-update | Partial |
| Authentication | Human-facing workload key plus secure internal worker credential; registration/key verification protected | Partial |
| Media locality | Heavy media remains on the owning worker wherever possible | Implemented via media reference endpoint · live verification pending |
| API necessity | Redis/API layers retained only where required for durable control and recovery | Pending audit |

## Scheduler and reliability

| Area | Acceptance condition | Status |
|---|---|---|
| Durable jobs | allstatus/allchat/tagging/bulk/media operations have durable state and lifecycle | Partial |
| States | QUEUED, RUNNING, PAUSED, COMPLETED, PARTIAL, FAILED, CANCELLED | Partial |
| Bounded concurrency | Separate bounded pools for control, groups, sends, status, metadata, and media | Partial |
| Backpressure | Queue, pause, checkpoint, resume, and overload reporting | Pending audit |
| Checkpointing | Restart resumes from durable progress without replaying completed groups | Implemented · live verification pending |
| Cancellation | Stop/cancel reaches the correct queue and job after restart | Implemented · live verification pending |
| Rate-aware policy | 413 split/redesign; 429 bounded pause/backoff; 5xx bounded retry; auth/permanent failures stop | Partial |
| Event-loop protection | Large jobs yield and do not starve Telegram, Baileys, heartbeat, or reconnect work | Pending stress test |

## Validator Hub and Join Manager

| Area | Acceptance condition | Status |
|---|---|---|
| Ownership | One admin-owned shared pipeline; users do not own or open a Validator Hub | Partial |
| Intake | All user/session links combine into global Main; only WhatsApp group invites accepted; canonical deduplication | Partial |
| Validation | Distributor leases one Main link per eligible session; Validator never consumes Active | Partial |
| Lease safety | Stale jobs cannot overwrite newer decisions; orphan claims are recycled safely | Partial |
| Bucket integrity | A link belongs to one authoritative bucket; stale memberships reconciled | Partial |
| Join Manager | Consumes only shared Active; dead-looking links return to Main; restart reuses durable jobs | Partial |
| Live observability | Totals, leases, progress, retries, and scoped failures; no millions-of-sessions enumeration | Partial |

## Broadcast and command behavior

| Area | Acceptance condition | Status |
|---|---|---|
| allstatus/allchat | Native WhatsApp commands acknowledge quickly with concrete totals or explicit failure | Implemented · live verification pending |
| Broadcast isolation | Each job has independent queue/lifecycle; one job cannot block another | Partial |
| No false success | No unresolved/calculating placeholder presented as a ready job; no silent reply loss | Implemented · live verification pending |
| No uncontrolled fan-out | No Promise.all over thousands of groups; bounded scheduler with pacing and backpressure | Implemented · live verification pending |
| Telegram control | Aggregated editable progress with Status/Pause/Resume/Cancel; no per-group message spam | Partial |
| WhatsApp command isolation | Uncalled commands and stale pending states do not consume later messages | Partial |
| Quoted/media payloads | Quoted text/media normalized consistently across Telegram and WhatsApp bridges | Partial |

## Health and observability

| Area | Acceptance condition | Status |
|---|---|---|
| Health dimensions | CONTROL_PLANE, BAILEYS, QUEUE, COMMAND_EXECUTION, HEARTBEAT, MEMORY, CPU, NETWORK | Partial |
| Scoped degradation | allstatus can be DEGRADED without falsely degrading unrelated commands or the entire worker | Pending audit |
| Metrics | queue depth, totals, completion, failures, skips, rate-limit count, 413 count, retries, latency, event-loop lag, memory, heartbeat age | Pending implementation audit |
| Error records | status, route, payload bytes, worker/session/job, operation; never secrets/auth state | Pending implementation audit |
| Cleanup | Bounded caches, no stale promises, no uncontrolled snapshots or state retention | Pending stress test |

## Required verification matrix

| Test class | Required cases | Status |
|---|---|---|
| Unit/regression | Full existing suite, command registry, bucket transitions, lease races, UI callbacks | Partial |
| Scale | 10, 100, 1,000, 2,000, 5,000, 10,000 groups and large member counts | Compact-intent tests pass · live transport scale pending |
| Concurrency | Multiple sessions and simultaneous independent jobs | Pending |
| Failures | 413, rate-limit, 5xx, network loss, worker disconnect, authentication failure | Pending |
| Restarts | Worker, panel, VPS, and control-plane restarts during active jobs | Pending |
| Parity | VPS vs panel: pairing, reconnect, group resolution, allstatus/allchat, tags, media, scheduling, cancellation, recovery | Pending |
| Security | Worker registration, key verification, credential isolation, no Telegram token/Mongo/Redis on panel | Partial |

## Frozen baseline

The baseline release is preserved in GitHub as branch `backup/pre-high-scale-rebuild-20260821` and tag `pre-high-scale-rebuild-20260821`. No rebuild change may be called complete unless its acceptance evidence is recorded against this matrix.

The matrix intentionally distinguishes **implemented**, **verified**, and **pending**. A source change or passing small test is not acceptance evidence for large-scale parity.
