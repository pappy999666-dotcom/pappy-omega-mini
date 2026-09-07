# AUDIT — Baileys Engine Stability & Optimization — 2026-09-06

Scope: `pappy-omega-mini` running the installed fork `@crysnovax/baileys@2.7.15`
("PLOGME · premium WhatsApp engine", based on upstream Baileys ~v6.7.x). This audit
is intentionally **not** a migration plan. It answers: what is the engine doing,
what is missing, what is configured but unused, what is risky, and what should
change for stability and optimization on the current 6 vCPU / 11 GB VPS.

Companion to the earlier operational pass (debug-log removal, concurrency &
watchdog tuning, bounded session store, terminal broadcast-job errors — all live
since 13:53 UTC+2 on PID 781121).

---

## 1. Runtime snapshot (live, ~21 min after deploy)

| Metric | Value |
| --- | --- |
| Service | `pappy-omega-mini.service` (systemd, user `pappy-omega`, restarts=always) |
| Process | single Node 22 process, `dist/src/index.js`, ~11 threads (1 JS thread + libuv pool) |
| Sessions | 16 ACTIVE WhatsApp sessions, 3 BANNED (in Mongo) |
| Tenants | 1001 workspaces / 987 users |
| RSS | ~1.62 GB and **plateauing** (was climbing 30–50 MB/min pre-fix) |
| CPU | still high: 80–137% averaged across threads during busy windows |
| Watchdog | 2400 MB threshold; **0 watchdog restarts** since deploy (was every 10–40 min) |
| Broadcast queue | 5 active, 0 waiting, 0 new failures; no stalled jobs since deploy |
| Log volume | ~10–20 lines/min (was thousands/min) |

Conclusion of the live pass: the process is now **stable and responsive**; the
remaining issue is **headroom**, not an immediate crash loop.

---

## 2. Engine configuration matrix (fork defaults vs. what the app sets)

`src/whatsapp/session-manager.ts` → `BAILEYS_SESSION_SOCKET_OPTIONS` +
`makeWASocket` call. Fork defaults from
`node_modules/@crysnovax/baileys/lib/Defaults/index.js`.

| Option | Fork default | App value | Verdict |
| --- | --- | --- | --- |
| `version` | `[2, 3000, 1040735178]` | (inherited) | OK — do not pin |
| `browser` | `macOS('Chrome')` | (inherited) | OK |
| `keepAliveIntervalMs` | 15000 | 15000 | OK |
| `connectTimeoutMs` | 20000 | 20000 | OK |
| `defaultQueryTimeoutMs` | 60000 | 60000 | OK |
| `markOnlineOnConnect` | true | **false** | deliberate (anti-ban); keep |
| `syncFullHistory` | true | **false** | deliberate; keep |
| `retryRequestDelayMs` | 250 | **0** | RISK — see §4.1 |
| `maxMsgRetryCount` | 3 | **0** | RISK — see §4.1 |
| `enableAutoSessionRecreation` | true | **false** | deliberate (storm guard); keep |
| `enableRecentMessageCache` | true | **false** | required for this fork revision (missing methods); keep |
| `fireInitQueries` | true | **(not set → true)** | MISSING lever — see §4.2 |
| `shouldIgnoreJid` | `() => false` | **(not set)** | MISSING lever — see §4.3 |
| `shouldSyncHistoryMessage` | skip `FULL` only | **(not set)** | consider tightening — see §4.4 |
| `generateHighQualityLinkPreview` | true | **true** (explicit) | COST — see §4.5 |
| `appStateMacVerification` | `{patch:false, snapshot:false}` | **(not set)** | decision needed — §4.6 |
| `getMessage` | none | custom bounded cache | OK |
| `cachedGroupMetadata` | none | custom bounded cache (512 / 15 s) | OK |
| `emitOwnEvents` | true | (inherited) | **required** for `fromMe` command path; keep |
| `logger` | pino | custom sanitizing pino (`PAPPY_WA_LOG_LEVEL` default warn) | OK |
| `store` | none | **replaced 2026-09-06** with bounded contact-only store (was unbounded `makeInMemoryStore`) | fixed |

---

## 3. Stability infrastructure already present (working)

- Per-session lifecycle supervisor with reconnect cooldown & generation checks.
- Crypto failure guard (12 errors / 30 s window) + recovery circuit with cooldown.
- Per-message decrypt/noise log suppression (1 summary/minute instead of per-line).
- `smax-invalid` stanza rejection suppression (no reconnect per rejection).
- Signal-key cache with 5-minute TTL (fork default).
- Whole-process memory watchdog → controlled shutdown instead of V8 heap OOM.
- Inbound admission queue with global/per-session concurrency & pending caps.
- BullMQ job orchestrator: 4 queues (jobs, broadcasts, panel-broadcasts, validator),
  reaper (30 s) + Inceptor (45 s) single-flight recovery, terminal-error handling
  for dead/foreign sessions (added 2026-09-06).
