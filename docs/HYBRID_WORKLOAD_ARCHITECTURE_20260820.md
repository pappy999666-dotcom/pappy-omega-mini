# PAPPY OMEGA-MINI Hybrid Workload Architecture

## Boundary

PAPPY OMEGA-MINI remains one central Telegram bot and control plane. The owner VPS continues to host the full bot and can run owner-managed WhatsApp workers. A user panel receives only a restricted workload worker package. The package contains the Baileys session runtime, local encrypted auth storage, worker registration/heartbeat, assignment polling, and session-scoped execution. It does not contain the Telegram bot, Telegram token, admin controls, Mongo credentials, Redis credentials, or other users' session data.

## Control Channel

External workers use an outbound HTTPS polling channel at `WORKLOAD_CONTROL_URL`. This is deliberately separate from the private Redis bridge used by owner-operated VPS workers. The worker authenticates registration with a one-time enrollment token, receives a high-entropy worker credential over TLS, and stores only the credential locally. The user-facing five-digit display key identifies the pending worker but is never accepted as the sole authentication credential.

The worker sends a heartbeat every 20 seconds and polls for commands using a bounded long-poll interval. The server validates the credential, worker status, version, tenant, and assignment before returning a command. Commands carry a request ID, timestamp, expiry, and assignment ID. Results are posted with the same request ID and are idempotent.

## Placement Policy

`workloadMode=ON` is the additive default and preserves current behavior: new sessions use the owner VPS or owner-managed workers. `workloadMode=OFF` changes only placement for new sessions. New pairing requires a verified active user worker with capacity; existing sessions are not terminated or deleted when the mode changes. Migration of an existing session is an explicit, auditable operation: stop the current runtime without purging auth, create or validate the target assignment, transfer only the encrypted auth tree through the control channel, start the target runtime, verify readiness, then release the source assignment.

## Persistence

The control plane adds worker registry, workload assignments, worker events, durable commands, and workspace workload settings. Credential material is stored as a hash; the raw credential is returned only once during registration. Display keys are unique, rate-limited, scoped by the registering workspace, and expire or become unusable until the worker is verified.

## Failure States

Workers transition through `PENDING`, `CONNECTING`, `ACTIVE`, `UNREACHABLE`, `OFFLINE`, `ERROR`, `DISABLED`, `INCOMPATIBLE`, and `REVOKED`. A missed heartbeat marks a worker unreachable/offline but never deletes the worker, assignment, session metadata, or auth state. Reconnection re-authenticates the worker and replays only authorized assignments. Admin disable/revoke prevents new commands and assignment starts.

## Public API Surface

| Route | Caller | Purpose |
|---|---|---|
| `POST /workload/register` | Unregistered worker | Exchange one-time enrollment token for worker credential and display key |
| `POST /workload/heartbeat` | Authenticated worker | Update status, version, capabilities, load, and heartbeat |
| `POST /workload/poll` | Authenticated worker | Long-poll authorized commands |
| `POST /workload/result` | Authenticated worker | Complete an authorized command idempotently |
| `POST /workload/disconnect` | Authenticated worker | Graceful disconnect state update |
| `GET /workload/health` | Authenticated worker/admin | Verify control-plane reachability and compatibility |

All routes use request IDs, bounded body sizes, credential authentication, rate limits, tenant/assignment authorization, and redacted structured logging. The five-digit key is never used to authenticate a worker.

## Implementation Guardrails

The existing internal Redis bridge remains unchanged for owner-operated VPS workers. External panel workers use only the domain control channel. Existing Telegram callbacks continue to call the same service layer; local sessions use the existing Baileys transport directly, while panel-owned sessions enqueue an authenticated workload command. Existing session menus, broadcast jobs, Validator Hub, Join Manager, media, previews, and admin flows remain unchanged until their target session is explicitly assigned to an external worker.
