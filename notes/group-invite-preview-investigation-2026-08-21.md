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

## Follow-up URL and listener audit — 2026-08-22

- Active normal session used for live URL tests: `a4b646f9-8aa5-4a02-a786-463662bfb829`; it later logged out because WhatsApp returned `401 conflict device_removed`, unrelated to preview parsing.
- `https://pappywapfpchanger.duckdns.org` completed through the normal session with native preview fields, title, description, 83,254-byte JPEG thumbnail, and high-quality thumbnail.
- TikTok `https://vt.tiktok.com/ZSV5kDvDQ/` produced native title `TikTok - Make Your Day`, but the first delivery failed because the session connection closed during the send; the payload had no thumbnail. VPS HTML inspection found TikTok image URLs embedded in JSON as `https:\u002F\u002F...`, not ordinary OG tags.
- Local fix added JSON-escaped image URL extraction for TikTok-style pages and a regression test. The passive listener was also load-shed: session `lastMessageReceivedAt` persistence is throttled to 5 seconds; normal non-command text is not persisted as a full trace, not logged, and not sent to command routing; only prefixed commands and WhatsApp group invite links remain actionable. Automatic invite collection still runs for non-command messages containing WhatsApp group links.
- Full local suite after these changes: 131/131 tests, 14 files passed. Release 1.2.29 deployed with control plane and panel service ACTIVE; HTTPS health returned packageVersion 1.2.29.
- Important architecture result: Baileys still receives inbound events for all groups the account is a member of. The bot passively observes them for session heartbeat and invite-link collection, but it only executes/replies to commands after prefix/owner gates. It does not send replies to ordinary group messages.
- Live measurement before load-shedding deploy showed control-plane Node around 71% CPU and panel worker around 5%; stale standalone debug processes were found and terminated. The listed 71% sample was not a proof that group traffic alone caused the load; it was during diagnostic/reconnect activity.

## TikTok command-preview follow-up — 2026-08-22

The exact short URL `https://vt.tiktok.com/ZSV5kDvDQ/` returned HTTP 200 and an HTML document of about 385,824 bytes from the production VPS. The page contains many unrelated TikTok CDN assets, including model `.bytenn` files and old `p16.muscdn.com` `~noop.webp` assets, before the signed poster candidates. The prior embedded-image parser allowed any TikTok CDN URL with an image extension and could therefore exhaust its candidate cap on unrelated assets; some of those HTTP image fetches failed. The parser was tightened to exclude TikTok CDN assets unless their paths match TikTok poster patterns such as `~tplv-` or `/tos-`, allowing signed video poster URLs to be selected. This affects WhatsApp command-generated previews only; Telegram rendering is not involved.
