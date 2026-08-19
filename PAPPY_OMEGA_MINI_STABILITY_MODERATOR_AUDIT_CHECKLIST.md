# Pappy Omega Mini — WhatsApp Stability and Telegram Moderator Audit

**Authoritative source:** `Pappy_Omega_Mini_WHATSAPP_STABILITY_AND_TELEGRAM_MODERATOR_MASTER_PROMPT.txt` supplied by the product owner.

## Priority order

The prompt explicitly requires WhatsApp stability before moderator expansion. No moderator UI is considered complete without durable state, protected permissions, real Telegram API execution, failure handling, observability, and tests.

## Part A — WhatsApp stability

| ID | Requirement | Current evidence | Status |
|---|---|---|---|
| A1 | Authoritative lifecycle: CREATING, PAIRING, PAIRING_CODE_READY, AUTHENTICATED, CONNECTING, ONLINE, RECONNECTING, DEGRADED, LOGGED_OUT, BANNED_OR_RESTRICTED, FAILED, PURGED | Existing domain states and Baileys connection handler use a smaller mixed vocabulary | PARTIAL |
| A2 | One supervisor/socket owner per session, distributed lock, bounded jittered reconnect, no zombie listeners | Redis session lock, lifecycle map, reconnect backoff exist; state authority and listener-generation proof need completion | PARTIAL |
| A3 | Safe encrypted creds.update persistence and registered-auth verification | Encrypted store and `registered === true` startup check now deployed | PARTIAL / RECENTLY FIXED |
| A4 | Full messages.upsert → normalization → auth → handler → reply trace | Router and redacted inbound/outbound telemetry now deployed; message IDs/authorization/handler fields still need structured event records | PARTIAL |
| A5 | Owner/self/sudo identity resolution across JID, LID, participantAlt, remoteJidAlt | Recent normalization and fromMe handling deployed; live end-to-end proof still pending | PARTIAL |
| A6 | Prefix/no-prefix, quoted/media/caption/URL/group/DM parsing | Prefix and text/quoted basics exist; reusable media/quoted resolver incomplete | PARTIAL |
| A7 | One clean authenticated connected notification, no reconnect spam | Pairing notifier exists on authenticated open; live proof is pending because previous auth was unregistered | PARTIAL |
| A8 | Health truth combines socket, heartbeat, inbound, outbound, auth, worker | Heartbeat and status exist; composite health and live timestamps need completion | PARTIAL |
| A9 | Purge only definitive terminal state; cleanup listeners/locks/workers | Terminal classifications and cleanup exist; state/persistence contract needs completion | PARTIAL |
| A10 | Owner-only diagnostics for socket, messages, parsing, auth, reply, quoted, reconnect, restore, restart | New redacted telemetry exists; Telegram diagnostic view needs completion | PARTIAL |

## Part B — Telegram moderator

| ID | Requirement | Status |
|---|---|---|
| B1 | Group registration, permission check, setup status, Quick Protect/Custom Setup | MISSING / TO AUDIT |
| B2 | Protected grouped moderator UX and command scopes | MISSING / TO AUDIT |
| B3 | Durable per-group settings, rules, welcome/goodbye, staff, whitelist, filters, lock state | MISSING / TO AUDIT |
| B4 | Unified DETECT → CLASSIFY → EXEMPTION → RECORD → ACTION → EXECUTE → NOTIFY → CLEANUP engine | MISSING / TO AUDIT |
| B5 | Warning records and `/warn`, `/warns`, `/resetwarn`, `/warnlimit`, `/warnlist` | MISSING / TO AUDIT |
| B6 | User mute and group-wide mute with expiry | MISSING / TO AUDIT |
| B7 | Staff add/remove/list, trusted users, whitelist, real Telegram permission limits | MISSING / TO AUDIT |
| B8 | Protected commands: moderation, rules, filters, anti-spam, anti-link, logs, welcome/goodbye | MISSING / TO AUDIT |
| B9 | DM/group permission-aware command suggestions | MISSING / TO AUDIT |
| B10 | Welcome/goodbye templates with real mentions and optional media/cleanup | MISSING / TO AUDIT |
| B11 | Rules state machine and editable templates | MISSING / TO AUDIT |
| B12 | Controlled tag-all with dedupe, bot/admin exclusions, limits, progress, cancellation | MISSING / TO AUDIT |
| B13 | Anti-link with invite/obfuscated/link text detection, whitelist/trusted exemptions | MISSING / TO AUDIT |
| B14 | Redis sliding-window anti-spam/flood counters with TTL | MISSING / TO AUDIT |
| B15 | Raid/join flood protection with temporary lockdown and recovery | MISSING / TO AUDIT |
| B16 | Admin-only moderation logs with result/failure reason | MISSING / TO AUDIT |
| B17 | Group/member exemptions and bot self-protection | MISSING / TO AUDIT |
| B18 | Moderator dashboard with real counts and grouped controls | MISSING / TO AUDIT |

## Acceptance matrix

### WhatsApp

Pairing code delivery, authenticated open, connected notification, `.ping`, `.menu`, owner, sudo, unauthorized silence, quoted/media commands, prefix/no-prefix, transient reconnect, extended runtime, process restart, logout, permanent auth failure, cleanup, listener uniqueness, zombie prevention, and no silent message loss all require end-to-end proof.

### Telegram Moderator

Group setup, permission checks, admin-only controls, ordinary-user denial, suggestions, anti-link, anti-spam, flood, warnings, mute/unmute, kick/ban/unban, promotion/demotion, welcome/goodbye, rules, filters, whitelist, logs, controlled tag-all, group isolation, Redis TTL expiry, and restart persistence all require focused tests.

## Implementation order

1. Diagnose and complete WhatsApp stability.
2. Run WhatsApp regression and production health checks.
3. Build moderator registration, permission, settings, moderation engine, warnings, mutes, and logs.
4. Add protection modules: anti-link, anti-spam, flood, anti-forward, anti-bot, filters, raid, whitelist.
5. Finish UX: welcome, goodbye, rules, dashboard, command suggestions, polished Telegram/WhatsApp views.

## Non-regression rules

Never invalidate healthy auth, purge during deployment, rename persisted fields without migration, restart unrelated services, claim online from a database field alone, silently swallow processing errors, or mark a UI-only feature implemented.
