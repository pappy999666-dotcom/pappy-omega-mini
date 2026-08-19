# Pappy Omega Mini — WhatsApp Group Preview Consistency Report

**Author:** Manus AI
**Date:** 19 August 2026
**Production target:** `13.50.108.217`
**Paired session:** `4efde35b-d609-4cf1-879d-4d9dd0cc1eda`

## Result

The group-invite consistency fix is implemented and deployed. WhatsApp invite URLs containing tracking parameters such as `?s=cl&p=a&mlu=4` are now canonicalized to the bare invite URL for preview resolution, cache identity, group-avatar lookup, and Validator Hub storage. The original text remains unchanged in the outgoing message, but the native preview metadata now uses one stable invite identity.

The native preview payload now follows the installed Baileys fork’s large-preview contract more closely. It supplies the uploaded `highQualityThumbnail`, preserves authoritative uploaded width and height when available, adds safe fallback dimensions only when the uploader omits them, and includes native `linkPreviewMetadata` with `linkMediaDuration: 0` and `socialMediaPostType: 4`. The preview type was corrected to the ordinary image-preview value rather than the carousel value.

> This addresses the two observed differences: parameterized invites no longer miss the socket-authoritative group path, and the payload contains the fields needed for recipients whose clients otherwise fall back to the small thumbnail representation.

## Changes

| Area | Change |
|---|---|
| Invite URL identity | Added a shared HTTP canonicalizer. Only `chat.whatsapp.com/<invite-code>` query parameters are stripped; ordinary website query parameters remain intact. |
| Group preview resolver | Parameterized invites now call `groupGetInviteInfo()` with the correct bare invite code and share the same cache key as the clean invite URL. |
| Validator Hub | Collected invite links are persisted under the same bare canonical URL, preventing parameter variants from becoming separate bucket records. |
| Native preview payload | Added `previewType: 0`, `linkPreviewMetadata`, and explicit high-quality thumbnail dimensions. |
| Cache safety | Preview cache advanced from `v4` to `v5`, invalidating records created with the previous invite identity behavior. |

## Verification

The complete local regression suite passed with **79/79 tests**. The focused preview and menu suite passed with **33/33 tests**. New coverage proves that the supplied example URL:

```text
https://chat.whatsapp.com/JjF3McLM5gIKNz7zaQKJbZ?s=cl&p=a&mlu=4
```

resolves through the bare code `JjF3McLM5gIKNz7zaQKJbZ`, retains the original message text, and emits canonical native preview metadata without the tracking query. The recipient-stability test also confirms that uploaded high-quality thumbnail dimensions are preserved and reused across repeated sends.

The final deployment authenticated the paired session automatically at `13:36:42`. Pappy remained online with zero unstable restarts. The deployed build reports preview cache version `v5`. Persistent storage still resolves to `/home/ubuntu/pappy-omega-mini-runtime-storage`, while `omega-core` and `omega-test` remained online and isolated.

## Final client acceptance

The remaining validation is visual rather than code-level: send the parameterized invite once from the owner account into a test group containing at least one additional account, then compare the rendered preview on both accounts. The expected result is the same group name, same group avatar, and the large preview representation on both clients. If one client still shows a small card after this payload correction, capture `.previewdebug` output and both client versions; that would indicate a WhatsApp-client capability or cache difference rather than a missing invite canonicalization path in Pappy.

## Deployment commit

The fix is pushed to `main` in commit `1daa547` with the message `fix: stabilize group invite previews across clients`.
