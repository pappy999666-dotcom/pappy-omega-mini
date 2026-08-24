# PAPPY OMEGA MINI — Auto Promote and Global Session Reconciliation

**Date:** 2026-08-22  
**Release:** 1.2.68  
**Scope:** Terminal session cleanup, Auto Promote persistence, and Global Bridge/Global Auto Promote eligibility.

## Outcome

The session-cleanup defect is fixed and deployed. A purged or logged-out session now loses all Auto Promote runs associated with its session ID, its child normal jobs are cancelled when a runtime orchestrator is available, and any SESSION-scoped Auto Promote configuration bound to that session is permanently removed.

USER and GLOBAL configurations remain intact. If one of those configurations contains an explicit target list, the purged session ID is removed from that list. If the purge leaves a fixed-target configuration with no targets, the configuration is retained for auditability but disabled and marked CANCELLED. Configurations representing all active and future sessions have no explicit target list and remain intact.

The purge ordering was also corrected. The session is removed from the in-memory/persisted registry before Auto Promote reconciliation, preventing the scheduler from observing it as ACTIVE and recreating a run during the purge window.

## Global session selection

Global Bridge and Auto Promote now apply the same eligibility rule: `status === ACTIVE` and `authHealth === VALID`. Degraded, invalid, revoked, logged-out, or otherwise non-ready records are excluded. Admin Global Bridge uses the all-workspace eligible set; regular users remain restricted to their own workspace. Each selected session is routed through its own workspace ID.

The stale record that caused the apparent discrepancy was not a second usable panel session. It was session `dd8245de-8105-4f55-860c-6ca76f07dbf0`, whose worker was missing and assignment was REVOKED with `Workload worker removed.` It was purged through the canonical session-purge path. The active Pappy panel session `0776b9ca-e4ff-4882-82a2-409d287e536a` was preserved.

## Verification

| Check | Result |
|---|---:|
| TypeScript typecheck | Passed |
| Full regression suite | **164/164 tests passed** |
| Production build | Passed |
| Control service | Active |
| External panel service | Active; not restarted during deployment |
| Control health | `ok: true`, package `1.2.68` |
| Global workload mode | `OFF` |
| Local VPS sessions | 0; remaining records are panel-backed |
| Remaining registry sessions | 2 |
| ACTIVE/VALID eligible sessions | 2, across their respective workspaces |
| Purged stale session present | No |
| Auto Promote runs for purged session | 0 |
| Explicit Auto Promote target references to purged session | 0 |
| Auto Promote records unrelated to the stale session | Preserved |

The two remaining eligible sessions are Pappy and Veya. The Pappy session is ACTIVE/VALID with its live panel worker and was not modified. The Veya session is also ACTIVE/VALID with a live panel worker in its own workspace. Therefore an admin Global Bridge or Global Auto Promote picker should truthfully show two eligible sessions; a regular user sees only eligible sessions in that user’s workspace.

## Deployment safety

Only the compiled control-plane `dist` artifact was deployed. The external panel worker package and panel authentication/session directories were not changed. An on-host backup was created before the final deployment under `/opt/pappy-omega-mini/.deploy-backups/autopromote-eligibility-20260822145223`.

No WhatsApp test message, broadcast, pairing, or active panel authentication operation was performed.

## Remaining note

The database still contains historical Auto Promote runs belonging to other sessions and schedules; the verification found no runs or target references tied to the purged session. This is expected and preserves unrelated schedules. The existing local-session reconnect-tombstone risk remains a separate lifecycle hardening item and was not broadened into this scoped panel reconciliation change.
