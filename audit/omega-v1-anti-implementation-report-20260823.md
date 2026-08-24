# Omega‑V1 WhatsApp Anti System — OMEGA‑MINI Implementation Report

**Date:** 2026-08-23  
**Author:** Manus AI  
**Scope:** Complete Omega‑V1-style WhatsApp Anti System surface for OMEGA‑MINI. This work is separate from the earlier AntiSystem reliability/queue hardening slice.

## Executive result

The tested OMEGA‑MINI source now contains a complete `🛡 ANTI SYSTEM` WhatsApp command/menu surface rather than a literal `.antisystem` command or an Anti-Link-only patch. Configuration is group-scoped and isolated by workspace, session, and WhatsApp group JID. All Anti modules remain **OFF by default**, so deploying the artifact cannot silently enable destructive moderation in existing groups.

The implementation was compiled successfully and the complete local regression suite passed **26 test files and 212 tests**. The tested artifact was **not deployed to production** because the remote VPS accepted the SSH connection but rejected the currently available credential. No live Anti enforcement test was performed, and no live Anti action was enabled, deleted, kicked, blocked, approved, rejected, or otherwise mutated.

## User-visible command surface

The WhatsApp menu now includes a dedicated `🛡 ANTI SYSTEM` section containing the complete module controls, status overview, permits, custom messages, AntiWords list management, AntiSpam limit, and participant security controls.

| Surface | Commands included |
|---|---|
| Overview | `.antistatus` |
| Message modules | `.antilink`, `.antibot`, `.antispam`, `.antipic`, `.antivid`, `.antiaud`, `.antivn`, `.antitxt`, `.antitext`, `.antiemoji`, `.antisticker`, `.antigroupcall`, `.antinsfw`, `.antigroupmention`, `.antigm`, `.antipoll`, `.antiforward`, `.antichannel`, `.antigstatus` |
| Actions | `kick`, `warn N`, `delete`, `off`; each configuration is restricted to the current group and requires fresh administrator authorization |
| AntiSpam | `.spamlimit <messages> <seconds>` |
| Permits | Module-specific add/remove permit commands for link, bot, spam, image, video, audio, voice note, emoji, sticker, NSFW, group mention, GM, poll, forward, and channel controls |
| Custom messages | Module-specific `...msg` commands for link, spam, voice note, text, emoji, words, group mention, GM, poll, forward, channel, and group status controls |
| AntiWords | `.antiwords`, `.antiaddword`, `.antirmword`, `.antiwordlist`, `.setantiwords`, `.rmantiwords`, `.clearantiwords`, `.antiwordsmsg` |
| Security controls | `.antipromote`, `.antidemote`, and `.silentactions` |

The ordinary WhatsApp prefix gate remains unchanged. Anti configuration commands are registered in the existing dispatcher, while the Anti module is loaded lazily to avoid introducing a command-registry/session-manager/transport import cycle. Telegram Bridge prefix-independent behavior remains separate and unchanged.

## Configuration and isolation

Anti settings are stored in a dedicated, versioned file-backed store under the existing session root. The key is effectively `workspaceId + sessionId + groupJid`; Telegram moderator-group records are not reused. Each group record contains module state, action, warning threshold, permits, custom messages, AntiSpam limits, AntiWords, security mode/target, silent notices, capability status, and update time.

The store uses an atomic temporary-file write followed by rename, creates the scoped directory with restrictive permissions, and returns a non-persisted default configuration when no record exists. The default state is safe: no enforcement module is enabled.

## Enforcement coverage

Inbound enforcement is invoked from the normalized WhatsApp `messages.upsert` path before the existing media-only early return, but it is intentionally nonblocking and isolated from command routing. If no message module is enabled for a group, the evaluator returns before requesting fresh group metadata. A message is ignored when it is from the bot itself, is not a WhatsApp group message, has no sender, cannot obtain fresh group metadata, or the bot is not an administrator.

