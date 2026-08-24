# Pappy 7750 My Groups Comparison — 2026-08-23

The live session ending in 7750 is the `Pappy` session, with an ACTIVE WhatsApp session, RUNNING workload assignment, ACTIVE worker, and worker release 1.2.74.

Omega-V1’s executable `.mygroups` route performs `socket.groupFetchAllParticipating()` directly, filters administrator groups in memory using the socket’s own JID plus phone/LID variants, renders 20 groups per page, and stores a short callback key containing the exact JID (`storeGcJid(sessionId, g.id)`). Opening a group resolves the stored JID and immediately calls `groupMetadata`.

OMEGA-MINI currently calls `listAdminGroups()` for every My Groups render and also uses numeric index callbacks (`group:view:<index>`). `getSessionGroupAt()` first checks a TTL cache keyed by workspace/session/index, but on a cold or stale entry it refetches the full admin-group list and selects by current array index. This creates two key differences from Omega-V1: a cold selection can wait for a full inventory call, and an index callback can fail or select no group if the returned ordering changes. OMEGA-MINI’s prior 8-second bound prevents indefinite hanging but does not provide Omega-V1’s direct JID-backed open path.

The deployed real-path probe after the background-chain fix showed 4/4 exact group matches in 322–778 ms for the Pappy worker, but the user’s report indicates the actual Telegram flow still differs from that diagnostic. The next investigation must test the actual callback/JID path and inspect whether 7750’s inventory path is returning a changed or incomplete admin-group list, rather than assuming the generic worker timing probe proves the UI is fixed.

## Live UI-equivalent probe after stable-token deployment

A temporary redacted probe ran against the live Pappy session using the production `listAdminGroups` path, the same 20-row page size, the new short-token store, and read-only moderation snapshots for representative rows. It returned 19 administrator groups on one page. All tested selection tokens resolved to the exact captured group, with 0 ms in-process resolution and callback payloads of 57 UTF-8 bytes. Each read-only moderation snapshot loaded successfully and reported `isAdmin: true`.

However, the cold admin-list call took approximately 24.8 seconds, and the three tested read-only snapshot calls took approximately 18.7–20.7 seconds each. The remote probe timed out while collecting its final sample, and its cleanup command was therefore not guaranteed by the shell sequence; remote `/tmp/probe-pappy-ui-equivalent.mjs` must be checked and removed before closing the diagnosis.

The transport code confirms why this is slow: `listAdminGroups` calls `listGroups`, which invokes the worker’s `listGroupSummaries`; the worker performs a full `groupFetchAllParticipating()` and computes admin status for every group. The worker’s `workerOwnAdminRole` is local metadata inspection except for an uncommon missing-identity fallback, so the dominant cold cost is the full Baileys inventory call, not a per-group metadata request. OMEGA-MINI’s UI currently awaits this cold call before editing Telegram, whereas Omega-V1 directly uses the live socket and renders its page after the same inventory call, with no numeric-index refetch on group click.

This separates the two fixes: stable selection tokens address the “click does not open / wrong index” failure; a warm, stale-safe inventory path is still needed to make the initial My Groups render feel like Omega-V1 under a large panel account. Read-only snapshots should also use a warmed per-JID metadata cache where available, but no WhatsApp mutation is permitted.
