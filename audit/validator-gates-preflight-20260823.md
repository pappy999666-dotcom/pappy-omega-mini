# Validator production gates — preflight

**Timestamp:** 2026-08-23 05:08:34 UTC

The control service and external panel service were both active. The workload health endpoint returned HTTP success with control package version 1.2.72 and a 20-second heartbeat interval. Redis returned PONG and MongoDB returned a successful ping. The durable validator dual-write flag was not present in the checked environment files, so the new Mongo validator collection is not being populated by live Redis operations; the current `validator_links` collection count was 0. This is expected for the migration slice and means production stress must not be described as Mongo-source-of-truth validation.

The host had 46% root-disk usage, approximately 4.3 GiB used of 7.8 GiB RAM, 3.4 GiB available, and load averages of 1.52, 1.73, and 1.79. There were 10 workload-worker records, 8 active at the sample, 5 persisted WhatsApp sessions, 4 active sessions, and 3 panel-assigned sessions. Recent deploy backups were present. No state was modified during preflight.

## Non-disruptive production responsiveness gate

A bounded read-only gate issued 40 control health requests over approximately ten seconds, with a Redis PING and Mongo ping on every iteration. All 40 control requests, Redis pings, and Mongo pings completed. Health latency was: minimum 1.4 ms, median 2.9 ms, p95 38.4 ms, maximum 72.2 ms, and mean 9.1 ms.

At the observation point, Redis bucket cardinalities were Main 5,987, Validating 0, Active 320, Dead 48, and Error 0. There were 546 Redis job keys. The Redis `total_error_replies` counter was 62,879. This counter is cumulative and was not reset; it is a warning signal requiring a separate error-source audit, not proof that this test generated the errors. The gate did not enqueue work, mutate links, contact WhatsApp, or create Telegram traffic.

**Gate result:** control responsiveness passed for the bounded read-only load. Validator processing capacity was not demonstrated because the live validator currently had zero Processing records and the durable Mongo collection is empty while dual-write is disabled.

## Production Redis index-integrity gate

A read-only scan counted 6,355 canonical Redis link-record keys and the bucket cardinalities summed to 6,355 at the sample. The bucket distribution changed by one during the observation window from Main 5,987/Active 320 to Main 5,986/Active 321, while the total remained constant; this indicates live validator/join activity is moving records but did not create a count mismatch in this sample. Validating and Error were zero, and representative members were present in Main, Active, and Dead. This is a Redis index-consistency pass only; it is not proof of durable database truth because the Mongo `validator_links` collection remains empty while dual-write is disabled.

## Live session capability comparison

The exact deployed panel transport was exercised read-only for each current panel-assigned session. Pappy was `ACTIVE`/`VALID` and successfully fetched 42 participating groups in 14.6 seconds. Aura was `ACTIVE`/`VALID` but its group-inventory request failed with `Control request failed (413)` after 18.2 seconds. Paddy was `DEGRADED`/`DEGRADED` and its request also failed with `Control request failed (413)` after 11.2 seconds. The temporary probe was removed and its orphaned process was terminated by targeted PID.

This proves the apparent contradiction is real but has two separate causes. First, the Validator Hub group matrix is built from the existing Redis `active` bucket: `getValidatorSnapshot()` counts Redis buckets and takes recent records from `validating`, `active`, `main`, `dead`, and `error`; the UI then renders those recent link records as the Group matrix. It does not prove that the current session can perform a fresh validation request. Second, live session capability is not uniform: Pappy can fetch group metadata, while Aura and Paddy hit a 413 control boundary. A group-inventory success is also not equivalent to a successful invite-validation operation; the latter is where rate-limit text was observed.

Therefore an `ACTIVE · VALID` session can legitimately appear alongside existing Active groups and still be ineligible for fresh validation under the current policy. The UI currently mixes historical Active-link state, current session eligibility, and live worker capability in one screen without making that distinction explicit.

## Invite-validation contradiction and policy correction

The exact read-only `groupGetInviteInfo` path was tested against one existing Active invite. Both currently `ACTIVE`/`VALID` panel sessions, Pappy and Aura, returned valid JID and subject metadata successfully. Pappy completed in approximately 5.1 seconds and Aura in approximately 2.0 seconds. No group was joined, changed, or created.

This confirms that successful group inventory and successful invite validation are separate capabilities, and that the earlier rate-limit labels were not proof that every account was bad. The dashboard’s Group matrix is historical/current Redis Active-link state; the validation worker’s rate-limit counter is generated by fresh `groupGetInviteInfo` operations. A session can therefore show Active groups and still experience temporary rate limits on new invite validation, but the UI previously made that look like account retirement.

The correction was implemented and deployed after 173/173 regression tests, TypeScript validation, and a production build passed. Legacy rate-limit cooldowns with fewer than three consecutive new restriction signals are re-admitted as ACTIVE/VALID; a session is retired only after three consecutive rate-limited invite-validation signals. Successful invite validation resets the consecutive counter and clears the effective cooldown. Validator Hub Eligible/Retired totals now use the same effective predicate as the scheduler.

After deployment, the live registry showed 5 total sessions, 2 eligible and 2 retired at the observation instant; Pappy had accumulated four consecutive rate-limited validation signals and Main three, while Pappy1p1 had two and Aura one. Pappy and Aura’s separate direct invite-validation probes were successful, so the remaining rate-limit state reflects validation-volume/cooldown behavior, not a confirmed logged-out or invalid account. Paddy remained DEGRADED/DEGRADED and was correctly ineligible.

The control service and external panel service were both active, health returned `ok: true`, and only the control service was restarted. No outbound WhatsApp write was performed.

## Self-lock diagnosis and live recovery

The first link-scoped deployment still showed the old zero-eligible screen because the live validator had already entered a self-lock state. Its queued jobs were repeatedly completing with `No healthy WhatsApp validation session is available yet.` after all sessions had been retired; those admission failures were not fresh proof that the accounts were bad. The earlier session-level cooldown records therefore needed a one-time, explicitly scoped re-admission reset.

The production control service was redeployed with the corrected behavior: per-link rate-limit results now increment telemetry but never set a future session retirement timestamp; only non-rate-limit repeated transport failures can retire a session. Four ACTIVE/VALID stale retirement records were then cleared to a past timestamp with consecutive counters reset to zero. The DEGRADED Paddy session was not altered.

After 15 seconds, the live host returned healthy control and panel services. The session records showed four ACTIVE/VALID sessions with retirement timestamps in the past and one DEGRADED session remaining ineligible. Redis buckets moved from Main 5,968 / Validating 0 / Active 343 to Main 5,951 / Validating 17 / Active 345 / Dead 48 / Error 0. The increase to 17 Validating records and the Main decrease prove that the automatic admission sweep resumed and began processing instead of remaining at Eligible 0.

This is the verified recovery state at the observation instant. The Telegram message may still display the previous cached snapshot until its Refresh Live Log action runs; the authoritative live state is four eligible ACTIVE/VALID sessions, 17 links currently validating, and the DEGRADED session excluded.