- Existing but unused by the deployment: worker-process mode (`PROCESS_ROLE=worker`),
  CPU worker-thread pool (`src/core/cpu-worker-pool.ts`), workload-control server
  (`WORKLOAD_CONTROL_ENABLED=true` is set; 0 remote workers enrolled).

---

## 4. Findings: missing / not used / risky

### 4.1 `maxMsgRetryCount: 0` + `retryRequestDelayMs: 0` — message-loss risk
Setting these to 0 means a single failed send/decrypt is **never retried at the
Baileys layer**. This was a deliberate storm guard, but combined with
`enableAutoSessionRecreation: false` it turns transient transport hiccups into
silent message drops and `404`/decrypt errors that are never reconciled.
**Recommendation:** re-enable bounded retries now that the app-level crypto guard
exists: `maxMsgRetryCount: 1` and `retryRequestDelayMs: 250` (fork default), keep
`enableAutoSessionRecreation: false`. The guard already prevents the retry storm
that originally motivated `0`. Verify over 24 h that no new crypto storm appears.

### 4.2 `fireInitQueries` not configured (default true)
On every socket open the engine fires initial queries (contacts/chats/pushnames).
At 16 concurrent reconnects this is a large part of the post-restart CPU/memory
burst (the ~1 GB climb in the first minutes). The app resolves group inventories
itself on demand (`groupFetchAllParticipating` per broadcast job) and stores
contacts via events, so initial queries are partly redundant.
**Recommendation:** set `fireInitQueries: false` behind a per-session env toggle
(e.g. `BAILEYS_FIRE_INIT_QUERIES`), deploy, and compare startup RSS/CPU and
contact-name resolution quality (some pushname resolution may degrade; verify
mentions/names in replies still resolve).

### 4.3 `shouldIgnoreJid` not configured
The engine currently accepts and processes **every** JID it is told about:
newsletter (`@newsletter`), broadcast lists, and LID-only traffic add processing
that the app never acts on.
**Recommendation:** filter early: ignore non-`@s.whatsapp.net` / `@g.us` /
`@lid` → phone mapping only when the app needs it. Reduces per-message work on
busy accounts. Add `shouldIgnoreJid` returning true for jids the app cannot
route to (e.g. `@newsletter`, `@broadcast`).

### 4.4 History-sync filtering is looser than needed
`syncFullHistory: false` is set, but `shouldSyncHistoryMessage` still allows
`INITIAL_BOOTSTRAP`, `RECENT`, `NON_BLOCKING_DATA`, etc. Initial bootstrap /
recent sync on reconnect still carries a large chat/message snapshot that the app
does not use (it keeps only its own bounded caches).
**Recommendation:** override `shouldSyncHistoryMessage` to process only
`NON_BLOCKING_DATA` (and nothing else) for these accounts, and confirm the app
does not rely on store history (it does not: quoted lookups go through
`messageCache` + `getMessage`). Biggest expected win on reconnect cost.

### 4.5 `generateHighQualityLinkPreview: true` on every send with a URL
Broadcast posts routinely contain URLs (invite links, ad text). With this flag the
engine performs high-quality preview generation per outbound message with links —
network fetch + image thumbnail work per group — on top of the app's own native
preview pipeline (`baileys-native-preview.ts`, `link-preview-js`).
**Recommendation:** verify whether outbound content always carries a prepared
`linkPreview`. If yes, set `generateHighQualityLinkPreview: false` (previews are
already supplied) and measure CPU during broadcast runs. If some sends rely on the
engine to generate previews, keep it true only for those paths.

### 4.6 `appStateMacVerification` stays `false/false`
The fork default disables app-state MAC verification. Enabling (`lax`) would
detect corrupted sync state but adds per-sync checks and can surface warnings at
this volume. With crypto-storm suppression already in place this is a judgment
call: **keep disabled** unless app-state corruption is suspected; document the
decision. Do not enable `strict` on production accounts at this scale.

### 4.7 Unused levers that are already built (inventory)

