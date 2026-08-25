# OMEGA-MINI Baileys/Crysnova Session Guard Matrix

**Scope.** This matrix compares OMEGA-MINI's current direct socket lifecycle with the installed `@crysnovax/baileys` 2.7.12 behavior on the new VPS. Decisions are compatibility-first: an option is only enabled when its effect is understood in this fork and it does not break command, status, quote, media, or moderation flows.

## Evidence base

| Source | Use | Key evidence |
|---|---|---|
| [Baileys Socket Configuration](https://baileys.wiki/docs/socket/configuration/) | Official configuration guidance | Durable auth, `getMessage`, `msgRetryCounterCache`, `cachedGroupMetadata`, `shouldIgnoreJid`, timeouts and online/history controls are supported safeguards. |
| [Baileys Authentication](https://baileys.wiki/docs/socket/authentication/) | Auth persistence guidance | Persist creds immediately; production storage should be durable and key reads should be cacheable. |
| [Baileys Events](https://baileys.wiki/docs/socket/connecting/) | Event semantics | `messages.upsert` distinguishes real-time `notify` from history/backfill `append`; event processing should not treat history as fresh user actions. |
| Installed `Defaults/index.js` | Fork-specific defaults | `connectTimeoutMs=20000`, `keepAliveIntervalMs=15000`, `defaultQueryTimeoutMs=60000`, `retryRequestDelayMs=250`, `maxMsgRetryCount=3`, `markOnlineOnConnect=true`, `syncFullHistory=true`, `getMessage` unset, auto session recreation enabled. |
| Installed `Utils/auth-utils.js` | Fork-specific auth cache | `makeCacheableSignalKeyStore(store, logger, cache?)` wraps durable `get/set/clear`, uses a five-minute cache and mutex, and preserves writes to the underlying store. |
| Installed `Socket/messages-recv.js` | Fork-specific retry behavior | `msgRetryCounterCache` must implement async-compatible `get`, `set`, and `del`; a socket-local NodeCache is otherwise created and closed on socket end. |

## Guard decisions

| Area | Current OMEGA-MINI | Risk | Decision | Implementation/test status |
|---|---|---|---|---|
| Durable auth state | Encrypted AES-256-GCM store with atomic temp-write + rename; creds updates are flushed | Low data-loss risk, but concurrent key reads can repeat disk decrypts | **Already implemented; strengthen key-read caching** with the fork's `makeCacheableSignalKeyStore` around the durable key store, retaining durable writes and clear-on-purge | Phase 3 |
| Auth serialization | Fork auth helper uses `BufferJSON` internally | Buffer corruption risk if custom serialization is added | **Do not add custom serialization**; keep helper-managed serialization | Already safe |
| Distributed ownership | Redis session lock and refresh | Duplicate socket ownership if lock expires during event-loop stalls | **Already implemented; retain**, and keep lifecycle generation checks | Already safe |
| Socket generations | Lifecycle generation token rejects stale close/error callbacks | Old socket can reconnect after replacement if a callback bypasses generation checks | **Already implemented; audit tests** | Phase 3 tests |
| Reconnect control | Exponential backoff + jitter, one timer/socket, capped delay | Error storms can still produce too many reconnect attempts without bounded event handling | **Already implemented; preserve**, add option-level retry bounds and counters | Phase 3 |
| Heartbeat/health | Lifecycle heartbeat and failure threshold | Transport may be degraded while process remains alive | **Already implemented; retain**; no extra polling loop | Already safe |
| `markOnlineOnConnect` | Fork default `true`; not explicitly set | Sends online presence and can disturb primary-phone notifications/noise | **Safe to add `false`**; does not disable incoming event processing | Phase 3 |
| `syncFullHistory` | Fork default `true`; not explicitly set | Large initial history sync increases CPU, memory, event volume and apparent lag | **Safe to add `false`** for bot sessions; preserve current command/state behavior through live events | Phase 3 |
| `connectTimeoutMs` | Fork default 20s; not explicit | Fork upgrades can silently change timeout behavior | **Explicitly set 20s**, matching installed default | Phase 3 |
| `keepAliveIntervalMs` | Fork default 15s; not explicit | Silent default changes or overly frequent keepalives | **Explicitly set 15s**, matching installed default | Phase 3 |
| `defaultQueryTimeoutMs` | Fork default 60s; not explicit | Indefinite/changed query waits can hold jobs | **Explicitly set 60s**, matching installed default | Phase 3 |
| `retryRequestDelayMs` | Fork default 250ms; not explicit | Immediate retry bursts amplify upstream errors | **Explicitly set 250ms**, bounded by existing lifecycle admission and reconnect guards | Phase 3 |
| `maxMsgRetryCount` | Fork default 3; not explicit | Unbounded/changed retry loops can create noise | **Explicitly set 3**; only retries message delivery/decryption paths supported by fork | Phase 3 |
| `msgRetryCounterCache` | Socket-local cache created by fork | Counter resets on socket recreation and can repeat retries during reconnect storms | **Safe to add a bounded process-wide async cache** keyed by the fork's retry key; TTL 1h, bounded entries, `get/set/del`, no persistence of message bodies | Phase 3 |
| `getMessage` | Undefined | Baileys cannot retrieve original message for retry/poll decrypt after it leaves recent memory | **Storage design required**. Add bounded process-local raw-message cache first; do not claim restart durability. Return `undefined` on miss. Clear on session purge. | Phase 3, controlled limitation documented |
| Raw-message cache | No dedicated cache; traces store text/metadata only | Adding full payloads to Mongo traces would increase sensitive storage and schema risk | **Use bounded in-memory per-session cache** with TTL and max entries; store only received message payloads needed for retry; no new DB writes in hot path | Phase 3 |
| `shouldIgnoreJid` | Not supplied | Fork processes broadcast/status/system JIDs that do not need command routing | **Do not blanket-ignore status/broadcast JIDs** because anti-system/group-status features require raw payload inspection. Add only conservative system JIDs that are provably non-command and test behavior. If no safe subset is available, leave unset. | Phase 3 decision/test |
| `cachedGroupMetadata` | Not supplied | Repeated group metadata queries can slow broadcasts and moderation; stale metadata can authorize unsafe actions | **Use bounded short-TTL cache only as a query optimization**. Never use cached admin/member data as final authorization for destructive moderation; invalidate on participant/settings events where possible. | Phase 3 decision/test |
| `ev.process` | Individual listeners | Refactoring all listeners into one batch can change ordering and break existing route contracts | **Do not refactor in this pass**. Preserve individual listeners; add explicit upsert-type filtering at the command/collection boundary. | Deferred, intentional |
| History/backfill handling | Current upsert path does not inspect `type` before command/anti/link routes | `append` history can trigger commands, anti-actions, link collection, traces and broadcast work | **Safe high-value fix**: only `notify`/live upserts may invoke command routing, anti actions and automatic link collection; retain `append` for state/tracing only if needed. Add tests. | Phase 3 |
| `messages.update`/receipts | Existing listeners and tracked sends | Retries/updates can be mistaken for fresh inbound commands | **Audit current listeners; no new command routes from updates** | Phase 3 tests |
| Websocket error/close | Explicit listeners + classification + lifecycle restart | Multiple close/error paths can duplicate recovery | **Already implemented; add no duplicate listener**; test one recovery per generation | Phase 3 tests |
| Crypto error storm | Existing thresholded recovery | Repeated MAC/decryption failures can hold shutdown | **Already implemented; preserve threshold and ensure bounded stop cleanup** | Phase 3 tests |
| `smax-invalid` | Existing recovery | Invalid stanza loops can repeat | **Already implemented; retain and test classification** | Phase 3 tests |
| Auth flush on stop/shutdown | Existing explicit flush | In-flight writes may outlive stop deadline | **Already implemented; keep bounded flush and avoid new blocking I/O** | Phase 3 tests |
| Group metadata consistency | Transport inventory caches exist outside socket config | Stale cache could affect group selection and moderator actions | **Do not share authorization cache blindly**. If bridged, short TTL plus explicit invalidation and live refresh before destructive operations | Phase 3 decision |
| Message retry bodies after restart | Not available in current traces | Poll/media retry after process restart can fail | **Controlled limitation** unless a separate encrypted durable message store is justified. Do not overload trace collection. | Documented |
| Link previews | Existing media/preview path | Socket option changes must not alter preview generation | **No preview logic changes in this pass**; add regression tests around option wiring only | Guarded |

## Initial implementation boundary

1. Add the fork-compatible signal-key cache wrapper around the existing encrypted durable key store.
2. Add explicit quiet socket options matching installed defaults except `markOnlineOnConnect:false` and `syncFullHistory:false`.
3. Add a bounded process-wide retry-counter cache implementing `get`, `set`, `del`, and `close`.
4. Add a bounded per-session raw-message cache and `getMessage`; it is intentionally process-local and returns `undefined` after expiry/restart.
5. Filter `messages.upsert` history (`append`) out of command routing, anti actions, and automatic link collection while retaining real-time `notify` behavior.
6. Do not add a blanket `shouldIgnoreJid` rule or aggressive group metadata cache until tests demonstrate that status, group-status, anti-system, quotes, and moderation are not affected.
7. Run focused tests, then the full suite, then deploy only relevant control-plane changes to the new VPS while preserving secrets, auth, storage, and database state.

## Non-goals for this pass

This pass does not migrate or purge production WhatsApp auth, does not initiate pairing, does not approve/reject/kick members, does not run mass status/broadcast validation, does not change the worker release, and does not make unsupported claims about external legacy panels.
