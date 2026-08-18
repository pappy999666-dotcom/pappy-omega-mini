# pappy-omega-mini

**pappy-omega-mini** is a from-scratch Telegram + WhatsApp SaaS bot foundation. It is designed around isolated workspaces, isolated WhatsApp sessions, a shared command/menu model, durable session authentication boundaries, bounded background work, and a polished text-first interface that remains readable in ordinary WhatsApp clients.

> Stability comes before feature breadth. The WhatsApp transport is kept behind a dedicated session-manager boundary and uses the installed `@crysnovax/baileys` package rather than a substitute protocol library.

## Current foundation

The repository now contains a strict TypeScript service scaffold with the following working pieces:

| Area                      | Current implementation                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot identity              | `pappy-omega-mini` is used in the Telegram and WhatsApp-facing menu copy.                                                                                            |
| Tenancy                   | Telegram users resolve to isolated workspaces; sessions and media are checked against workspace ownership.                                                           |
| Shared menus              | Telegram inline menus and WhatsApp ASCII menus are generated from the same session capability model.                                                                 |
| Simple WhatsApp shortcuts | `.menu`, `.ping`, `.profile`, `.autojoin on                                                                                                                          | off`, `.pfp`, `.setgpp`, `.groups`, `.health`, `.setname`, `.setbio`, `.setsudo`, and `.setprefix` are registered. |
| Auto-join                 | Per-session toggle defaults to OFF and is explicit in the menu. Large join operations remain intended for bounded jobs with conservative rate controls.              |
| Profile controls          | PFP, name, bio, and group-picture actions are exposed through the shared menu and concise command aliases.                                                           |
| Admin media               | Owners can open **Admin Media**, choose **Add Image** or **Add Video**, upload the file, review the workspace-scoped library, and attach media to the WhatsApp menu. |
| WhatsApp transport        | The session manager uses the installed package's verified `makeWASocket` and `makeCacheManagerAuthState` exports with file-backed auth state.                        |
| Verification              | Strict TypeScript compilation and Vitest tests cover menu controls, workspace isolation, auto-join changes, and media attachment.                                    |

## Local setup

Use Node.js 20 or newer. Install dependencies with `pnpm install`. The package manager may request approval for native dependency build scripts; review and approve only the packages required by the installed Baileys dependency chain.

Copy `.env.example` to `.env`, then set `TELEGRAM_BOT_TOKEN`. Set `OWNER_TELEGRAM_IDS` to one or more comma-separated Telegram IDs to enable the admin media panel. A production deployment must also provide durable MongoDB and Redis services before enabling the corresponding persistence and queue modules.

```bash
cp .env.example .env
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Without a Telegram token, the service performs a safe startup smoke test and exits after creating the configured session and media directories. With a token, it starts Telegram long polling. The WhatsApp pairing UI and transport lifecycle are intentionally kept separate from cosmetic menu code.

## Admin media flow

In Telegram, an owner opens **Admin Media**, selects **Add Image** or **Add Video**, and uploads the matching file. The media is validated for type and size, stored beneath the workspace media directory, and catalogued by workspace. The resulting media can then be selected as the WhatsApp menu's image or video. If no media is selected, the menu falls back to the polished ASCII presentation.

Never commit `.env`, session credentials, uploaded media, or generated files. In production, replace the starter file-backed media/auth adapters with encrypted persistent storage or an object store while retaining the same workspace-scoped interfaces.

## Command examples

```text
.menu
.autojoin on
.autojoin off
.pfp
.setpfp       # quote an image when applying it
.setgpp       # quote an image in a group when applying it
.groups
.health
.setprefix !
```

The parser follows the configured session prefix and keeps quoted-message handling available for future media commands. Mass operations such as all-status, all-chat, tagging, link collection, and join jobs must be implemented through bounded, resumable queues rather than synchronous loops.

## Architecture contract

The attached master architecture remains the source of truth for multi-tenancy, explicit owner permissions, session recovery, queue behavior, preview centralization, destructive-action confirmation, and the requirement not to purge recoverable WhatsApp sessions after transient failures. The current repository is the clean implementation target: `pappy999666-dotcom/pappy-omega-mini`.

## V2 hardening now included

The V2 foundation adds structured error codes with correlation IDs, workspace-scoped audit events, centralized quota definitions, emergency safe-mode controls, AES-256-GCM encrypted auth-state values, a `doctor` command, and Docker/Compose deployment artifacts with persistent volumes. The production configuration requires `ENCRYPTION_SECRET` in addition to the Telegram token and owner IDs.

Run the quality gates with:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm doctor
```

The VPS deployment also verifies Telegram identity, Redis, MongoDB, storage permissions, encryption configuration, and PM2 health. Emergency controls are designed to pause mass sends, joins, broadcasts, scheduling, or new pairing without destroying healthy sessions.
