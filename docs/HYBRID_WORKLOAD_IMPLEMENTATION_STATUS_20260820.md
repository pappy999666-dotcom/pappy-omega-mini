# Hybrid Workload Implementation Status

## Completed in the implementation branch

| Acceptance item | Status | Evidence |
|---|---|---|
| Existing project audit and Git backup | Complete | Pre-change audit plus legacy checkpoint branch and implementation branch |
| One central Telegram bot | Complete | No second Telegram process is introduced |
| Owner workload ON/OFF | Complete | Workspace field, persistence, Telegram user/admin controls |
| Owner-managed VPS worker compatibility | Complete | Existing `PROCESS_ROLE=worker` and Redis bridge remain intact |
| Restricted panel worker package | Complete | `worker-package/index.js`, `package.json`, and `README.md` |
| Download flow | Complete | Telegram Workload menu delivers the official three-file package |
| Secure worker registration | Complete | One-time enrollment token, hashed credential, HTTPS-only package URL contract |
| Five-digit display key | Complete | Key identifies a worker; it is never used as authentication |
| Heartbeat and status | Complete | Authenticated heartbeat, compatibility check, stale-worker sweep, session-status reporting |
| Session assignment | Complete for new pairings | Assignment is workspace-scoped and requires fresh heartbeat, ACTIVE status, and compatible version |
| Central session control | Complete for supported transport surface | Local-vs-panel socket proxy covers profile, groups, media sends, invite operations, and job transport calls |
| Pairing | Complete for new panel sessions | `session.pair.request` executes on the assigned panel worker |
| Reconnect/failure recovery | Complete for control-plane state | Worker offline state preserves workers, assignments, sessions, and auth; stale leases are requeued |
| Telegram UI | Complete for the new workload surface | User Workload menu, setup token, key attach, panel status, download, guide; admin mode/worker controls |
| Security boundary | Complete for implemented protocol | No Telegram/Mongo/Redis credentials in worker package; workspace/worker/assignment checks are enforced |
| Regression gates | Complete | Strict TypeScript and **107/107 tests passing** |

## Activation items requiring the user’s domain

The control server is intentionally disabled by default and binds to localhost when enabled. A domain with TLS must be supplied before exposing `/workload/*`. The provided Nginx template exposes only that path and returns 404 for all other paths. Redis and MongoDB remain private.

## Deliberately deferred until the public endpoint is available

Existing-session migration from an owner VPS to a panel worker is not triggered implicitly. The code preserves an explicit migration policy: workload mode affects new sessions, while existing sessions continue safely until an audited migration operation is implemented and verified. External inbound text, quoted text, identity, and mentions are supported; full binary media-download forwarding from panel to control plane requires the public endpoint and a live acceptance test before being enabled for user workers.

## Current artifacts

The restricted worker archive is `/home/ubuntu/pappy-omega-mini-worker-package-v1.0.0.tar.gz` with SHA-256 `fea15e0cb39c6d761681f6df39b4e7db38b24e66910791efc11b6524f1e61662`. The implementation branch currently contains commits `d2bb3ce` and `6dcd2b1` after the audited baseline.
