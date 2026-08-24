# Omega-V1 Telegram → PAPPY OMEGA MINI Integration Map

**Reference:** `pappy999666-dotcom/omega-v1`, revision `7e59850`, inspected from `artifacts/wa-bridge/src/telegram`.  
**Target:** `/home/ubuntu/pappy-omega-mini-migration`, current Telegram control plane.  
**Scope:** Telegram menus, callback handlers, input-state flows, per-session controls, group controls, admin controls, and feature discoverability. Existing bridge surfaces are intentionally excluded from duplication.

## Executive summary

Omega-V1 has eight Telegram slash commands, a top-level menu, a per-session dashboard, a group dashboard, a Validator Hub, a Settings hub, an owner Admin Panel, and dedicated handlers for promotion, feedback, tutorials, and rich message rendering. PAPPY already has a larger, architecture-specific control plane for workloads, durable jobs, centralized validation, Auto Promote, Inceptor, support, and bridge transport. Therefore the correct integration is a **feature crosswalk**, not a source copy: preserve PAPPY’s ownership, worker isolation, session lifecycle, and centralized validator rules while adding Omega’s missing navigation depth only where PAPPY has a real backend capability.

## 1. Complete Omega-V1 Telegram handler inventory

| Omega module | Handler families found | PAPPY treatment |
|---|---|---|
| `bot.ts` | `/start`, `/sessions`, `/bucket`, `/admin`, `/jid`, `/omni`, `/unbind`, `/help`; onboarding; media/document/photo/video/audio listeners; callback dispatcher; idea/release/tutorial routes | Main menu, pairing, sessions, Validator Hub, admin, support, and existing bridge are retained in PAPPY-native routes. `/omni` and `/unbind` are not duplicated because bridge transport already exists separately. |
| `handlers/session.ts` | Session list, new session, pairing code, session info, freeze, unfreeze, reconnect, purge, link collection, Join Manager, bridge entry/exit | Retained and adapted to PAPPY’s session registry, workload assignment, durable jobs, and isolated input states. Bridge entry/exit is excluded from the new mapping. |
| `handlers/promotion.ts` | Smart Promotion menu, Smart/Manual wizard, target/batch/cycle/limit/content steps, media input, live dashboard, run/pause/resume/stop/delete-confirm | PAPPY’s Auto Promote and scheduled-job surfaces are retained as the native equivalent. The separate Omega Smart Promotion engine is not advertised because PAPPY has no equivalent backend or persistence model. |
| `handlers/bucket.ts` | Validator dashboard, live feed, bucket views, add links, exports, purge prompts, merge-to-main, dead purge | PAPPY’s centralized Validator Hub is retained. User-scoped Omega bucket ownership and destructive merge behavior are not reintroduced; PAPPY’s admin-owned Main/Validating/Active/Dead/Error model remains authoritative. |
| `handlers/admin.ts` | Global Sudo, Omni Owner, Admin Panel, new-session defaults, users, ban/unban, inspect, purge sessions, Master Bucket, platform pause, maintenance, stats, release, logs, restart/update, Menu URL manager | PAPPY-native Admin Panel already contains workload, Inceptor, job, support, force-join, emergency, audit, media, broadcast, and Auto Promote controls. Existing equivalents remain; unsupported Omega-only surfaces are recorded below instead of stubbed. |
| `handlers/feedback.ts` | User idea intake, admin idea list/detail/reply/complete/delete | PAPPY support tickets are the available real backend. A separate Idea Inbox is not advertised until a dedicated persistence lifecycle is added. |
| `handlers/tutorials.ts` | Tutorial list, add, media type, upload, preview, delete-confirm | Not ported because PAPPY has no tutorial-content persistence or delivery contract. |
| `handlers/group-bridge.ts` | Group bridge state, set/get/clear/active | **Excluded by request.** PAPPY already has per-session and global bridge implementations. |
| `middlewares/auth.ts` | Auth, force-join, owner-only, global pause, maintenance | PAPPY has workspace ownership checks, admin checks, workload gating, emergency mode, and per-callback authorization. |
| `renderer.ts` | Telegram HTML/plain-text/blockquote normalization and safe rendering | PAPPY renderer retained and used by the new help/group screens. |
| `rich-messages.ts` | Rich table send/edit helpers | PAPPY renderer and existing in-place edit helper retained. |
| `ui/keyboards.ts` | All keyboard builders for main menu, sessions, Game API, AI Group, session menu, Join Manager, Validator Hub, Smart Promotion, admin, settings, sleep mode, ideas, Menu URL | PAPPY-native builders are retained. Categorized Help and the richer group-detail keyboard were added without copying bridge routes. |

