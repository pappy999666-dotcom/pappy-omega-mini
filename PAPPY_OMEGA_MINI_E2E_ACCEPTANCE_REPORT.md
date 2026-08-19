# Pappy Omega Mini — Telegram and WhatsApp End-to-End Acceptance Report

**Acceptance target:** Telegram inline moderation buttons and WhatsApp group commands  
**Repository baseline:** `383623f` (`fix: repair moderation buttons and group menu`)  
**Live target:** isolated `pappy-omega-mini` process on the Pappy VPS

## Result summary

The automated acceptance baseline passed. Strict TypeScript validation completed without errors, and all 31 Vitest tests passed across six test files. The live process check also passed: Pappy is online with zero unstable restarts, while `omega-core` and `omega-test` remain online with their existing uptimes and were not restarted.

The test suite verifies the command registry, WhatsApp command authorization and routing, compact menu rendering, media-backed menu behavior, Telegram UI styles and visibility boundaries, worker contracts, live settings, and hardening behavior. It does not create real Telegram callback updates or send live WhatsApp messages from a paired account, so those transport-level paths remain explicitly marked as requiring a paired-account test.

## Telegram inline moderation coverage

| Surface | Automated/static status | Live transport status |
|---|---|---|
| Group `/start` menu | Passed by source and UI review; compact group menu and separate private menu are present | Requires a real Telegram group callback click |
| Group Rules button | Fixed to open a dedicated same-message rules view with a Back button | Requires a real Telegram callback click |
| Moderator Controls button | Fixed to use `group:start:moderation`, group-type validation, and administrator re-check | Requires a real Telegram administrator callback click |
| Protection toggle | Registered and persists the group field before same-message dashboard refresh | Requires a real Telegram callback click |
| Quick Protect | Registered and toggles protection, anti-link, anti-spam, and raid together with an audit event | Requires a real Telegram administrator callback click |
| Anti-link toggle | Registered and persisted | Requires a real Telegram callback click |
| Anti-spam toggle | Registered and persisted | Requires a real Telegram callback click |
| Welcome toggle | Registered and persisted | Requires a real Telegram callback click |
| Goodbye toggle | Registered and persisted | Requires a real Telegram callback click |
| Custom Setup | Opens a same-message protection profile with raid state and Back control | Requires a real Telegram administrator callback click |
| Raid toggle | Registered through the moderator toggle namespace and persisted | Requires a real Telegram administrator callback click |
| Filters view | Registered, same-message rendered, and group-authorized | Requires a real Telegram administrator callback click |
| Warnings view | Registered, uses durable group warning count, and same-message rendered | Requires a real Telegram administrator callback click |
| Logs view | Registered, admin-gated, and same-message rendered from durable events | Requires a real Telegram administrator callback click |
| Refresh | Registered and reloads the durable group state in place | Requires a real Telegram callback click |
| Close/Back | Uses the existing menu namespace and callback renderer | Requires a real Telegram callback click |
| Ban confirmation | One-shot actor/group-bound confirmation, cancellation, expiry, cleanup | Requires a real Telegram administrator reply/callback sequence |
| Warning reset confirmation | One-shot actor/group-bound confirmation, cancellation, expiry, cleanup | Requires a real Telegram administrator reply/callback sequence |
| Tag-all confirmation | Bounded, deduplicated, exempted observed-member mention job | Requires a real Telegram administrator command/callback sequence |

The primary static risk identified and corrected was the group-start Rules route: it previously redrew the group menu instead of opening a rules view. The current code routes it through a dedicated same-message view and returns through `group:start:refresh`.

## WhatsApp group command coverage

The current command registry includes the following group-relevant or group-capable routes: `.menu`, `.ping`, `.profile`, `.autojoin`, `.setprefix`, `.pfp`, `.setgpp`, `.setname`, `.setbio`, `.creategroup`, `.groups`, `.allstatus`, `.gstatus`, `.stopstatus`, `.allchat`, `.stopchat`, `.tag`, `.stoptag`, `.health`, and `.setsudo`. The compact WhatsApp menu is registry-derived, groups commands three per line, avoids the previous wide ASCII box, and uses concise `OWNER`/`USER`, status, Auto-join, and Prefix/Help lines.

The automated suite verifies that the compact payload includes the native command surface, stays below the existing width/size guard, omits the old oversized framing, and preserves workspace authorization boundaries. It also verifies `.gstatus` job creation with group JID and bounded repeat count, owner-only command privacy, unknown-command silence, and media-backed menu construction.

Transport-level WhatsApp checks that still require a paired session include `.menu` delivery inside a real group, `.ping` response, `.groups` and `.gstatus` real API behavior, quoted/media/caption parsing, auto-join changes, profile/group-picture operations, reconnect behavior, and reply delivery after a restart.

## Live service and isolation verification

The VPS acceptance check returned:

```text
pappy-omega-mini: online, unstable restarts 0
omega-core:      online, unstable restarts 0
omega-test:      online, unstable restarts 0
```

The recent Pappy log scan reported no new `fatal startup`, `unhandled`, or `uncaught` entries. Every rollout in this acceptance cycle was Pappy-only and used a timestamped backup before copying source files and restarting the Pappy PM2 process.

## Overall verdict

**Automated acceptance: PASS.**  
**Build/type safety: PASS.**  
**Live process health and service isolation: PASS.**  
**Real Telegram callback click-through: pending paired Telegram-group verification.**  
**Real WhatsApp group-command delivery: pending paired WhatsApp-session verification.**

A true transport-level end-to-end claim requires a live paired Telegram group administrator and a live paired WhatsApp account. The current report does not falsely claim those external interactions were executed from the sandbox.
