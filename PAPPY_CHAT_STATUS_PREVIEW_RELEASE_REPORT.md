# Pappy Omega Mini — Chat and Status Preview Correction

**Correction release:** `7bdb095`  
**Production process:** `pappy-omega-mini` on VPS `13.50.108.217`  
**Date:** 19 August 2026

## Defects addressed

The blank normal-chat preview was caused by Pappy’s custom `richPreview` payload diverging from the installed Baileys fork’s native `linkPreview` contract. The normal outbound path now supplies Baileys with its native `linkPreview` object containing the matched URL, decoded title and description, and normalized JPEG thumbnail bytes. This allows Baileys’ standard message generator to construct the extended text preview instead of relying on the custom branch that produced blank cards.

The group-status path now uses the fork’s raw `groupStatusMessage` handler when a resolved preview image is available. It sends the normalized image as a full-size status image with the URL as caption, rather than wrapping the URL in an extended-text status card that only displayed a small thumbnail or a blank large area. This uses the installed Baileys group-story path and preserves the full image bytes.

## Verification

The final strict TypeScript build passed. The full Vitest suite passed **56 tests across 7 files**, with zero failures. Existing preview, media, menu, worker, Join Manager, and lifecycle regressions remained green.

The sandbox emits Redis connection-refused warnings because no local Redis server is running. These warnings did not fail tests; production uses the configured VPS Redis service.

## Production evidence

The correction was deployed through an atomic Pappy-only release swap while reusing the dedicated Sharp dependency tree from the previous preview release.

| Process | PID | Status |
|---|---:|---|
| `pappy-omega-mini` | `269901` | `online` |
| `omega-core` | `177220` | `online`, unchanged |
| `omega-test` | `216252` | `online`, unchanged |

The deployed release contains the updated transport module and the Sharp module. Pappy scheduled recovery for the valid paired session after restart. The separate registry entry with no persisted credentials remains correctly classified as awaiting pairing and was not deleted.

## Important behavior distinction

A full-size status image is now sent for the group-status URL path. A URL’s own remote image still determines the available visual detail; no image processor can reconstruct information that was absent from the source image. The code now avoids the prior blank-card path and ensures that when a valid normalized image exists, WhatsApp receives it as a full-size status media payload.

## References

1. [Pappy Omega Mini repository](https://github.com/pappy999666-dotcom/pappy-omega-mini)
2. [Chat/status preview correction commit `7bdb095`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/7bdb095)
3. `src/whatsapp/outbound-preview.ts`, native normal-chat `linkPreview` construction.
4. `src/whatsapp/transport-adapter.ts`, full-size `groupStatusMessage` media path.
5. Installed `@crysnovax/baileys` rich-preview and group-story implementation.
