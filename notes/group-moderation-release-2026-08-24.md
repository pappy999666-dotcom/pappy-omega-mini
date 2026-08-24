# OMEGA-MINI WhatsApp Group Moderation Release

**Release scope:** remaining non-welcome Omega-V1-style WhatsApp group moderation controls. Welcome, goodbye, template automation, and automatic join/leave greeting flows are intentionally excluded from this release.

## Implemented command matrix

| Command | Behavior | Safety and scope |
|---|---|---|
| `kick` / `remove` | Reviews removal of one verified group member. | Group-only; fresh admin check; real phone, real mention, or verified quoted sender; native Confirm/Cancel; one durable participant job. |
| `promote` | Reviews promotion of one verified regular member. | Fresh group state; native confirmation; already-admin and unresolved targets rejected. |
| `demote` | Reviews demotion of one verified administrator. | Fresh group state; native confirmation; non-admin and unresolved targets rejected. |
| `dnkick` | Sequentially demotes, then removes one administrator. | Native confirmation; durable `demote-remove` action; removal is not attempted if demotion fails. |
| `block` | Reviews removal plus WhatsApp block of one verified regular member. | Native confirmation; admins protected; block is executed by the durable group-control worker. |
| `unblock` | Removes a WhatsApp block from a verified phone identity. | Group-admin authorization and verified identity required; no raw LID output. |
| `ban` | Adds a local group restriction without removing the member. | Native confirmation; durable workspace/session/group state; future inbound messages from the verified phone are deleted best-effort. |
| `unban` / `banlist` / `bans` | Removes or displays local restrictions. | Scoped to workspace + session + group; displayed identities are masked. |
| `warn` | Adds a durable manual warning. | Admins and unresolved identities are protected; quoted offending message is deleted when its verified key is available. |
| `unwarn` / `resetwarn` / `warns` | Resets or displays a durable warning count. | Group-only; verified target required. |
| `mute` / `unmute` | Switches the current group between administrators-only and all-member chat mode. | Native confirmation; fresh administrator recheck; uses the existing group-setting transport. |
| `deleteall` | Deletes recent messages attributed to one verified member. | Native confirmation; bounded to the recent in-memory tracker and a maximum of 200 messages; never claims historical deletion. |
| `poll` | Creates a native WhatsApp poll. | Group-only; quoted payload supported; question and options are bounded. |
| `filter` | Read-only count of verified members matching a country prefix. | No membership changes. |
| `filterout` | Reviews removal of up to 1,000 verified non-admin members matching a country prefix. | Native Confirm/Cancel; one durable bounded participant job; administrators, self, and unresolved identities excluded. |
| `blockall` | Reviews blocking of up to 1,000 verified non-admin members. | Native Confirm/Cancel; one durable bounded participant job; no automatic execution from the preview. |

## Identity and interaction guarantees

All moderation target resolution now accepts only a verified real phone identity, a real phone mention resolved by Baileys, or a quoted sender that resolves to a verified phone. Unresolved LIDs are rejected and are not rendered in tables, confirmations, management responses, or ban lists. Confirmation tokens remain bound to the workspace, session, group, and requesting sender, expire after 90 seconds, and are revalidated against fresh administrator and participant state before execution.

Bulk actions use one bounded durable `group-control` job and report progress through the existing worker path. Native callback IDs are the only prefix-independent moderation interaction path. Ordinary direct WhatsApp commands continue to require the configured prefix; Telegram Bridge behavior remains separate.

## Warning and deletion behavior

The warning threshold is three. The third warning produces a native confirmation rather than silently removing anyone. On confirmation, the exact quoted message key is deleted when available, the verified regular member is removed, and the durable warning count is reset. `deleteall` uses a bounded tracker containing only recent inbound messages with verified sender attribution; it does not pretend to delete messages that were never tracked.

## Validation and deployment evidence

The TypeScript build passed. The final deterministic suite passed **27 test files and 232 tests**. The expected local Redis connection-refused diagnostics appeared in tests that intentionally run without Redis; the suite remained fully green.

The control-only atomic deployment completed successfully. Remote validation reported:

| Check | Result |
|---|---|
| Control service | Active |
| Panel service | Active and not restarted |
| Workload health endpoint | `ok` |
| Moderation markers | Present |
| Worker package hash | Match |
| Temporary probe marker | Absent |
| Remote rollback | Not invoked |
| Live destructive moderation test | Not run |

The live WhatsApp account/session was not used to ban, kick, block, delete, demote, or otherwise perform a destructive moderation test. Production still has the previously documented operational risk around intermittent Baileys 401/decryption storms and ACTIVE-versus-DEGRADED lifecycle reporting; this release did not purge or re-pair any session.

## Explicitly excluded

This release does **not** register or implement `welcome`, `goodbye`, `setwelcome`, `welcomemsg`, `setgoodbye`, `goodbyemsg`, welcome toggles, goodbye toggles, or automatic welcome/goodbye event flows. Those remain reserved for a separate task.
