# Authoritative Plan Status

## Current baseline

The repository already contains the pappy-omega-mini identity, workspace/session registry, shared Telegram/WhatsApp menu model, concise command registry, workspace-scoped Admin Media, Baileys transport boundary, encrypted auth-state storage, structured errors, audit events, quota definitions, emergency controls, Docker/Compose artifacts, and doctor checks. The VPS runs this baseline under PM2 with Telegram, Redis, MongoDB, storage, and encryption checks passing.

## Roadmap mapping

| Blueprint phase | Current status | Safe next increment |
| --- | --- | --- |
| A. Session/auth and deployment foundation | Partially implemented | Add interactive setup wizard, graceful shutdown coordinator, distributed session lock, reconnect backoff/jitter, and durable auth/session repositories. |
| B. Telegram control plane | Starter implementation | Add force-join target repository and verification, pairing progress state machine, paginated session callbacks, bridge flows, support inbox, and admin user controls. |
| C. WhatsApp command engine | Starter implementation | Add full quoted-message/media resolver, native profile/group operations only after verifying installed exports, pairing-from-WhatsApp, join manager commands, and safe error rendering in replies. |
| D. Queues and jobs | Not yet implemented as production workers | Add Redis/BullMQ queue contracts, bounded workers, job lifecycle, idempotency keys, pause/stop/cancel, retry, progress, and recovery. |
| E. Buckets and validator | Not yet implemented | Add durable link schema, canonical deduplication, Main/Active/Dead/Error/Master services, link collector, validator workers, styled TXT/HTML exports, and live progress. |
| F. Preview pipeline | Not yet implemented in this clean repository | Add centralized URL detector, preview cache, partial hydration, schema versions, host circuit breakers, metrics, and sender integration. |
| G. Scheduling/admin/cleanup | Partially represented by control-plane types only | Add schedules, auto-promote, broadcasts, emergency UI, audit persistence, quotas, cleanup workers, and admin analytics. |
| H. Quality/deployment | Partially implemented | Add migrations, setup wizard, CI secret/import/isolation gates, Docker health integration, and regression tests for every reliability fix. |

## Implementation rule

The next code increment should be **Phase A completion**. Do not implement mass operations, aggressive tagging, or bulk joining before session locks, queue backpressure, idempotency, rate controls, and recovery are in place. Do not promise absolute preview success; implement preservation, hydration, caching, circuit breakers, and safe fallback.
