# High-Scale Audit Findings

Date: 2026-08-21
Baseline: `8ea9171` / `pre-high-scale-rebuild-20260821`

## Confirmed architecture gaps

1. Native panel `.allstatus` currently enters `routeWhatsAppText` on the control plane. The enqueue adapter calls `listGroups(workspaceId, sessionId)` before creating the durable broadcast job. For panel sessions, that becomes a remote `bridge.command` request for `listGroupSummaries`.
2. The panel `listGroupSummaries` implementation calls `groupFetchAllParticipating()` and builds an in-memory array containing JID, subject, and participant count for every group. The control plane then stores/transfers the resulting array and places all group JIDs into the broadcast job payload. This violates the worker-local intent requirement and can create large control/database payloads.
3. The control server limits request bodies to 8 MiB, but the observed HTTP 413 is likely upstream or panel-gateway generated because the panel reports `Control request failed (413)`. Exact route/body-size instrumentation is still required. The design must eliminate giant payloads rather than increase the limit.
4. `rate-overlimit` is surfaced from the panel control path during group inventory resolution. The current implementation has caching and fallback, but the cold path still depends on a full Baileys inventory fetch and the command cannot start until it completes. The source must be classified separately from command-level limits and handled with bounded backoff and scoped degradation.
5. Panel `bridge.command` currently serializes transport results through the generic workload command result. The new high-scale path should carry intent such as job ID, session ID, operation, parameters, and a media reference only; the worker must retain the group catalog and execute the large job locally.
6. The current panel worker command loop serializes commands per session through `commandChains`, which is useful for session safety but must not serialize unrelated jobs globally or prevent independent broadcast/job lanes from progressing.
7. The current `allstatus`/`allchat` job contract expects `payload.groups` and therefore requires pre-resolution on the control plane. A worker-local broadcast command/job contract is required for panel parity.
8. Join Manager and Validator have already been centralized and lease-hardened, but their high-scale acceptance still requires live evidence that Validator only consumes global Main, Join Manager only consumes global Active, and restart recovery reuses durable jobs.

## Reproduction evidence from screenshots/logs

- Panel logs: `command bridge.command failed`, `ERROR rate-overlimit`.
- Panel logs: `Control request failed (413)`.
- Panel logs: `Unable to resolve WhatsApp groups before allstatus: Control request failed (413)`.
- Control-plane traces show the inbound `.allstatus` event can be marked `processed` while no outbound acknowledgement trace is recorded; object replies with nativeFlow were previously fire-and-forget and have since been hardened, but a fresh post-rebuild verification remains required.

## Required redesign direction

- Add a worker-local durable broadcast engine for panel-owned sessions.
- Keep large group IDs/catalogs local to the worker and process them through bounded iterators/queues.
- Replace pre-enqueue full inventory transfer with a compact start-intent acknowledgement containing a job reference and worker-local inventory state.
- Add compact progress events and aggregate counters rather than sending group lists through the control plane.
- Add payload-size/route/status observability at both control server and worker control client.
- Add scale fixtures for 10, 100, 1,000, 2,000, 5,000, and 10,000 groups plus large participant counts, without loading participants when broadcast does not need them.
- Add failure injection for 413, rate-limit, 5xx, network loss, worker restart, and control-plane restart.

## Acceptance rule

No release is complete while panel allstatus depends on a full group list crossing the control plane, while the panel differs behaviorally from the VPS worker, or while the system reports a normal-ready broadcast after unresolved inventory failure.

## Source constraints

Panel workers must not contain Telegram tokens, Mongo URIs, or Redis URIs. The owning worker may use its local Baileys runtime and local encrypted state; the control plane must retain only durable intent, references, and aggregated status.
