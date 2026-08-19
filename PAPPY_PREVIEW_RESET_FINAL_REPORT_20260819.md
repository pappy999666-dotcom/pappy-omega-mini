# Pappy Omega Mini — Canonical Preview Reset

**Author:** Manus AI
**Date:** 19 August 2026
**Production target:** `13.50.108.217`
**Paired WhatsApp session:** `4efde35b-d609-4cf1-879d-4d9dd0cc1eda`
**Final deployed commit:** [`eaadec7`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/eaadec7)

## Executive result

Pappy Omega Mini now uses one canonical preview pipeline centered on the installed `@crysnovax/baileys` contract. The previous resolver stack, adapter, outbound wrapper, cache manager, sharpening injection, and competing payload paths were removed from active source and from the clean production build. The replacement keeps the original text and media payload intact, resolves only the first URL, rejects unsafe network targets, preserves complete caller-supplied previews, coalesces concurrent resolution, caches by workspace/session scope, and returns the exact original content when preview work fails.

The production deployment is online under PM2, the paired WhatsApp credential remains present in the externalized runtime storage tree, the session authenticated automatically after the final restart, and the existing `omega-core` and `omega-test` processes were not restarted or modified. The latest PM2 observation showed Pappy online with **0 unstable restarts**; `omega-core` and `omega-test` retained their prior PIDs and online status.

> The live transport path reached `WhatsApp authenticated open` for the paired session at `2026-08-19T13:03:55Z` after the final deployment. The prior deployment window also accepted `.ping` and `.gstatus` traffic after automatic recovery.

## What was rebuilt

| Area | Final behavior | Evidence |
|---|---|---|
| URL detection | Extracts HTTP(S) URLs embedded in arbitrary text, removes only trailing sentence punctuation, and preserves the full original message text. | `src/whatsapp/baileys-native-preview.ts`; 11 preview tests |
| Native transport | Uses the installed Baileys `richPreview` / normal native `linkPreview` contract rather than constructing a parallel WhatsApp message format. | `BAILEYS_PREVIEW_SOURCE_AUDIT_20260819.md`; Baileys contract probe |
| High-quality capability | Explicitly enables `generateHighQualityLinkPreview: true` on every WhatsApp socket. | `src/whatsapp/session-manager.ts` |
| Image quality | Does not upscale, crop, sharpen, or recompress preview source bytes. Sharp is used only to decode and measure the original image safely. | `PreviewDebugSnapshot`: `processing=NONE`, `crop=NO`, `compression=NONE` |
| Group invites | Uses socket-authoritative invite metadata when a socket is available, including `groupGetInviteInfo()` and group profile-picture lookup. | `src/whatsapp/baileys-native-preview.ts` |
| Caching | Uses schema `v4`, workspace/session-scoped keys, Redis TTL, and in-flight request coalescing. Redis failure is non-blocking. | `tests/preview-manager.test.ts` |
| Failure behavior | Any fetch, metadata, image, cache, or native preparation failure returns the exact original content without blocking the main send. | Fallback regression test |
| Mentions | Verified against the installed Baileys implementation: native `richPreview` preserves hidden `mentionedJid` metadata. Mention-bearing messages now use that path. | `scripts/probe-baileys-preview-mentions.mjs`; regression test |
| Diagnostics | Owner-only `.previewdebug <url>` / `.previewdiag <url>` reports source selection, dimensions, cache state, native flag, payload readiness, and fallback reason. | `src/whatsapp/command-registry.ts` |

## Removed architecture

The following old active modules were deleted and are absent from `dist/src` in the final clean build:

| Removed module | Reason |
|---|---|
| `src/preview/default-adapter.ts` | Removed old metadata/image adapter and sharpening path. |
| `src/preview/preview-manager.ts` | Removed old preview cache/resolver contract. |
| `src/whatsapp/outbound-preview.ts` | Removed competing outbound orchestrator and duplicate payload builders. |
| `nativePreview()` helper | Removed standalone flag helper so flags are produced only by the canonical send-time path. |

The deployment build now cleans `dist` before compilation. This prevents deleted modules from surviving as stale compiled artifacts in future atomic releases.

## Baileys implementation findings

The installed fork’s normal `sendMessage()` branch passes a native `getUrlInfo` callback into `generateWAMessage()`. Its high-quality branch calls `getUrlInfo()` with `uploadImage: waUploadToServer` when `generateHighQualityLinkPreview` is enabled. Its native rich-preview branch emits `extendedTextMessage` with `previewType: 0`, `jpegThumbnail`, and optional high-quality thumbnail fields. The implementation also converts a `mentions` content array into `contextInfo.mentionedJid`; the focused contract probe confirmed that this metadata survives both the rich-preview and normal link-preview paths.