Administrators, the bot identity, configured session/global sudo identities, and module-specific permits are exempted. Message IDs are deduplicated for a bounded period. Module failures are caught independently so one detector or moderation action cannot block normal WhatsApp command routing.

| Module | Current status | Detection/action boundary |
|---|---|---|
| AntiLink | Implemented | HTTP links in direct/quoted text; supports delete, warn escalation, and batch removal |
| AntiSpam | Implemented | Per sender/group/session rolling window; bounded message count and time window |
| AntiPic | Implemented | Image media only |
| AntiVid | Implemented | Video media only |
| AntiAud | Implemented | Audio media only |
| AntiVN | Implemented | Voice-note audio where `ptt` is true |
| AntiText | Implemented | Plain text only; configured session-prefix commands bypass it |
| AntiEmoji | Implemented | Emoji-only text detection |
| AntiSticker | Implemented | Sticker media only |
| AntiWords | Implemented | Case-insensitive configured phrases in direct/quoted text |
| AntiGroupMention | Capability-gated | Runs only when raw `groupMentions` metadata is present |
| AntiGM | Capability-gated | Runs only when raw group-status wrapper plus group-mention metadata is present |
| AntiPoll | Capability-gated | Runs only when raw poll message metadata is retained |
| AntiForward | Capability-gated | Runs only when raw forwarding context is retained |
| AntiChannel | Capability-gated | Runs only when raw newsletter/channel metadata is retained |
| AntiGStatus | Capability-gated | Runs only when raw group-status metadata is retained |
| AntiBot | Unavailable | No verified client-fingerprint signal is available; configuration reports unavailable and never guesses |
| AntiGroupCall | Unavailable | Current Mini adapter does not forward group-call events |
| AntiNSFW | Unavailable | No NSFW provider is configured; no fake verdict is generated |
| AntiPromote | Local-only | Local Baileys participant updates are wired; participant-event enforcement is capability-gated until production event forwarding is separately verified |
| AntiDemote | Local-only | Same boundary as AntiPromote |

The current participant-event adapter supports restore, warn, remove, demote, and block sequencing according to the configured security mode, while respecting bot/self and permit exemptions. It is not live-enabled by default.

## Important limitation: panel workload parity

The current panel-worker inbound contract forwards normalized message content but does not yet preserve every raw signal required for full parity. In particular, panel forwarding does not currently provide all forwarding context, newsletter/channel metadata, poll objects, group-call events, or complete raw message keys. Therefore the status system reports those modules as `local-only` or `unavailable` rather than claiming false parity. Extending the worker event contract is a separate compatibility change and should be performed only with dedicated panel tests; the panel service was not restarted for this work.

Message deletion uses the original Baileys message key through a new transport-backed helper. Where the key is unavailable, the action cannot be safely executed and the engine fails closed rather than deleting an unrelated message.

## Verification evidence

The new deterministic test file validates the complete command/menu surface, group and administrator authorization, disabled-by-default behavior, workspace/session/group isolation, custom messages, permits, AntiWords, silent actions, URL detection, media and voice-note detection, custom-prefix command bypass, unsupported capability reporting, warning escalation, and AntiPromote/AntiDemote restore/penalty ordering.

The final regression run was:

```text
Test Files  26 passed (26)
Tests       212 passed (212)
Build       npm run build — passed
```

The expected local Redis `ECONNREFUSED 127.0.0.1:6379` warnings were emitted by existing test infrastructure; they did not fail the suite. No live WhatsApp group was used for Anti testing.

## Deployment state

A previous smart-batch deployment mismatch was corrected earlier through a backed-up control-only swap. For the Anti artifact, the local build and tests passed, but the subsequent production deployment could not authenticate to the remote VPS. The SSH handshake reached the host and offered password authentication, then returned `Permission denied`. Consequently:

> **Production Anti System status: not deployed and not verified live.**

The panel service was not restarted. No automatic re-pairing, session purge, group approval/rejection, Kick All, block, removal, or live Anti action was attempted.