| Lever | Where | Status | Would fix |
| --- | --- | --- | --- |
| `PROCESS_ROLE=worker` + `WORKER_SESSIONS` | `src/config/env.ts` | **not set** in `.env` | single-process CPU/memory ceiling — spread sessions over cores |
| `EXCLUDED_SESSIONS` | env.ts | not set | carve-out routing |
| `WORKER_CONCURRENCY` | env.ts | not set (default 8) | worker job concurrency |
| `INBOUND_WA_CONCURRENCY` etc. | `inbound-admission.ts` | not set (24 / 3 / 800 / 150) | fine for now; set explicitly when workers split |
| `PAPPY_WA_LOG_LEVEL` | session logger | not set (default `warn`) | set `warn` explicitly; raise to `info` only when debugging |
| `CPU_WORKER_COUNT` / cpu-worker pool | `src/core/cpu-worker-pool.ts` | defaults to cores−1; confirm hot paths use it | heavy compute off the event loop |
| `MAX_CONCURRENT_RECONNECTS` | env.ts | default 3 | reconnect storms (already helps) |
| Mongo trace batch (`MONGO_BATCH_FLUSH_MS`, `MONGO_BATCH_MAX_SIZE`) | env.ts | defaults 500 ms / 100 | trace write cost (200k docs) |
| `INTERNAL_CONTROL_TOKEN`, `PANEL_DEBUG_TOKEN`, `SESSION_RECOVERY_TOKEN` | env.ts | not in `.env` | loopback/ops control surfaces (see §5) |
| `VALIDATOR_DURABLE_DUAL_WRITE` | env.ts | false | validator durability |
| Worker-process remote bridge (Redis RPC, `BRIDGE_HMAC_SECRET`) | `remote-bridge.ts` | secret set, **0 workers enrolled** | routing commands to remote workers once the split happens |

### 4.8 Known non-engine cost centers (to profile next, not Baileys per se)
- Per-message media handling: attempts to decode/download inbound audio/images
  ("Cannot derive from empty media key" entries) drive libuv + sharp usage — this
  is a strong candidate for the remaining >1-core CPU and the RSS that still
  grows slowly.
- Broadcast jobs with thousands of groups each holding 10 s delay timers.
- Mongo trace collection (`whatsapp_message_traces`: 200,395 docs, no visible TTL).
- Redis key accumulation: ~8.3k `link:__admin_validator__` keys, per-session
  `job-code`/`broadcast-done` markers (39.7k keys total, 67 MB).

---

## 5. Security/ops notes surfaced by the audit
- Debug env `PAPPY_DEBUG_WA_COMMANDS=1` was set **at the systemd manager level**
  (`systemctl set-environment`) — it survived `.env` edits and `.env` does not
  contain it. Removed on 2026-09-06. Check `systemctl show-environment` before
  debugging sessions; don't re-add without a removal plan.
- `.env` backup trail kept: `.env.bak-20260906-132652` (original),
  `.env.bak-watchdog-*` (mid-tuning). Final live values: watchdog 2400 MB,
  broadcast concurrency 4, debug flags off.
- `INTERNAL_CONTROL_TOKEN` / `SESSION_RECOVERY_TOKEN` / `PANEL_DEBUG_TOKEN`
  exist in the schema but are unset; loopback control endpoints and recovery
  helpers that need them are effectively disabled in this deployment.

---

## 6. Recommended action list (priority order)

1. **Worker split (biggest lever, untouched)** — run N worker processes via
   `PROCESS_ROLE=worker` / `WORKER_SESSIONS`, keep the control plane on `full`.
   Spreads memory (~100 MB/session) and crypto/CPU across cores; raises the
   effective ceiling from 1 core to 6. Verify the Redis bridge + session claim
   path first (it is exercised today by 0 remote workers).
2. **Baileys knob changes (§4.1, §4.2, §4.4, §4.5)** — bounded retries,
   `fireInitQueries: false`, strict history filtering, high-quality link preview
   off. Each is a one-line option change behind env toggles; A/B after deploy.
3. **Profile the residual memory/CPU** (media decode path, engine per-session
   signal/LID state) with a heap snapshot on a staging copy; then bound what is
   boundable (media byte caps exist; check decode concurrency & buffers).
4. **Housekeeping**: TTL/cleanup for Redis markers and Mongo traces; explicit
   env values for the inbound admission knobs; set `PAPPY_WA_LOG_LEVEL=warn`.
5. **Re-audit after 2** — re-measure plateau RSS, stalls, 408 rate, broadcast
   completion, and admin-panel (Bridge) command latency end-to-end.

## 7. Explicitly out of scope (per owner)
- No migration to `@whiskeysockets/baileys` upstream. The fork stays.
- No engine/fork source modifications are planned; all changes go through app
  configuration and app code.

---

## 8. Round-2 implementation — engine knobs (same day)

Implemented and built (367/367 tests, typecheck clean). No Baileys migration.

### 8.1 Fork freshness check
- Installed: `@crysnovax/baileys@2.7.15` (pnpm store, installed 2026-08-25);
  `2.7.12` also present from an earlier install. Fork is based on upstream
  Baileys ~v6.7.16 with v7 compatibility tweaks.
