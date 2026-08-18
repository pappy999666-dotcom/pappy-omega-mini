# PAPPY OMEGA MINI — Normalized Requirements

## Product direction

PAPPY OMEGA MINI is a Telegram-first control plane for multiple isolated WhatsApp sessions. Telegram handles onboarding, force-join, pairing, session management, bridges, link validation, scheduling, administration, support, and broadcasts. WhatsApp remains the operational command surface for status posting, group messaging, tagging, profile/group controls, and session-local commands.

## Non-negotiable constraints

The authoritative WhatsApp transport is `@crysnovax/baileys`. Existing session authentication and healthy sessions must never be damaged by menu or cosmetic changes. Every session, job, link, permission, setting, media item, and audit record is scoped to a workspace. Long operations are queued, bounded, resumable, cancellable, retry-safe, and idempotent. Destructive actions require confirmation. Secrets are generated or entered through setup and never committed.

## Telegram scope

The first gate after `/start` is configurable force-join for any number of Telegram channels/groups. Button labels are admin-defined and membership verification must be honest. The main menu exposes Help, Pair, Sessions, Bridge, Validator Hub, Join Manager, Scheduled Jobs, Settings, and Support. Pairing is an interactive session-name → country-aware phone-number → pairing-code flow with progress, copy support, retry, and no premature purge. Sessions are paginated and each session owns an isolated submenu.

The per-session submenu covers WhatsApp PFP, name, bio, username where the installed Baileys API supports it, groups, group creation, owned groups, leave-group confirmation, sudo, join manager, health, delete confirmation, and bridge execution. The owner has global sudo, all-session bridge, all-session auto-promote, user management, force-join, master bucket, broadcasts, usage dashboard, audit, ban/unban, and emergency controls.

## Link system

All sessions can collect WhatsApp group links into one deduplicated Main bucket. Validator workers use available sessions without joining links, classify records into Active, Dead, or Error, and expose live progress. Bucket actions include download as styled TXT/HTML, merge back to Main, remerge, purge, and metadata display. Large files, forwarded messages, and batches enter Main immediately and validate asynchronously.

## WhatsApp scope

The command registry dynamically exposes `.ping` and `.menu` plus `gstatus`, `allstatus`, `allchat`, `tag`, `setsudo`, `setprefix`, `.pair`, profile controls, join controls, bucket controls, and advanced X variants. Quoted text/media/captions must be preserved. `.setprefix` supports arbitrary safe prefixes and prefixless mode. Mentions use real usable JIDs and never expose LID values. Mass actions use bounded workers, progress, pause/stop/cancel, retry, backpressure, and safe rate controls; they do not promise impossible delivery guarantees or bypass platform anti-abuse controls.

## Preview pipeline

Every outgoing URL-bearing payload passes through one centralized detector/preview manager, except explicit media-only payloads. Existing complete previews are preserved. Partial previews are hydrated only for missing metadata or thumbnails. Results are cached with schema versions, host circuit breakers, latency/success metrics, and graceful no-preview fallback so one broken host cannot block a mass operation.

## Deployment contract

Deployment is interactive and secret-safe. It asks for Telegram token, owner IDs, database URL, Redis URL, encryption secret, timezone, directories, optional webhook/domain, and optional object storage. It validates Node, Telegram identity, owner IDs, Redis, database, storage, encryption, Baileys auth, and workers. It can run under PM2 or Docker Compose with persistent session/media volumes, graceful shutdown, health checks, migrations, and no manual source edits.

## Safety interpretations

“Unlimited” means no artificial small allocation in the user interface; runtime quotas, queue pressure, storage limits, and platform safety controls still apply. “Aggressively fast” means optimized bounded concurrency and backpressure, not deliberate rate-limit evasion. Preview reliability means complete fallback behavior and observable recovery, not an impossible absolute guarantee against third-party failures.