## Remaining operational risks

The previously observed WhatsApp 401 connection-close loop and persisted ACTIVE/DEGRADED state mismatch remain operational risks. The stable-open gate reduces false ACTIVE flashes but does not prove that every persisted status is authoritative. Baileys parse/decryption warnings and high message traffic can still affect CPU and event-loop pressure. Panel lifecycle parity remains separate from local-socket parity. These risks are not hidden by the Anti implementation.

Before enabling any destructive Anti action, production access must be restored, the artifact must be deployed with a remote backup, the control service must be health-checked, and a user-authorized controlled test group must be explicitly approved. The first live test should use a non-production group and a single harmlessly observable module configuration, not Kick All, block, broad removal, or bulk deletion.

## Source references

The implementation and audit were grounded in the following repository sources:

1. `/home/ubuntu/omega-v1/artifacts/wa-bridge/src/whatsapp/menu-registry.ts` — authoritative Omega‑V1 Anti menu catalog.
2. `/home/ubuntu/omega-v1/artifacts/wa-bridge/src/whatsapp/command-parser.ts` — authoritative Omega‑V1 Anti command registration.
3. `/home/ubuntu/omega-v1/artifacts/wa-bridge/src/whatsapp/anti-system/commands.ts` — Omega‑V1 command semantics.
4. `/home/ubuntu/omega-v1/artifacts/wa-bridge/src/whatsapp/anti-system/config.ts` and `types.ts` — Omega‑V1 configuration and data contracts.
5. `/home/ubuntu/pappy-omega-mini-migration/audit/omega-v1-anti-mini-contract-20260823.md` — source-grounded Mini capability matrix.
6. `/home/ubuntu/pappy-omega-mini-migration/src/whatsapp/anti-system/` — OMEGA‑MINI Anti configuration, command, type, and enforcement implementation.
7. `/home/ubuntu/pappy-omega-mini-migration/tests/whatsapp-anti-system.test.ts` — deterministic Anti parity and isolation tests.

## Final Omega‑V1 payload-hardening and live rollout

The Anti engine was hardened after the initial implementation. It now uses sender-owned recursive extraction across supported nested wrappers, including ephemeral, view-once, document-with-caption, edited, bot-forwarded, status, and associated-child payloads. It scans visible text, link-preview fields, media captions, button/list/template responses, interactive native-flow parameters, poll names/options, and edited payloads. It does not traverse `contextInfo.quotedMessage` and does not scan transport/media URLs, so quoted links and CDN URLs cannot trigger AntiLink.

AntiLink recognizes validated HTTP/HTTPS/FTP links, `www` links, and domain-style links in sender-owned payload fields. AntiPoll includes supported poll-creation versions. AntiGM requires a populated genuine `groupStatusMentionMessage`; AntiGStatus separately requires a populated group-status post wrapper. Empty protobuf stubs are ignored. AntiText excludes media, interactive/system content, and canonical link-preview messages. AntiEmoji detects sender-owned emoji anywhere in the payload. AntiBot uses only conservative raw message-key/client metadata heuristics and ignores uncertain messages.

Normal message Anti modules fetch fresh group metadata and exempt the bot, group administrators, configured sudo/owner identities, and module permits before enforcement. AntiPromote and AntiDemote remain the dedicated administrator-change security path with their separate restore/penalty modes. NSFW, group-call, and panel-only raw-event limitations remain reported as unavailable or local-only rather than approximated.

The hardened release was deployed with the atomic masked control-only procedure. Local and remote SHA-256 hashes match for the control entrypoint, command registry, Anti engine, and generated worker. Control and panel services are active, workload health is `ok`, native-confirmation and panel interaction markers are present, temporary probe code is absent, and staging files are clean. No destructive live Anti action was executed.

The final local verification after hardening passed **26 test files and 221 tests**, plus the TypeScript build. The expected local Redis connection warnings remained non-fatal.