## 2. PAPPY-native menu tree after integration

### Main control center

The main center contains Pair Number, Sessions, Validator Hub where authorized, Auto Promote, Global Bridge, Scheduled Jobs, Live Show, Workload, Settings, Support, Help, and Admin Panel for owners. Global and per-session bridge controls remain separate and are not duplicated in the Omega feature catalog.

### Session dashboard

A session opens into Overview, WhatsApp Tools, My Groups, Session Bridge, Auto Promote, Join Manager, Health & Jobs, Session Settings, Reconnect, Access/Sudo for authorized owners, and Purge. Existing actions are preserved and now have a complete categorized Help representation.

### Group detail dashboard

The selected group now has PAPPY-native controls for Edit Name, Edit Description, Set Picture, Get Picture, Invite Link, and Leave Group. Name and description inputs use an exclusive pending state, validate WhatsApp limits, call canonical transport functions, and return to the selected group. Group-picture retrieval uses the session socket’s profile-picture API and does not duplicate or overwrite another group’s state.

### Settings and Help

Help now has section navigation for Session & Profile, Groups & Join Manager, Broadcast Network, Status & Tagging, and Support & Diagnostics. Each section lists exact supported commands and their purpose. The Help surface explicitly states that Bridge is kept separate and is not duplicated.

## 3. Exact PAPPY command coverage represented in Help

| Section | PAPPY-native coverage |
|---|---|
| Session & Profile | `.pair`, Sessions, `.ping`, `.profile`, `.health`, `.setprefix`, `.pfp`, `.setname`, `.setbio`, `.setsudo` |
| Groups & Join Manager | `.groups`, `.creategroup`, `.setgpp`, `.join`, `.targetgs`, `.autojoin`, `.iggc`, plus selected-group name/description/picture/invite/leave controls in Telegram |
| Broadcast Network | `.allstatus`, `.dallstatus`, `.allstatusx`, `.allchat`, `.allchatx`, `.stopstatus`, `.stopchat`, `.broadcastdelay` |
| Status & Tagging | `.pstatus`, `.gstatus`, `.dgstatus`, `.gstatusx`, `.tag`, `.stag`, `.stopstag` |
| Support & Diagnostics | `.previewdebug`, `.support`, `.menu`, `.help` |

## 4. Omega features intentionally not represented as implemented

These entries are not silently omitted; they require new backend contracts and would be unsafe to expose as buttons that do nothing.

| Feature | Omega surface | Reason not added as a fake button |
|---|---|---|
| Game API | `session:<id>:gameapi` | No PAPPY Game API credential/provider service exists. |
| AI Group / Meta AI | `session:<id>:aigroup` | No PAPPY Meta AI group workflow exists. |
| Plugins | `session:<id>:plugins` | No PAPPY plugin registry, sandbox, or lifecycle exists. |
| Smart Promotion | `session:<id>:smartpromo` | PAPPY Auto Promote is the supported equivalent; the separate Omega wizard requires a different durable job model. |
| Tutorial Content | `admin:tutorials` | No tutorial media store and preview/delete lifecycle exists. |
| Release Controls | `admin:release:menu` | PAPPY deployment is controlled by the release/deploy path; exposing self-update callbacks would bypass deployment safety. |
| Menu URL Manager | `admin:menuurl` | No persisted custom Telegram menu-button model exists. |
| Idea Inbox | `admin:ideas` | PAPPY support tickets exist, but a separate idea state machine does not. |
| Deep member moderation dashboard | `gcset:<session>:<group>` | PAPPY transport currently supports group metadata, picture, subject, description, invite, and leave. It does not expose a complete safe member-moderation API to Telegram. |
| Omega bucket mutation semantics | `bucket:merge:main`, user-scoped bucket controls | PAPPY’s centralized validator architecture intentionally prevents user-owned bucket mutation from reappearing. |

## 5. Input-state isolation rules

PAPPY clears all pending guided inputs when a new Telegram command or a new exclusive flow begins. The new group setting state is included in that clearing path. Pairing, group editing, group picture, group leave, Join Manager settings, Auto Promote, workload enrollment, support, and bridge inputs therefore cannot consume each other’s messages.

Every new group callback verifies session ownership before reading or mutating a group. Every destructive leave operation still requires confirmation. Group name and description values are bounded before transport calls. The Help callbacks only render catalog data and do not invoke WhatsApp transport.

## 6. Verification record

The new group-detail keyboard and categorized Help hub are covered by Telegram UI tests. Focused validation passed with **25 tests**, including the new Help and group-detail assertions. TypeScript typecheck passed. The full regression suite and production deployment remain the next gate before these latest Telegram changes are installed on the live control plane.