- The public npm name is **hijacked** (`0.0.1-security` placeholder) — version
  2.7.15 is not on registry.npmjs.org. Updates can only come from the fork
  author's own channel (repository field points to their site).
- Action: keep 2.7.15; confirm the latest 2.7.x with the author before any
  engine update; never reinstall from public npm.

### 8.2 What changed (env-driven, reversible without a code change)
New `.env` keys (defaults applied when unset; documented in `.env.example`):

| Key | Default | Effect |
| --- | --- | --- |
| `BAILEYS_MAX_MSG_RETRY_COUNT` | `1` | bounded send/decrypt retries (was `0` = silent drops) |
| `BAILEYS_RETRY_REQUEST_DELAY_MS` | `250` | delay between retries (was `0`) |
| `BAILEYS_FIRE_INIT_QUERIES` | `false` | skip redundant initial contacts/chats queries per socket open |
| `BAILEYS_HIGH_QUALITY_LINK_PREVIEW` | `false` | stop duplicate engine-side preview fetches (app ships its own cached native previews) |
| `BAILEYS_IGNORE_EXTRA_JIDS` | `true` | drop `@newsletter` / non-status `@broadcast` traffic before processing |
| `BAILEYS_HISTORY_MODE` | `nonblocking` | keep only PUSH_NAME + NON_BLOCKING_DATA history on reconnect (no INITIAL_BOOTSTRAP / FULL / RECENT replay) |

All applied in the `makeWASocket` call in `src/whatsapp/session-manager.ts`;
the always-fixed quiet flags stay in `BAILEYS_SESSION_SOCKET_OPTIONS`.
Rollback = set the env keys back (e.g. `BAILEYS_FIRE_INIT_QUERIES=true`,
`BAILEYS_MAX_MSG_RETRY_COUNT=0`) and restart.

### 8.3 Expected effect and measurement plan
- Lower reconnect burst (CPU + memory) — measure RSS slope and code-408 count
  in the first 10 minutes after deploy.
- No silent drops from disabled retries on transient failures.
- Lower per-send cost on URL-heavy broadcasts (engine preview generation off;
  the app's native preview cache already dedupes by URL/session).
- Watch for regressions: contact/chat resolution on cold start (should be fine
  because resolution is lazy + event-driven), and status traffic handling.

### 8.4 Additional engine study (next candidates, not yet changed)
- `transactionOpts` (app-state commit retries 10 @ 3 s) — revisit only if
  app-state write contention shows up in profiling.
- Residual RSS growth after the store fix (~15-20 MB/min pre-deploy): prime
  suspects are the media decode/download path (libuv + sharp) and engine-side
  per-session signal/LID state; confirm with a heap snapshot before further
  changes.
- Per-session retry/receipt bookkeeping (`msgRetryCounterCache`) is already
  bounded and cleared on session destroy.
- `countryCode` default `US` and `version`/`browser` stay at fork defaults.

## 9. Engine swap — @crysnovax/baileys → plogme (same day)

Per owner decision the WhatsApp engine is switched from `@crysnovax/baileys`
(published only on the author's private channel) to **`plogme`** on public npm
— the same maintained fork, published by the same author
(`plogme <plogmebot@gmail.com>`), described as the polished release.

- Installed: `plogme@1.0.3` (latest; versions 1.0.0–1.0.3 published same day).
  **1.0.0 was found broken** — `lib/Utils/games/website-preview.js` has a
  template-literal syntax error that prevents the module from loading at all;
  1.0.3 fixes it. Pinned exact `1.0.3` in root + `worker-package` manifests.
- API surface verified identical to the prior engine (370 root exports;
  `makeWASocket`, `makeCacheManagerAuthState`, `makeInMemoryStore`,
  `makeCacheableSignalKeyStore`; deep imports `lib/Utils/auth-utils.js` and
  `lib/Utils/messages.js` resolve). No `exports` map → deep imports stay valid.
- Package adds `whatsapp-rust-bridge` + `protobufjs` deps (perf/rust crypto).
  Preinstall script (Node>=20 + attribution gate) is benign for `plogme` name.
- All module specifiers updated repo-wide (`src`, `tests`, `tools`, `scripts`,
  `worker-package`); README updated. Typecheck clean; 367/367 tests pass;
  dist rebuilt with zero `@crysnovax/baileys` references.
- pnpm supply-chain policy: `plogme@1.0.0 || 1.0.3` added to
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- Backups: `package.json.bak-plogme`, `worker-package/package.json.bak-plogme`,
  `pnpm-lock.yaml.bak-plogme` (pre-swap state).

*Generated during the 2026-09-06 stability session. Live facts verified against
systemd journal, Redis (BullMQ), Mongo, and `/proc`; code facts verified against
`src/` and the installed engine (`node_modules/plogme`).*
