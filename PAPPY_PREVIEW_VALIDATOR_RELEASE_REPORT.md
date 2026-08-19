# Pappy Omega Mini — Preview and Validator Hub Release Report

**Release:** `a4893d6`  
**Production process:** `pappy-omega-mini` on VPS `13.50.108.217`  
**Date:** 19 August 2026

## Corrections delivered

The WhatsApp preview path now decodes numeric and named HTML entities before metadata reaches Baileys. This removes the visible `&#x...;` gibberish shown in the supplied screenshots. The resolver ranks declared Open Graph and Twitter image sources, validates safe redirects, downloads the selected image within a bounded size, and normalizes it with **Sharp** to a high-quality JPEG. The normalized bytes are passed to Baileys so its native rich-preview path can generate the small thumbnail and upload the higher-quality preview image. The Redis preview namespace was bumped from `v1` to `v2`, forcing old low-quality cached records to be replaced.

URL detection remains able to find an HTTP(S) URL embedded inside ordinary text, rather than requiring a bare-link message. The preview pipeline therefore handles text such as `Read this: https://example.com/article` through the same shared outbound path.

Validator Hub intake is now restricted to URLs whose host is exactly `chat.whatsapp.com` and whose path contains one group invite token. Channel URLs, ordinary websites, Telegram links, and arbitrary HTTP(S) URLs are not stored in the Validator Hub Main bucket. This filtering applies to text collection, streamed text-file collection, WhatsApp auto-collection, and scheduled validation input.

Telegram passive intake is now suspended for the user after any inline-keyboard callback. The next passive text URL or document is ignored instead of being accidentally collected into Validator Hub; the suspension then clears so later explicit intake can proceed. Existing guided input workflows remain handled before passive listeners.

## Verification

The final strict TypeScript build passed. The full Vitest suite passed **56 tests across 7 files**, with zero failures. New coverage verifies entity decoding, embedded URL detection, WhatsApp-group-only filtering, normalized thumbnail byte mapping, and existing UI/media behavior.

The sandbox test process reports Redis connection-refused warnings because no local Redis server is running. These warnings did not fail tests; production uses the configured VPS Redis service.

## Production evidence

The release was deployed through an atomic Pappy-only release swap. A dedicated Pappy dependency tree was created with Sharp `0.35.3`; the other omega services were not rebuilt or restarted.

| Process | PID | Status |
|---|---:|---|
| `pappy-omega-mini` | `269447` | `online` |
| `omega-core` | `177220` | `online`, unchanged |
| `omega-test` | `216252` | `online`, unchanged |

Post-deployment logs confirmed recovery of the valid paired WhatsApp session:

> `WhatsApp authenticated open ... session=4efde35b-d609-4cf1-879d-4d9dd0cc1eda`

> `Reconnection with existing sync data ... Transitioning to Online.`

The deployed release contains the compiled preview adapter and the dedicated Sharp dependency. The separate stale registry record with no persisted credentials remains correctly classified as awaiting pairing; it is not falsely reported as active and was not deleted.

## Remaining limitation

Sharp can normalize and preserve the best available source image, but it cannot reconstruct detail that is absent from a website’s original low-resolution image. If a particular WhatsApp invite publisher exposes only a blurry avatar, the preview will remain limited by that source. The resolver now prefers the highest-ranked available image and passes its normalized bytes through Baileys’ native preview pipeline.

## References

1. [Pappy Omega Mini repository](https://github.com/pappy999666-dotcom/pappy-omega-mini)
2. [Preview and Validator release commit `a4893d6`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/a4893d6)
3. `src/preview/default-adapter.ts`, decoded metadata and Sharp thumbnail resolver.
4. `src/links/link-collector.ts`, WhatsApp group invite filtering.
5. `src/telegram/bot.ts`, passive intake suspension and scheduled validation filtering.
