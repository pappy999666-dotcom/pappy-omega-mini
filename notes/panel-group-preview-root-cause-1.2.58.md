# Panel WhatsApp Group-Link Preview Root Cause and Fix

## Executive finding

The panel regression was not caused by channel previews, command parsing, destination-group metadata, or the preview cache. The failure was specific to the source WhatsApp group invite path.

For the tested source URL `https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN`, the live panel-assigned socket returned `not-authorized` from `groupGetInviteInfo`. The production VPS then received HTTP 429 from WhatsApp’s direct public invite page. Because both source metadata paths failed, the resolver correctly preserved the source URL but had no source metadata and generated the generic fallback card shown in the screenshots.

The destination URL `https://chat.whatsapp.com/BnoEtMaigLaGeq05113OhM` resolved independently to `♡₊˚ KAWAII HAVEN ˚₊♡`. It was not used as KbDj’s preview after the earlier cross-URL contamination fix.

## Root cause chain

| Stage | Live result |
|---|---|
| Panel worker | ACTIVE, assigned session present |
| Source invite extraction | Correct: `KbDjI6Amhs38wh2nRz4pkN` |
| Native Baileys lookup | `not-authorized` for KbDj |
| Direct WhatsApp public page | HTTP 429 from the production VPS |
| Old resolver result | Generic `WhatsApp Group Invite` fallback |
| Destination lookup | Separate BnoEt result; no longer contaminates KbDj |

A direct probe from another network confirmed that the source invite’s alternate `/invite/<code>` page exposes source-specific metadata (`Gc closed`, `Group chat invite`, and a source image). The production VPS was intermittently rate-limited on direct WhatsApp requests, so this response could not be obtained reliably through the old direct-only path.

## Implemented fix

The resolver now keeps the original posted URL as the canonical preview URL and attempts, in order, the direct WhatsApp invite page, the alternate `/invite/<code>` path, and the query-form alternate path. When WhatsApp’s edge still returns 429, it uses a source-only metadata relay for that exact invite code and parses the returned title, group-chat description, and image. The relay is never given the execution-group JID and cannot substitute destination metadata.

The relay image is passed through the existing safe URL validation, download, normalization, and native thumbnail pipeline. Group invite canonical URLs are explicitly kept as the original `chat.whatsapp.com/<code>` URL even when metadata comes from an alternate page or relay.

The test suite now covers both the alternate endpoint and the full relay fallback when Baileys returns `not-authorized` and every direct WhatsApp request returns 429. Existing sequential, concurrent, cache-isolation, panel, status, and media preview tests remain covered.

## Live deployment verification

Release **1.2.58** is active on the control plane and the test panel auto-updated to **1.2.58**. The actual assigned panel session was used through the control-plane workload transport; no mock socket was used for the live diagnostic.

The final non-sending diagnostic returned the following source-faithful result for KbDj:

| Field | Result |
|---|---|
| Matched text | The original KbDj URL |
| Canonical URL | The original KbDj URL |
| Title | `Gc closed` |
| Description | `Group chat invite` |
| Thumbnail | Non-generic source thumbnail digest returned |
| Cache status | Fresh miss during diagnostic |
| Panel worker | ACTIVE, version 1.2.58 |
| Control service | ACTIVE, package version 1.2.58 |

The BnoEt comparison continued to return its own title and thumbnail, proving the source and destination previews remain isolated.

The full gates passed: strict typecheck, production build, worker generation, worker syntax validation, and **148 tests across 15 files**.

## Operational note

The live verification intentionally used the non-sending diagnostic because sending `.tag` or `.gstatus` through the panel account would create an unsolicited WhatsApp message. The diagnostic exercises the same control-plane resolver and panel-assigned transport used before the final send. The generic fallback should no longer be produced for this KbDj case unless both the source relay and all source metadata providers are unavailable simultaneously.

## References

[1]: https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews "Meta WhatsApp link previews documentation"

[2]: https://github.com/WhiskeySockets/Baileys/issues/347 "Baileys link preview payload and client-rendering discussion"
