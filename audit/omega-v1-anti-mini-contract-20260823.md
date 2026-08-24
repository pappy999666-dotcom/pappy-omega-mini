# Omega‑V1 Anti System → OMEGA‑MINI Contract Audit

**Date:** 2026-08-23  
**Scope:** WhatsApp Anti System parity; this is distinct from the previously deployed reliability hardening slice.

## Authoritative Omega‑V1 contract

Omega‑V1 exposes one `🛡 ANTI SYSTEM` menu section, not a literal `.antisystem` command. Its registered surface includes `antistatus`, module action commands, module permits, custom messages, AntiSpam limits, AntiWords list management, `silentactions`, and AntiPromote/AntiDemote security modes. Message-driven modules are group-scoped and default disabled. The normal-module target policy is `members`; administrators and protected identities are skipped before enforcement. AntiPromote/AntiDemote use a separate participant-event security engine and target modes.

| Module | Omega‑V1 detector/event | Config/action | Mini raw signal | Mini implementation status | Safe boundary |
|---|---|---|---|---|---|
| AntiLink | URL/link in inbound message | kick, warn N, delete, off; permit/message | text, captions, quoted text | Supported | group only; no command interception; protected/admin/permit skip |
| AntiBot | bot/automation client fingerprint | kick, warn N, delete, off; permit | not forwarded by current Mini event contract | Configuration/status only until a verified client signal exists | Never infer bot status from text or sender shape |
| AntiSpam | rolling sender window | kick, warn N, delete, off; limit; permit/message | inbound event timing | Supported | bounded in-memory window, per workspace/session/group/sender |
| AntiPic | image message | kick, warn N, delete, off; permit | imageMessage/media payload | Supported | image only; no caption misclassification |
| AntiVid | video message | kick, warn N, delete, off; permit | videoMessage/media payload | Supported | video only |
| AntiAud | audio message | kick, warn N, delete, off; permit | audioMessage/media payload | Supported | audio only |
| AntiVN | voice-note (`ptt`) | kick, warn N, delete, off; permit/message | audioMessage.ptt/media payload | Supported | distinct from ordinary audio |
| AntiText | plain text only | kick, warn N, delete, off | conversation/extended text | Supported | prefixed commands bypass; not a word-list detector |
| AntiEmoji | emoji message | kick, warn N, delete, off; permit/message | text content | Supported | deterministic Unicode emoji-only/emoji-containing detector per V1 semantics |
| AntiSticker | sticker message | kick, warn N, delete, off; permit | stickerMessage/media payload | Supported | sticker only |
| AntiGroupCall | incoming group call event | kick, warn N, delete, off | no call event in Mini inbound adapter | Configuration/status only until call events are wired | no message-based approximation |
| AntiNSFW | async image/video provider verdict | kick, warn N, delete, off; permit | no configured provider in Mini | Capability-unavailable status; no fake verdict | remains disabled and reports provider unavailable |
| AntiGroupMention | group/channel mention blast | kick, warn N, delete, off; permit | mentionedJid/contextInfo only; groupMentions not currently preserved | Partial; enable only for verified mention signal | no inference from ordinary @ text |
| AntiGM | group mentioned from WhatsApp Status | kick, warn N, delete, off; permit | status wrappers are locally unwrap-capable; worker does not forward wrapper metadata | Local-only if raw wrapper is present; panel unavailable | never classify ordinary group text as status mention |
| AntiWords | configured case-insensitive phrases | kick, warn N, delete, off; add/remove/list/set/rm/clear/message | text/captions/quoted text | Supported | list owned only by AntiWords; AntiText remains separate |
| AntiPoll | poll creation event/message | kick, warn N, delete, off; permit | poll object not currently preserved in Mini inbound event type/worker serialization | Configuration/status only until raw poll signal is retained | no text approximation |
| AntiForward | forwarded-message context | kick, warn N, delete, off; permit | forwarding context not forwarded by panel worker; local raw envelope may contain it | Local-only pending verified raw context; panel status unavailable | no guess from quoted text |
| AntiChannel | forwarded channel/newsletter post | kick, warn N, delete, off; permit | newsletter metadata not forwarded by panel worker | Configuration/status only for panel; local only after verified signal | no sender/domain guess |
| AntiPromote | `group-participants.update` promote | security modes, target mode | no Mini participant-event listener currently | Command/config surface first; event wiring separate | no live enforcement without explicit approval |
| AntiDemote | `group-participants.update` demote | security modes, target mode | no Mini participant-event listener currently | Command/config surface first; event wiring separate | bot self-protection not silently added to live sessions |
| AntiGStatus | group status wrapper/context flag | kick, warn N, delete, off | local wrapper helper can expose group-status wrapper; worker omits raw wrapper | Local-only pending verified path | no ordinary-status approximation |

## Mini transport and lifecycle findings

The local Mini `messages.upsert` path currently receives remote JID, participant/alternate participant, message ID, `fromMe`, limited raw message fields, quoted context, text, and resolved media. It enqueues one inbound task per message, records telemetry, collects non-command invite links, and then routes only prefixed direct commands. This provides a safe insertion boundary: run a nonblocking, isolated Anti evaluator after message normalization and before command routing, while leaving prefixed command parsing unchanged. Anti evaluation must never process `fromMe`, direct chats, missing group JIDs, or an event whose sender role cannot be freshly established.

The local transport already supports `groupParticipantsUpdate`, `updateBlockStatus`, group metadata/moderation snapshots, and generic `sendMessage`. A dedicated message-delete helper is still required and must use the original message key. Panel-assigned workload transport currently forwards only normalized inbound fields and omits raw forwarding flags, newsletter/channel metadata, polls, call events, and full message keys/context. Therefore panel parity for those modules cannot be claimed until the worker contract is extended and separately tested.

## Persistence decision

The existing `ModeratorGroupRecord` is Telegram-oriented and keyed only by `groupId`; it must not be reused for WhatsApp Anti settings because it is not scoped by workspace and session. Mini Anti configuration must be isolated by `workspaceId + sessionId + groupJid`, versioned, and default-off. It must contain module state, action, warning threshold, permits, custom messages, AntiSpam window, AntiWords list, security target/mode, silent notices, and capability status. A file-backed store under the session root is acceptable for local sessions only if it is atomic and scoped; production durability should use a dedicated Mongo collection or equivalent session-scoped durable record.

## Enforcement safety contract

Every ordinary message module must fail closed when group metadata is unavailable; skip admins, the bot, session owner, workspace owner, global sudo, and module permits; bypass prefixed commands; deduplicate by session/group/message ID; and isolate module failures with `Promise.allSettled`/per-module catches. Destructive actions remain disabled by default. Deterministic tests must cover disabled no-op, group-only routing, command bypass, admin/permit exemptions, URL/media/text/word detection, spam thresholds, warning escalation, workspace/session/group isolation, event dedupe, and delete/kick action mocks. No live Anti enforcement, Kick All, block, removal, or message deletion is authorized by this audit.

## Deployment status before Anti implementation

The prior smart-batch artifact was found not to be present remotely despite healthy services. It was corrected with a backed-up control-only swap. Final remote verification passed for control active, panel active, workload health `ok`, Kick All marker, batch transport marker, the 1,000-member cap, and absence of the temporary live approval probe. This does not validate any real WhatsApp operation.
