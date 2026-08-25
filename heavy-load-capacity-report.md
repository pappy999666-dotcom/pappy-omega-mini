# OMEGA-MINI Heavy-Load and 50-Session Capacity Test

**Date:** 25 August 2026
**Deployment commit:** [`9afbca2`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/9afbca2)
**VPS capacity observed:** 6 vCPUs, approximately 11 GiB RAM, 2 GiB swap

## Executive result

The heavy-load test found that the VPS control plane stays responsive and error-free under a 50-concurrent-client HTTPS health flood, while the synthetic WhatsApp admission path correctly protects the process from unbounded queue growth. The measured VPS service stayed active with `ExecMainStatus=0` and `NRestarts=0`. All 5,198 health requests completed successfully over 60 seconds, with no invalid responses and no health failures. During concurrent VPS sampling, the process RSS remained approximately 303 MB, sampled runtime event-loop p95 lag peaked at approximately 123 ms, and the largest sampled event-loop delay was approximately 243 ms. No reconnect storm, crypto-error storm, auth failure, crash, uncaught error, or `SIGKILL` event appeared in the relevant journal scan.

The test also exposed an important capacity truth: **50 actual WhatsApp sockets carrying real afternoon traffic cannot be represented by a single fixed guarantee of 0.6 CPU per session on a 6-vCPU host.** A 0.6-CPU budget for 50 sessions would require approximately 30 CPU cores before accounting for MongoDB, Redis, Telegram, media work, Nginx, and operating-system overhead. The correct production target is isolation and graceful overload—not a promise that every session receives 0.6 dedicated CPU on six cores.

## Test layers

| Layer | What was exercised | Destructive actions |
|---|---|---|
| Synthetic admission stress | OMEGA-MINI’s real inbound and outbound fairness queues using 50 synthetic session IDs, bounded tasks, per-session serialization, global concurrency, overload, and unhandled-rejection monitoring | None; no WhatsApp account or auth state used |
| HTTPS control-plane flood | Public TLS health endpoint with 50 concurrent clients for 60 seconds | Health reads only; no command, pairing, worker update, or session mutation |
| VPS resource sampling | Service CPU/RSS, runtime event-loop metrics, queue snapshots, systemd state, and journal storm scan during the flood | Read-only monitoring |

This is a **capacity and protection test**, not proof that 50 real WhatsApp accounts can simultaneously transmit large media, render previews, validate links, moderate groups, and broadcast without upstream WhatsApp throttling. Real-account traffic has external constraints that a local synthetic test must not bypass.

## Findings before hardening

The real admission queues already had global caps and fairness, but they did not limit the pending work attributable to one individual session. In a synthetic burst, a noisy session could therefore consume most or all of the pending budget before other sessions entered. Queue rejection itself was handled, but the isolation boundary was weaker than required for a multi-session VPS.

The prior synthetic run also showed that a saturated workload creates controlled rejection rather than unhandled promise failures. That is safer than allowing infinite memory growth, but it means the system must expose queue pressure clearly and avoid treating every rejected low-priority task as a process failure.

## Implemented hardening

Commit `9afbca2` adds per-session pending limits to both admission paths.

| Path | Global concurrency | Global pending cap | New per-session pending cap | Purpose |
|---|---:|---:|---:|---|
| Inbound WhatsApp work | 12 | 500 | 100 | Prevent one session’s inbound burst from starving other sessions and exhausting memory. |
| Outbound WhatsApp work | 24 | 1,000 | 200 | Preserve serialized per-session sends and stop one sender from monopolizing outbound queue memory. |

The limits are configurable through `INBOUND_WA_MAX_PENDING_PER_SESSION` and `OUTBOUND_WA_MAX_PENDING_PER_SESSION`, but defaults are intentionally conservative. The health snapshots now report the per-session caps so live logger/dashboard views can show the actual overload boundary. The existing global fairness, priority ordering, per-session outbound serialization, and queue cleanup were retained.

The earlier Baileys hardening commit `09dd186` remains active underneath this change. It added quiet socket defaults, bounded retry timing, per-session retry counters, cached durable Signal-key reads, bounded recent-message lookup, short-lived group metadata caching, and live-versus-history upsert filtering.

## Synthetic 50-session results

| Scenario | Task attempts | Accepted | Dropped/rejected | Completed | p50 | p95 | Maximum | Event-loop lag maximum | Unhandled rejections |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Controlled: 12 tasks/session, 8 ms task | 1,200 | 1,112 | 88 | 1,112 | 131 ms | 316 ms | 348 ms | 0.68 ms | 0 |
| Saturated: 40 tasks/session, 20 ms task | 4,000 | 1,536 | 2,464 | 1,536 | 442 ms | 827 ms | 884 ms | 0.56 ms | 0 |

