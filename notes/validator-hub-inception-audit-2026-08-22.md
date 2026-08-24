# Validator Hub Inception Audit

**Date:** 22 August 2026  
**Scope:** Centralized WhatsApp group-link intake, validation, bucket transitions, leases, session allocation, retry behavior, and live deployment safety.

## Executive conclusion

The Validator Hub had three independent causes of the reported behavior. First, duplicate intake always wrote an existing canonical link into `Main`, even when that link was already `Active`, `Validating`, or `Dead`. Second, the manual maintenance action explicitly merged `Active` into `Main`; this was an unsafe remnant of the former per-user bucket model. Third, the validator guard repeatedly retired the same session based on scheduler messages such as “No healthy WhatsApp validation session,” and on historical failed jobs surviving a service restart. Together these defects made the dashboard appear to move links backward and could prevent fresh validation admission.

The code was corrected and deployed to the control plane. The external panel service was not restarted and its authentication data was not modified. No WhatsApp test message or broadcast was sent.

## Findings

| Area | Finding | Effect |
|---|---|---|
| Duplicate intake | `collectLinks` called `upsert(... bucket: "main")` for every re-seen URL. | A duplicate of an Active link could pull it back into Main; a duplicate of a Dead or Validating link could also overwrite its authoritative state. |
| Manual maintenance | `mergeValidatorBuckets` moved Validating, Active, and Error records into Main. | The “Requeue Active + Retryable” control could intentionally drain verified Active links. |
| Session eligibility | Validation allocation was tightened to `ACTIVE` plus `VALID` auth health and a fresh health timestamp. | Degraded, unknown, invalid, or stale sessions cannot receive validation leases. |
| Panel health | Panel worker heartbeats refreshed the worker but not the assigned session’s `lastHealthyAt`. | A live external panel could become invisible to validation after the five-minute health window. |
| Registry freshness | Heartbeat and validator admission did not always merge persisted panel sessions into the in-memory registry first. | Sessions created or assigned after startup could be treated as historical or missing. |
| Batch throughput | Admission was effectively one link per available session per sweep. | Large imports were needlessly throttled by the five-second sweep cadence. |
| Rate-limit handling | A rate-limit failure could leave the untouched tail of a five-link batch in Validating until stale-lease recovery. | Links appeared stuck and the affected socket could be hammered by further work. |
| Guard retirement | Scheduler-level “no healthy session” outcomes and old terminal jobs could retire a valid session repeatedly. | The validator could self-lock even after the original failure had ended. |
| Active admission | Invite validation accepted incomplete metadata. | A malformed or incomplete response could be trusted too early. |

## Implemented behavior

Duplicate collection is now idempotent. An existing record keeps its authoritative bucket, validation state, lease token, error state, and terminal metadata. Only a record already in Main receives the pending-validation flag again. This means re-posting a known Active link does not remove it from Active, and re-posting a known Dead link does not resurrect it.

The maintenance action now requeues retryable Error records only. Active is treated as a verified terminal validation bucket. Stale Validating leases remain under the guard’s controlled stale-lease recovery path rather than being bulk-moved by a manual “merge” action.

Validator admission now refreshes the persisted session registry, requires `ACTIVE` and `VALID` health, and feeds up to five links per eligible session. Requests remain serialized within each WhatsApp socket to avoid creating an artificial invite-validation burst. Separate sessions continue to operate independently.

A rate-limit response stops the current small batch and immediately releases all untouched matching leases back to Main. This avoids leaving work stranded in Validating. Temporary transport, timeout, connection, decryption, and scheduler failures remain retryable; only link-specific confirmed invalidity is allowed to enter Dead. Active admission now requires a concrete WhatsApp group JID ending in `@g.us`.

Panel heartbeats now refresh the health timestamp for their assigned ACTIVE/VALID sessions, and the registry is merged before durable assignments are filtered. This keeps an actually connected external panel eligible without resetting its authentication state.

