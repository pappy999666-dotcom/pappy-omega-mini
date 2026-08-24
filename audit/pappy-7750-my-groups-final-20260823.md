# Pappy My Groups — Final Live Callback Audit

**Date:** 2026-08-23  
**Scope:** Pappy session ending in 7750; read-only production diagnosis and hardening  
**Safety boundary:** No WhatsApp messages, group mutations, pairing, broadcast, Telegram user message, or panel-service restart was performed by the probes.

## Executive finding

The earlier transport-only verification was insufficient. A true in-process Telegraf reproduction was run against the deployed control code. It invoked the actual session-panel My Groups callback, captured the real rendered inline keyboard, extracted a real group button, and invoked the actual group-detail callback while intercepting all Telegram API calls locally.

Two production defects were confirmed:

1. Some live group subjects contained malformed UTF-16 surrogate data. Telegram rejected the entire inline keyboard with `inline keyboard button text must be encoded in UTF-8`. The callback edit failure was previously swallowed, making the user experience appear to do nothing.
2. The panel worker returned administrator-role candidates in LID-heavy participant records but did not match them to the worker identity. The control adapter consequently discarded the fast summary and fell back to a full `groupFetchAllParticipating()` scan. This produced the observed 15–30 second list delay and timeout/loading screens without group buttons.

## Omega-V1 comparison

Omega-V1 renders 20 groups per page from the live participating-group inventory, filters admin groups in memory, stores a short key for the exact group JID in each button, and resolves that exact stored group on click. It does not use a mutable list position to rediscover a group.

OMEGA-MINI now follows that relevant behavior. My Groups buttons use short exact-selection tokens, and a token miss cannot silently resolve another group. Expired selections render a clear reload state. Telegram callback edit failures produce a visible alert.

## Implemented production fix

The final worker/control path includes:

- LID-aware administrator matching with the control-side connected phone identity hint.
- Identity-scoped worker summary caches so a no-identity startup warm-up cannot be reused as the trusted admin list.
- Durable encrypted summary snapshots for safe post-restart warm state.
- Background refresh for stale no-identity data, while the trusted identity-hinted My Groups path refreshes role state before serving it.
- Central Telegram text sanitization for malformed surrogate sequences.
- Stable exact group-selection tokens instead of mutable numeric indexes.
- Visible callback failure alerts and an explicit expired-selection reload view.
- Timestamped deployment backups; final worker/control release alignment at 1.2.85.

## Live evidence

| Gate | Result |
|---|---:|
| Live participating groups observed | 41 |
| Fresh role-aware summaries | 19 administrator groups |
| Fresh summary fetch | 535 ms |
| Fresh role calculation | 61 ms |
| Fresh summary total | 596 ms |
| Final real Telegram-equivalent list render | 2,250 ms |
| Final group-detail callback | 4 ms |
| Exact group button found | Yes |
| Group Control Detail rendered | Yes |
| Detail keyboard rendered | Yes |
| Callback token size | 57 bytes |
| Final local regression suite | 21 files / 182 tests passed |
| TypeScript build and worker syntax check | Passed |
| Control service | Active, release 1.2.85 |
| Panel service | Active; not restarted |
| Temporary probes | Removed locally and remotely |

The final callback test was stronger than a raw `groupMetadata` test: it exercised the actual Telegram route, list rendering, button extraction, callback resolution, and group-detail rendering. It did not send a Telegram message to the user’s private chat.

A fresh post-cleanup run produced `ok: true`, found the actual group button, rendered group detail, and measured `openMs: 4`. The list phase measured approximately 2.25 seconds on that cold verification. The preceding role-aware summary measurement showed the worker correctly returning 19 administrator groups after the identity hint was applied.

## Regression status

The full local suite passed with 21 test files and 182 tests using the existing preview tests’ required 15-second allowance. TypeScript compilation and generated-worker syntax validation passed. The expected local Redis connection-refused warnings appeared in tests that run without a local Redis instance; they did not cause test failures.

## Remaining limitations

The final cold list phase was approximately 2.25 seconds, not sub-second. The group-detail click itself was 4 ms. This is materially different from the previous 15–30 second fallback, but it is not evidence that every cold reconnect will always be sub-second. A reconnect during a live WhatsApp inventory refresh can still require a read-only refresh. Repeat calls use the identity-aware cache and durable snapshot path.

The existing Baileys notification JSON parsing warning and elevated CPU samples remain separate operational risks. They were not marked fixed by this work. The final deployment deliberately did not alter outbound WhatsApp behavior, mutation authorization, session pairing, or the panel supervisor.

**Conclusion:** The previous claim was too broad because it did not exercise the actual callback. After reproducing the real route, tracing the malformed keyboard and admin-role fallback, and deploying the targeted fixes, the final post-cleanup live-equivalent test successfully rendered the Pappy My Groups list, opened a real listed group, and rendered Group Control Detail. The remaining real-user check is to press **My Groups** and then a listed group in the actual Telegram chat; if it still fails, the new visible Telegram error text will identify the remaining layer instead of leaving the user with a silent no-op.
