# Pappy Link Preview Reset Design

## Source of truth

The installed package is `@crysnovax/baileys` version `2.7.10`. Its native URL-preview contract is the `sendMessage` branch that consumes `richPreview: true` with a top-level `text` URL. The branch calls the fork’s `buildLinkPreview(previewLink, sock, options)`, then creates the native `extendedTextMessage`; when `groupStatus: true` is present, it wraps that message in `groupStatusMessageV2` and sets `contextInfo.isGroupStatus`. The fork’s native branch derives the client thumbnail with `extractImageThumb(imageBuffer, 296)` and uploads a high-quality image through `prepareWAMessageMedia`.

## Canonical application boundary

Pappy will have one canonical module, `src/whatsapp/baileys-native-preview.ts`, with four responsibilities: detect URLs without modifying user text; resolve and cache one immutable preview record per canonical URL; build the exact native content flags required by this installed Baileys fork; and return the original payload unchanged when resolution fails.

The outbound transport will call this module once for direct text, group text, status, mentions, all-group jobs, and quoted text. The module will never create a second message, rewrite the URL, crop the user payload, or insert a fake image. A complete preview supplied by the caller will pass through unchanged.

## Native send paths

| Payload class | Canonical behavior | Native Baileys contract |
| --- | --- | --- |
| Text-only URL | Attach cached metadata/image to one `richPreview` content object | `richPreview: true`, top-level `text`, optional `previewTitle`, `previewDescription`, `previewImage` |
| URL group status | Use the same content object and set `groupStatus: true` | Native `groupStatusMessageV2` wrapping in the installed fork |
| Media with URL caption | Preserve the exact media and caption; do not convert it into an invalid rich-preview text message | The installed fork’s rich-preview branch is text-message-specific; no unsupported synthetic hybrid is created |
| No URL | Return the original content object | No preview work or cache access |
| Preview resolution failure | Return the original content object and allow the send/job to continue | Plain Baileys send |

## Resolution and cache

The cache key is a canonical URL hash, with an in-flight promise map to ensure one URL is resolved once per process even when thousands of group sends begin together. Persistent cache records contain the canonical URL, metadata, selected image URL, source dimensions when available, raw image bytes only when needed by the native builder, timestamps, and a quality state. Failed or degraded records are not persisted as successful previews.

For ordinary URLs, metadata selection uses valid Open Graph, Twitter Card, and standard HTML values without truncating the user’s original message. Image candidates are ranked only when their URL is safe and their actual decoded dimensions are known. For WhatsApp group invites, the socket-authoritative path uses `groupGetInviteInfo(code)` and `profilePictureUrl(info.id, 'image')`; a low-resolution source is never upscaled or described as HD.

## Safety boundary

Preview fetches will enforce HTTP(S), reject credentials, localhost, loopback, private IPv4, link-local, and metadata endpoints, validate redirect destinations, use bounded timeouts, validate response status and content type, and decode images before accepting them. These are SSRF and malformed-response protections, not quality caps. The original user message is never truncated to fit an application limit.

## Processing rule

The native Baileys builder remains responsible for the platform-required thumbnail and high-quality upload path. Pappy will not add a second Sharp resize/sharpen/compression pipeline. If a supplied image already satisfies the native path, it is passed as a buffer; otherwise the original payload is preserved and the native send proceeds without a preview. This removes the current competing `default-adapter`, `preview-manager`, and custom `outbound-preview` paths.

## Diagnostics

Owner-only diagnostics will report URL, canonical URL, metadata, selected image, source and processed dimensions when available, whether processing was native or none, crop state, cache hit/miss, native flag, payload readiness, and fallback result. Diagnostics will not expose credentials or raw private response bodies.

## Acceptance requirements

The implementation must pass normal web, social, image-heavy, video, WhatsApp group invite, media-caption, multi-URL, quoted, scheduled, and repeated-broadcast tests. The tests must demonstrate that original text, captions, media, URLs, and quote context are preserved, that one URL does not trigger N metadata fetches, and that a failed preview cannot fail the surrounding job.
