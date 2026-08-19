# Pappy Omega Mini — Group Preview Regression Fix Report

**Author:** Manus AI
**Date:** 19 August 2026
**Production target:** `13.50.108.217`
**Paired session:** `4efde35b-d609-4cf1-879d-4d9dd0cc1eda`

## Regression fixed

The remaining regression was caused by incomplete preview assets being reusable for too long. When a group invite’s socket avatar lookup or native thumbnail upload failed once, the preview could fall back to the small WhatsApp invite card and remain in that state for subsequent sends. This was especially visible for parameterized invite URLs and for messages containing surrounding text.

The resolver now invalidates the old preview cache again with version `v6`. Group-invite records without an image are cached for only 60 seconds, while complete image-backed records retain the normal seven-day cache. Failed native high-quality uploads are removed from the in-process upload cache so the next send retries the upload rather than reusing a known incomplete result.

## Implemented corrections

| Area | Correction |
|---|---|
| Group avatar lookup | Invite metadata and avatar sources are handled independently. A failure in one source no longer aborts the complete group-preview attempt. |
| Public fallback | If socket metadata has no usable image, the resolver now attempts the public invite page’s OpenGraph image candidates before returning the group metadata. |
| Incomplete cache records | Image-less group records receive a 60-second TTL and are re-resolved rather than treated as a long-lived successful cache hit. |
| Failed native upload | A failed `prepareWAMessageMedia` upload is removed from the session-scoped upload cache, allowing a later send to retry. |
| Surrounding text | The original message text remains unchanged while the embedded invite is canonicalized only for preview identity and group lookup. |
| Cache invalidation | Preview cache advanced from `v5` to `v6`. |

The supplied pattern is covered directly:

```text
Join this group now: https://chat.whatsapp.com/HOgOUE3SPC0IoeFEnU3Vqe?s=cl&p=a&mlu=4 — welcome.
```

The URL is extracted from the surrounding sentence, canonicalized to the bare invite code, and the complete original text remains the outgoing message body.

## Verification

The focused preview and menu suite passed **33/33 tests**. The complete Pappy regression suite passed **79/79 tests**. The full suite includes the parameterized-invite path, surrounding-text preservation, native high-quality thumbnail dimensions, tall-image normalization, hidden mentions, media transport, group-status wrapping, queue behavior, and existing UI regressions.

The final deployment completed at `13:46:09`. The paired WhatsApp session authenticated automatically at `13:46:49`. Pappy remained online with zero unstable restarts, the deployed cache marker is `v6`, and persistent storage still resolves to `/home/ubuntu/pappy-omega-mini-runtime-storage`. `omega-core` and `omega-test` remained online and isolated.

## Final acceptance

Please resend the supplied parameterized invite with a short sentence before or after it into a test group containing another account. The expected result is that the original sentence remains visible and both clients receive the same complete group preview path. If the second account still renders a small card after this retry-safe deployment, use `.previewdebug <URL>` from the owner account and provide the resulting text; the remaining issue would then be a specific WhatsApp client capability or recipient-side preview cache rather than an unhandled Pappy fallback.

## Deployment commit

The fix is pushed to `main` in commit `4b660d7` with the message `fix: retry incomplete group preview assets`.
