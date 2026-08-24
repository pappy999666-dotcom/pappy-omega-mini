# Dallstatus and Panel Inventory Release 1.2.56

## Delivered behavior

`dallstatus` is the canonical designed all-group status command, and `allstatusd` is its alias. Both now produce an `allstatus` workload intent with `styled: true`. The panel worker preserves that flag through checkpoint creation, restart recovery, and local delivery. When the payload contains a URL, the worker applies the existing per-group status design and randomized non-black background color while retaining the native link preview. Ordinary `allstatus` remains unstyled.

The shared `WorkloadBroadcastIntent` type now declares the optional `styled` property, preventing the design mode from being silently lost at the control-plane/panel boundary.

## Panel inventory hardening

Panel group inventory now uses a per-session in-flight request so concurrent callers do not create duplicate Baileys inventory queries. It retries transient failures with bounded backoff and a timeout, supports alternate Baileys inventory shapes including arrays, maps, object participant collections, `participantCount`, `participantsCount`, `size`, and `count`, and retains last-known verified inventory as a temporary fallback during transient failures. Broadcast group inventory and group-summary inventory are maintained independently. Session stop/logout cleanup removes all per-session inventory cache and in-flight state.

This prevents the panel from repeatedly showing unresolved totals because one transient inventory request failed, while avoiding an unbounded per-group metadata fan-out that would spike CPU or network usage.

## Verification

The full release gates passed: strict TypeScript typecheck, production build, single-file worker generation, worker syntax validation, and **146 tests across 15 files**. The focused designed-status and high-scale contracts passed **17/17 tests**, including direct execution of `allstatusd` and source checks for retry, normalization, in-flight sharing, and cleanup.

The deployed control plane reports package version **1.2.56** and remains active. The live panel service `pappy-panel-v3` auto-updated to worker version **1.2.56**, remains active, and reports a healthy heartbeat with one assigned session. The real assigned-panel inventory diagnostic returned:

| Metric | Live result |
|---|---:|
| Total groups | 59 |
| Total members | 9,419 |
| Groups with zero members | 0 |
| Panel worker status | ACTIVE |
| Panel worker version | 1.2.56 |

The smoke check used the actual assigned workload transport and live Pappy panel session, not a mocked socket. The panel worker artifact hash matched the control-plane worker artifact hash.

## Scope note

No mass broadcast was sent during verification because a live `dallstatus` would post to all 59 groups. The alias payload, panel update, inventory resolution, and design-routing path were verified without creating an unsolicited broadcast side effect. A controlled single-group send can be performed separately when desired.