Pappy’s canonical resolver therefore prepares the metadata and safety boundary, while Baileys remains responsible for final WhatsApp message construction and upload behavior. This is deliberately different from inventing a custom WhatsApp payload schema.

## Runtime dependency correction

The first live `.gstatus` acceptance attempt exposed a real production dependency issue: the installed Baileys fork dynamically imports `link-preview-js`, but the dedicated Pappy dependency tree did not expose it. The dependency was added directly to `package.json` and `pnpm-lock.yaml` in commit [`2413287`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/2413287), then installed in the Pappy-only dependency tree on the VPS. The final production check resolved:

```text
/home/ubuntu/pappy-omega-mini.deps.release-20260819085556/node_modules/.pnpm/link-preview-js@3.2.0/node_modules/link-preview-js/build/index.js
```

No subsequent `ERR_MODULE_NOT_FOUND` preview error appeared during the post-fix transport observation.

## Restart recovery correction

A second production observation established the reason the paired session sometimes remained offline after a PM2 restart. When the previous process still held the Redis session lock during a restart race, `openWhatsAppSession()` changed the session to `RECONNECTING` and returned without scheduling another attempt. The lock expired, but no new start was initiated. Commit [`82c6b4a`](https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/82c6b4a) now schedules the normal exponential reconnect whenever lock acquisition fails.

After that fix, the paired session authenticated automatically after restart and processed `.ping` and `.gstatus` traffic. This fix is independent of the preview resolver and protects all authenticated sessions from the restart-time lock race.

## Test and acceptance evidence

| Verification | Result |
|---|---:|
| Strict TypeScript build after clean `dist` removal | Passed |
| Full Vitest suite | **76/76 passed** across 8 test files |
| Canonical preview tests | **11/11 passed** |
| Media transport regression tests | **15/15 passed** |
| Concurrent one-URL resolver coalescing | Passed: one HTML/image resolver pass for concurrent calls |
| Unsafe private/metadata host rejection | Passed |
| Original text preservation | Passed |
| Original media-caption preservation | Passed |
| Hidden mention preservation through richPreview | Passed |
| Clean production source check | Passed: no old adapter/manager/outbound modules under `dist/src` |
| Final paired credential check | Passed |
| Final Pappy PM2 state | Online; unstable restarts `0` |
| `omega-core` isolation | Online; PID `177220`; not restarted |
| `omega-test` isolation | Online; PID `216252`; not restarted |

The representative local acceptance report is attached separately as `PAPPY_NATIVE_PREVIEW_ACCEPTANCE_20260819.json`. It confirms the resolver’s behavior for ordinary web, Telegram, WhatsApp channel, and WhatsApp group URLs. In that isolated resolver test, Telegram returned a complete rich preview with a measured `320 × 320` source image and no image processing. WhatsApp channel and group URLs safely returned the original text when the sandbox could not obtain valid metadata without a socket-authoritative group context.

## Owner diagnostic usage

From the paired owner account, use:

```text
.previewdebug https://example.com/article
```

or:

```text
.previewdiag https://example.com/article
```

The response reports the canonical URL, title, description, selected source image, source dimensions, source byte count, processing/crop/compression state, native Baileys flag, payload readiness, cache hit/miss, and fallback reason if applicable. It is owner-only and does not expose raw image bytes.

## Deployment safeguards now in effect

Every atomic release keeps the persistent storage tree outside the release directory and recreates the symlink:

```text
/home/ubuntu/pappy-omega-mini/storage
→ /home/ubuntu/pappy-omega-mini-runtime-storage
```

The paired credentials remained present across the preview reset, dependency installation, and final deployment. Future builds should remove `dist` before invoking `tsc`; otherwise deleted compiled modules can survive even when the TypeScript source has been removed.

## Remaining acceptance caveat

The canonical resolver and transport path are deployed and the paired session is online. The final mention-only release was verified to authenticate successfully after restart, but no new user-supplied URL-status command was required after the final `13:03:13Z` release because the immediately preceding release had already exercised `.ping` and multiple `.gstatus` URL paths after automatic recovery. The owner diagnostic command is available for a final visual client-side check whenever desired.

## References

[1]: https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/eaadec7 "Pappy Omega Mini final native-preview acceptance commit"

[2]: https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/82c6b4a "Pappy Omega Mini restart lock-race recovery fix"

[3]: https://github.com/pappy999666-dotcom/pappy-omega-mini/commit/2413287 "Pappy Omega Mini link-preview-js runtime dependency"

[4]: https://github.com/pappy999666-dotcom/pappy-omega-mini/blob/main/BAILEYS_PREVIEW_SOURCE_AUDIT_20260819.md "Installed Baileys preview source audit"

[5]: https://github.com/pappy999666-dotcom/pappy-omega-mini/blob/main/PAPPY_PREVIEW_RESET_DESIGN.md "Canonical preview reset design"
