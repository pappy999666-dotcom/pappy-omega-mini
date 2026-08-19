# Pappy Omega Mini — Queue and Long-Preview Fix Report

**Author:** Manus AI
**Date:** 19 August 2026
**Production target:** `13.50.108.217`
**Paired WhatsApp session:** `4efde35b-d609-4cf1-879d-4d9dd0cc1eda`

## Executive result

The two reported symptoms had separate causes. The apparent queue failure was not initially a BullMQ serialization defect: the persisted Emergency Safe Mode had been enabled by the owner and was rejecting every `massSend` operation before a worker could process it. After owner confirmation, the state was disabled and an audit event was recorded. The queue path was then hardened so acknowledgements return immediately after durable enqueue, the global BullMQ rate limiter no longer throttles unrelated jobs, and the worker starts before slow WhatsApp session recovery during a restart.

The long-link preview issue was caused by the previous native payload receiving the fetched image bytes without a consistent output normalization step and without always providing Baileys’s uploaded high-quality thumbnail contract. The resolver now produces a complete JPEG without cropping or upscaling, preserves the source aspect ratio, and uploads the normalized image through the installed Baileys fork’s `highQualityThumbnail` path when a live WhatsApp socket is available. The small `jpegThumbnail` remains as the native fallback, while the full uploaded thumbnail is used by Baileys for the large chat-preview representation.

> The image is normalized for transport quality; it is not artificially enlarged. A smaller source remains smaller, while a tall or oversized source is fit inside the maximum dimension without crop.

## Root-cause findings

| Area | Confirmed behavior | Correction |
|---|---|---|
| Queue no-response | Recent `allstatus` and `allchat` records failed immediately with `Emergency safe mode blocks massSend.` | Owner-confirmed Safe Mode disablement was persisted and audited. |
| Queue dispatch | `allstatus` waited up to three seconds for `waitForStarted`; the worker also had a global limiter. | Removed the command-side wait and removed the global BullMQ limiter. Worker concurrency remains bounded by `QUEUE_CONCURRENCY`, currently `4`. |
| Restart availability | Worker startup occurred only after `startRecoverableSessions()` completed, so a slow or invalid session could make the queue temporarily unavailable. | Worker and scheduler now start immediately after state hydration, before WhatsApp recovery. |
| Preview sharpness | Raw source image bytes were not consistently normalized for the native preview path. | JPEG normalization at quality 95/90/85, 4:4:4 chroma, progressive output, and a 512 KB cap. |
| Preview size | The normal fallback contained only `jpegThumbnail`, which is the small native field. | Normalized bytes are uploaded with `prepareWAMessageMedia` and the socket’s `waUploadToServer`, producing `highQualityThumbnail`. |
| Repeated preview work | Repeated sends could repeat the native image upload. | Added session/cache-scope upload coalescing so one URL is uploaded once per preview scope. |

## Implemented behavior

The canonical preview resolver now detects URLs embedded anywhere in text, retains the original text, and creates one native `linkPreview` object. It normalizes fetched image data to JPEG, uses `fit: "inside"` with `withoutEnlargement: true`, and never crops the complete source. A `1920`-pixel maximum dimension is used as a transport ceiling rather than an upscaling target. The resolver keeps the normalized image in the existing cache record and uses the live socket uploader to supply Baileys’s full high-quality thumbnail metadata.

The same canonical preparation path is used for ordinary chat previews and group-status payloads. Group-status wrapping remains native through the `groupStatus` flag. Media-caption sends continue to preserve their original media payload because the current Baileys fork does not support injecting a second URL-preview message into an already prepared media message without risking the media send.

Background jobs are durable in Redis/BullMQ, retain their existing job records and short job codes, and remain bounded by worker concurrency. Removing the global limiter prevents a global token bucket from delaying unrelated jobs. Removing `waitForStarted` means the WhatsApp command acknowledgement is returned immediately after the job record and BullMQ entry are persisted. Restart recovery continues to use the existing job records, heartbeat reaper, retry policy, and durable join-result ledger.

## Verification evidence

| Verification | Result |
|---|---:|
| TypeScript strict build after final source changes | Passed |
| Full Vitest suite | **78/78 tests passed** |
| Preview-specific tests | **13/13 tests passed** |
| Tall image normalization | Passed; a `420×2400` source becomes `336×1920`, preserving the original aspect ratio without crop or upscale |
| Native high-quality upload reuse | Passed; repeated sends in one session scope use one uploader operation |
| Hidden mention preservation | Passed through the native `linkPreview` path |
| Media transport regression suite | Passed; existing 15 media transport tests remain green |
| Emergency Safe Mode after restart | Persisted as OFF: all emergency flags are false |
| Pappy PM2 state after final deployment | Online, PID `281870`, unstable restarts `0` at verification |
| Paired WhatsApp recovery | Authenticated `open` at `13:26:29` after final restart |
| Persistent storage | `/home/ubuntu/pappy-omega-mini/storage` resolves to `/home/ubuntu/pappy-omega-mini-runtime-storage` |
| omega-core isolation | Online, PID `177220`, unchanged |
| omega-test isolation | Online, PID `216252`, unchanged |

The post-deployment Redis queue was empty at the verification point: `wait=0`, `active=0`, and `delayed=0`. The `failed=105` count is historical and consists of prior records rejected while Emergency Safe Mode was active; those records were not silently replayed. New commands submitted after the restart will use the corrected path.

## Deployment commits

The implementation is pushed to the selected repository on `main` in two relevant commits:

| Commit | Purpose |
|---|---|
| `337ec97` | Normalized native preview payload, Baileys high-quality thumbnail upload, independent queue dispatch, and preview regressions |
| `c84b972` | Start workers and scheduler before slow WhatsApp session recovery |

The final deployment used an atomic release swap, preserved `.env`, linked the externalized `storage` directory, reused the dedicated dependency tree containing `link-preview-js`, and restarted only `pappy-omega-mini`.

## Remaining live acceptance caveat

The code-level and process-level checks are complete, but a fresh client-rendering check should still be performed from the owner WhatsApp account with a long or previously blurry URL. The expected result is a large chat preview backed by Baileys’s uploaded high-quality thumbnail. If a particular site still looks soft after this change, the remaining softness is likely in that site’s upstream image asset rather than Pappy’s transport payload; `.previewdebug` can report the selected source, source dimensions, normalized processing state, cache state, and native payload readiness.