The saturation result is the intended safety behavior: accepted work completed, rejected work was bounded and accounted for, and the harness observed **zero unhandled promise rejections**. The result is not a throughput promise for real WhatsApp traffic; it verifies that one overloaded process does not silently grow without limit or crash from queue pressure.

## VPS HTTPS flood results

The public health endpoint received 5,198 requests from 50 concurrent clients during 60 seconds. Every response was successful and contained `ok: true`.

| Metric | Result |
|---|---:|
| Requests | 5,198 |
| Successful responses | 5,198 |
| Failed responses | 0 |
| Invalid bodies | 0 |
| Latency p50 | 473 ms |
| Latency p95 | 1,114 ms |
| Latency p99 | 3,015 ms |
| Maximum observed latency | 3,717 ms |

During a concurrent 12-sample VPS monitoring run, the service remained active with zero restarts. RSS stayed between approximately 303.0 MB and 303.5 MB. Runtime CPU samples ranged from approximately 26.5% to 75.8% for the single OMEGA-MINI process under this control-plane flood. Runtime event-loop p95 lag peaked at approximately 122.8 ms, and sampled maximum event-loop lag peaked at approximately 242.6 ms.

The HTTPS result is healthy but not “instantaneous.” The observed p95 and p99 include public TLS, network, client, and proxy effects; they are not equivalent to Telegram command latency or WhatsApp send latency. A real afternoon test should separately measure Telegram acknowledgement time, WhatsApp send completion, media-preview generation, Mongo/Redis latency, and queue wait time.

## What can honestly be guaranteed now

The system now has a stronger safety posture for heavy traffic. One session cannot fill the entire pending admission budget by default. Queue work remains fair and bounded. Rejections are explicit rather than unhandled. Socket retry counters and recent-message caches are bounded. History backfill cannot replay commands or anti-actions. The service survives a sustained 50-client control-plane flood without health failures or restarts.

What cannot be guaranteed from this test is that 50 real WhatsApp accounts will all maintain 0.6 dedicated CPU, that upstream WhatsApp will not rate-limit or restrict accounts, or that every media-heavy broadcast will complete at a sub-second latency. Those outcomes depend on group count, message rate, media size, preview generation, account state, WhatsApp server responses, network conditions, and concurrent Telegram/control-plane demand.

## Recommended operating envelope

For this 6-vCPU host, the safer initial production posture is to treat **50 registered sessions as an inventory ceiling, not as a promise of 50 simultaneously busy sessions**. Start with moderate concurrent active sockets, measure the runtime dashboard continuously, and preserve headroom for Redis, MongoDB, Telegram polling, preview/media processing, and recovery work. If event-loop p95 remains above approximately 100–150 ms for sustained intervals, if RSS grows continuously, if queue drops rise, or if reconnect/error counters increase, admission should shed low-priority work rather than allowing all sessions to compete equally.

A future scale-out design should partition sessions across multiple worker processes or hosts, with explicit per-process CPU and memory budgets. That is the architecture required to make a meaningful per-session CPU budget; increasing queue limits on one Node process would not create additional CPU capacity.

## Verification and deployment

The hardening build passed `npm run build` and the complete test suite: **28 test files and 253 tests**. The tested commit was pushed to GitHub `main` without force-pushing. The VPS rollout restarted only `pappy-omega-mini.service`, preserved protected environment/auth/storage/data directories and databases, returned health version `1.2.92`, and passed `npm run doctor:ci` for Node, owner configuration, encryption, storage, Telegram, Redis, and MongoDB.

No pairing, session migration, session purge, kick, approval/rejection, mass broadcast, or real WhatsApp traffic injection was performed. The live validation was deliberately read-only and non-destructive.

## Final post-deployment soak

After commit `9afbca2` was deployed, the public HTTPS health endpoint was tested again with 50 concurrent clients for 60 seconds. It completed 5,180 requests with 5,180 successful responses, zero failures, and zero invalid bodies. Latency was 461 ms at p50, 1,243 ms at p95, 2,514 ms at p99, and 5,279 ms at maximum. The service remained active/running with `ExecMainStatus=0` and `NRestarts=0`; the final health response was `ok: true`, package version `1.2.92`, with inbound and outbound queues at zero active and zero pending. The final runtime snapshot reported approximately 79% process CPU, 291 MB RSS, 82 ms p95 event-loop lag, and 236 ms maximum sampled event-loop lag. The post-deployment journal scan found no fatal, uncaught, crash, `SIGKILL`, crypto-storm, `smax-invalid`, or reconnect-scheduled event.

The higher maximum latency in this final public flood is a tail-latency observation, not a failed request or a process stall. It reinforces the need to monitor p95/p99 latency during real media and WhatsApp workloads rather than promising a fixed sub-second response under every possible traffic pattern.