The Validator Guard now considers terminal validation jobs from the current service run rather than replaying all historical failures after every restart. Scheduler messages indicating that no healthy validator was available are not treated as socket failures.

## Test and build evidence

The complete regression suite passed:

| Verification | Result |
|---|---:|
| Test files | 17 passed |
| Assertions/tests | 167 passed |
| TypeScript production build | Passed |
| Focused Validator invariants | 3 passed |
| Focused workload and allocator tests | 32 passed |
| Control health after deployment | `ok: true` |
| Control service | Active |
| External panel service | Active |

The expected sandbox Redis connection-refused messages appeared only in tests that intentionally run without the production Redis service. They did not fail the suite.

## Live state after deployment

The live centralized inventory was read without modifying bucket contents:

| Bucket | Count |
|---|---:|
| Main | 3,863 |
| Validating | 0 |
| Active | 751 |
| Dead | 41 |
| Error | 0 |

The control service reported a healthy control endpoint and the external panel service remained active. The preserved Pappy session reported `ACTIVE` and `VALID`, and its health timestamp was renewed by panel heartbeats.

## Remaining live blocker and honest timing limit

The live validator probe and recent job records show the current Pappy socket receiving genuine WhatsApp `growth-locked` responses. The control plane correctly returns those links to Main and retires the affected socket temporarily. It does not move them to Dead and does not put them into Active without successful group metadata.

Veya is not available as a second validator because its WhatsApp session previously reported `LOGGED_OUT` and `INVALID`; its assignment was revoked and its session was purged. Therefore only one eligible validator socket currently exists. The current Main inventory requires approximately **1.073 links per second** if one socket alone is expected to finish all 3,863 links within one hour. That rate cannot be guaranteed while WhatsApp is actively growth-locking the socket. The system can meet the one-hour target only when enough ACTIVE/VALID sockets are available and WhatsApp permits the required request rate.

The correct operational path is to reconnect Veya or add another healthy panel session. Once a second ACTIVE/VALID socket is available and not rate-limited, the distributor will assign separate links across the available sessions. A growth lock must not be bypassed by increasing concurrency; doing so would worsen account restrictions and could make validation less reliable.

## Safety status

The deployed changes are control-plane-only. The external panel process was preserved, panel authentication was not changed, the active Pappy panel session was not purged, and no outbound WhatsApp test traffic was generated. The system now guarantees the important data invariant: **a confirmed Dead link cannot be promoted to Active by duplicate intake or manual Active merging, and an Active link cannot be pulled back into Main by duplicate intake.**

## Follow-up investigation: both sessions retired

The later Live dashboard screenshot is consistent with the live database state. The two visible sessions are Pappy and Messiah; both are `ACTIVE` and `VALID`, but both are currently retired by the Validator Guard because their recent Baileys invite-validation attempts returned `growth-locked`. Pappy had four recent rate-limit events and Messiah had six. Their cooldown timestamps were still in the future during the check, so the allocator correctly reported `Eligible: 0` and `Leased: 0`.

This is not a queue stuck in Validating: the live counts were `Main 3,863`, `Validating 0`, `Active 751`, `Dead 41`, and `Error 0`. No link was stranded in a lease. The recent five-link jobs stopped after the first growth-lock result and returned the untouched links to Main, which is the safe behavior. The control service and external panel service both remained active.

The Live dashboard was additionally updated to display each retired session’s remaining cooldown, retirement reason, and failure count. It also now accurately describes the five-link admission batch and one-request-at-a-time socket policy. The decision not to bypass WhatsApp growth-lock cooldowns is intentional: forcing concurrency would increase account restriction risk and would undermine the invariant that only successfully validated groups enter Active.

**Operational interpretation:** the validator is waiting for a permitted WhatsApp validation window, not silently dropping links. When a cooldown expires, the next sweep can retry Main links. If WhatsApp continues returning growth-lock responses, the session will be retired again until a healthy validation socket or additional panel session is available.
