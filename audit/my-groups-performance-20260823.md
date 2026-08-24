# My Groups Performance and Stability Verification — 2026-08-23

## Diagnosis

The My Groups path had three avoidable latency and stability contributors. The control-side group inventory cache was only 10 seconds, the panel worker group-summary cache was 30 seconds, and every group-selection miss could synchronously reload the entire administrator inventory. Individual group moderation views also fetched live group metadata on every open with no read-only cache or in-flight deduplication. These behaviors were especially expensive for large sessions and made Telegram callbacks appear to do nothing while the WhatsApp inventory was still loading.

The existing selection cache was retained for two minutes to protect callbacks from rebinding after refresh. A bounded eight-second fallback was added to group selection: if a fresh inventory reload stalls and a prior selection exists, the prior stable JID-backed summary is used rather than allowing the callback to hang indefinitely. Mutation handlers continue to request fresh group metadata and revalidate administrator access.

## Implemented changes

The control-side inventory cache is now 60 seconds. The panel worker’s group-summary cache is now 60 seconds and was published as workload release 1.2.73. Read-only group metadata snapshots use a 30-second cache with in-flight request deduplication; mutation and durable Group Control paths remain fresh by default. The Members and Moderation read-only screens opt into the cache explicitly.

## Production evidence

The internal diagnostic endpoint was used locally on the control host with the Pappy session. It returns aggregate counts only in the recorded output; identifiers and participant data were not included in the report.

| Phase | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Before final metadata-cache deployment | 1,906 ms | 23 ms | 50 ms |
| After final deployment | 1,734 ms | 34 ms | 81 ms |
| Admin groups | 42 | 42 | 42 |
| Total members | 3,649 | 3,649 | 3,649 |
| Zero-member groups | 0 | 0 | 0 |

The first request is the unavoidable cold load from the live panel/WhatsApp inventory. Subsequent requests were served through the control/worker cache in tens of milliseconds. The Pappy workload reported `RUNNING` assignment, `ACTIVE` worker state, worker version `1.2.73`, and a fresh heartbeat. Both `pappy-omega-mini.service` and `pappy-panel-v3.service` were active. Only the control service was restarted.

No WhatsApp group mutation was performed. No join, approval, rejection, removal, block, group creation, broadcast, or destructive test was executed.

## Remaining limitation

The live cold load is still bounded by the panel’s initial WhatsApp group inventory refresh. The current implementation makes repeat opens fast and prevents indefinite selection waits, but it does not yet provide a persisted server-side administrator-group index independent of the live session. That would be the next architectural step if cold-open latency for very large inventories remains unacceptable.
