# Pappy Worker Live-Load Verification — 2026-08-23

## Scope and safety

This verification used the live Pappy workload and the real control-plane enqueue/completion path for read-only `groupMetadata` requests. No synthetic WhatsApp messages were sent. No group was joined, created, approved, rejected, removed, blocked, or otherwise mutated. Concurrent traffic consisted only of bounded local health requests while the live worker was processing its normal activity.

## Baseline

At the beginning of the watch, both `pappy-omega-mini.service` and `pappy-panel-v3.service` were active. Control health returned `ok:true`. Pappy’s assignment was `RUNNING`, the worker was `ACTIVE`, the worker release was `1.2.74`, and the heartbeat was fresh. The control process showed normal memory usage but elevated CPU during live activity. Recent logs showed inbound/notification processing and an existing Baileys JSON notification parsing warning.

## Real-path selection test

The probe first resolved the Pappy inventory through the local-only inventory diagnostic. It reported 41 groups, 2,709 total members, and zero zero-member groups. Four sampled group identifiers were then sent one at a time through the new localhost-only diagnostic route. That route uses the same `queueWorkloadCommand` notifier used by production control flows, then waits for the durable worker result.

| Measurement | Result |
|---|---:|
| Read-only selections issued | 4 |
| Completed | 4 |
| Exact requested-group matches | 4/4 |
| Endpoint elapsed times | 322–778 ms |
| Client elapsed times | 366–802 ms |
| Concurrent health requests | 32 |
| Health p50 / p95 / max under that load | 10.58 / 31.28 / 48.20 ms |

The results confirm that the real enqueue path is materially different from the earlier direct-database diagnostic: direct insertion bypassed the production wake-up notifier and produced approximately 9–16 second queue waits, while the real path completed every selection in under one second. This validates the worker background-chain fix for `groupMetadata` and `listGroupSummaries` under the tested live conditions.

## Post-test state

After the test, both services remained active and control health continued to return `ok:true`. The Pappy worker remained `RUNNING`/`ACTIVE` on release `1.2.74`; the observed heartbeat age was 15.8 seconds against the 20-second heartbeat interval. No diagnostic command records remained.

## Caveat

The control journal contained repeated existing Baileys notification parsing errors (`Unexpected non-whitespace character after JSON at position 15`) during the observation window. They did not stop the control service or invalidate the four exact group-selection results, but they are a separate operational risk and should be investigated in a dedicated Baileys decryption/notification-storm task. This verification therefore demonstrates stable read-only group selection under the tested load, not complete elimination of all live-session log noise or CPU pressure.
