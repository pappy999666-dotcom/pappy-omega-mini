# Group Invite Preview Investigation — 2026-08-21

## User-provided evidence

Screenshots show ordinary GitHub previews rendering correctly on the paired hosted-panel tester, while `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN` sent through `.gstatus` and `.tag` renders as a plain blue URL without a native preview. A WhatsApp status screenshot also shows the group invite as plain text.

## Live tester

Hosted worker: `pappy-v3-e75015`, workerId `3d45149e-a536-42b3-9363-870af82d68dd`, version `1.2.25` after the preview-thumbnail fix.
Paired tester session: `e92d6818-d22d-4833-b7a6-7f264f0843f4`, name `Papp101`, phone `2347065217750`, workspace `48aafb88-1e92-42fa-a471-946e90d22ebc`, status ACTIVE, authHealth VALID.

## Live reproduction

The exact invite URL was sent through the panel socket using the production `sendDirectText` path. The latest `sendMessage` workload command completed successfully, but its payload had no `linkPreview` fields. A diagnostic run of `prepareCanonicalPreviewContent` with a unique cache scope returned:

- `payload: FAILED`
- `result: FALLBACK`
- `cache: MISS`
- `reason: no-valid-preview`

A prior diagnostic using the normal cache scope returned `cache: HIT` with the same negative fallback, proving stale negative caching can hide later recovery.

## External URL evidence

URL: `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN`

A direct fetch from the sandbox with `curl -L -A 'Mozilla/5.0'` returned HTTP 200, HTML size about 183,754 bytes, and these metadata values:

- `<title>WhatsApp Group Invite`
- `og:title`: `Gc closed`
- `og:description`: `WhatsApp Group Invite`
- `og:image`: `https://pps.whatsapp.net/v/t61.24694-24/641789215_927689696329590_2696567526240214164_n.jpg?...`

The OG image fetched successfully as JPEG, 33,447 bytes, dimensions 443x720. The known query variant `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN?s=cl&p=a&mlu=4` also returned HTTP 200 and the same OG metadata.

A mirrored fetch trace executed on the VPS using the preview user-agent `pappy-omega-mini-preview/4` received HTTP 429 for the bare invite URL, resulting in zero HTML bytes and no metadata. This is the confirmed immediate failure mode: WhatsApp's bare invite metadata endpoint is intermittently rate-limited. The query variant is intended to avoid that response.

## Code changes currently local but not yet deployed

`src/whatsapp/baileys-native-preview.ts` currently has an uncommitted change:

- cache version bumped from v6 to v7 to invalidate stale negative preview records;
- added `publicInviteMetadataUrl()` which appends `?s=cl&p=a&mlu=4` to bare `chat.whatsapp.com` URLs;
- group-invite public HTML fetches now use this stable query variant in both fallback branches.

`tests/preview-manager.test.ts` currently has an uncommitted regression test for assigned-panel invite previews. The first assertion failed because the test mock showed the resolver calling the bare URL twice rather than the query variant. Temporary diagnostic logging `INVITE_PREVIEW_CALLS` remains in that test and must be removed after diagnosis.

## Important next investigation

The local test behavior indicates `publicInviteMetadataUrl()` is not being used in the active compiled/test path or the test is hitting a different branch. Inspect the current source around both `readHtml` replacements and `groupInviteCode(canonicalUrl)` conditions. Remove the temporary console log, fix the test/mock or implementation as appropriate, rerun typecheck and all tests, then deploy a new release only after the exact invite URL produces `linkPreview` metadata and thumbnail through the paired panel worker.
