# Pappy Omega Mini — Telegram Moderation UX Specification

## Interaction rule

Telegram moderation must use two deliberate interaction modes rather than exposing every operation as a command.

| Operation type | Interaction | Reason |
|---|---|---|
| Target-dependent member action | Slash command, normally by replying to the member’s message | Telegram reply context identifies the target reliably; examples are `/mute`, `/unmute`, `/warn`, `/ban`, and `/unban` |
| Group setting or protection toggle | Inline button with callback authorization | The moderator changes a group setting, so the UI should show current state and edit the same dashboard message |
| View, list, dashboard, rules display, logs | Inline button | These are navigation or read-only views and should not create extra chat messages |
| Destructive or broad action | Inline button followed by confirmation button | Examples include group mute, raid lockdown, reset warnings, and tag-all execution |
| Text or media configuration | Inline button opens a guided input state | Examples include editing rules, filter response text, welcome/goodbye templates, and media selection |

## Moderator entry point

`/moderation` remains the administrator-only slash entry point because it is discoverable through Telegram command suggestions. It should render one grouped dashboard and not print a long command list. The dashboard should show the real group title, bot permission status, protection state, active expiry, warning count, filter count, staff/whitelist counts, and recent action status.

Recommended dashboard rows:

| Row | Buttons |
|---|---|
| Protection | `Anti-link ON/OFF`, `Anti-spam ON/OFF` |
| Safety | `Quick Protect`, `Raid Guard`, `Group Lock` |
| Member tools | `Warnings`, `Staff`, `Whitelist`, `Filters` |
| Content | `Rules`, `Welcome`, `Goodbye` |
| Observability | `Live Logs`, `Refresh` |
| Navigation | `Back`, `Close` |

The labels must include the current state, such as `🔗 Anti-link: ON` and `🛡 Anti-spam: OFF`. A callback must re-check the caller’s administrator permission before changing anything.

## Same-message editing

Every dashboard navigation action must answer the callback query and edit the existing dashboard message. It must not send a second copy of the menu. A successful toggle should update the state label in place and use a short callback toast such as `Anti-link enabled`. A failed Telegram API call should keep the previous state, edit the dashboard with a concise failure state, and write a durable moderation event.

The implementation should reuse the project’s `edit`/`sendOrEdit` pattern, but moderator callbacks need a dedicated group-aware renderer and a group-aware authorization check. If Telegram cannot edit the original message, the fallback response should be a single concise replacement, not a second persistent menu plus a success message.

## Commands that remain slash commands

These require reply or target context and should not be replaced by ambiguous buttons:

```text
/mute                 Reply to a member; optional duration
/unmute               Reply to a member
/warn                 Reply to a member; optional reason
/ban                  Reply to a member
/unban                Reply to a member or provide a target ID
```

The dashboard may show a short usage hint, but it should not render one button per arbitrary member. For group-wide actions, use buttons with confirmation because they affect every member:

```text
Group Lock → Confirm Lock → same-message result
Tag All → Preview → Confirm Tag-All → progress view
Reset Warnings → choose target by reply/command → confirm if broad
```

## Settings that become buttons

The following should be inline toggles or grouped controls instead of requiring `/protection`, `/antilink`, or `/settings` for ordinary changes:

```text
Anti-link toggle
Anti-spam toggle
Quick Protect preset
Raid Guard toggle and threshold view
Group Lock / Unlock
Warning limit stepper
Default mute duration selector
Welcome enable/disable
Goodbye enable/disable
Filter list, add, remove
Whitelist list, add, remove
Staff list, add, remove
Rules view, edit, publish, cancel
Logs view and refresh
```

Text-entry operations should use a pending input state keyed by Telegram user, group, and dashboard message. The next text or media message is consumed only by that state, validated, persisted, and then returned to the same dashboard message where possible.

## Response cleanup

The bot should not leave a trail of redundant menus and confirmations. The rules are:

1. Callback presses use `answerCbQuery` for short feedback and edit the dashboard message.
2. Navigation views replace the current menu instead of replying with a new menu.
3. Successful toggles do not send a separate success message.
4. Failed actions show one concise failure state and retain the previous setting.
5. Guided input prompts may remain as one prompt message, then be edited into the result or removed after successful consumption.
6. Temporary confirmations and progress messages must be deleted or replaced when the operation completes, subject to Telegram API success.
7. Moderation logs remain durable and administrator-readable but are not dumped into the group after every action.
8. Automatic protection actions may notify once per detection window, with deduplication for anti-spam and raid events.

## Security requirements

Every callback must validate that the message belongs to a Telegram group, load the group record, and re-check administrator status. Staff and whitelist entries may be exempted from automatic enforcement but must not automatically gain access to configuration callbacks unless the policy explicitly grants that scope. Ordinary users must not be able to invoke callbacks by guessing callback data. Callback payloads should be short, opaque enough to avoid leaking sensitive state, and bound to the group/message context when a stateful flow is active.

## Acceptance examples

| Scenario | Expected result |
|---|---|
| Admin opens `/moderation` | One compact grouped dashboard appears |
| Admin taps Anti-link | Callback toast appears; same message changes `OFF` to `ON`; no duplicate menu is sent |
| Ordinary user taps a copied callback | Callback is rejected; no setting changes; no persistent moderator menu is sent |
| Admin taps Quick Protect | Bot checks required Telegram permissions, applies real settings, records result, and refreshes dashboard |
| Admin needs to mute a member | Admin replies to the member and uses `/mute 600`; target is unambiguous |
| Admin taps Group Lock | Confirmation appears in place; only confirmed action calls Telegram API |
| Admin edits rules | Button opens one guided input state; submitted text is validated, saved, and reflected in the dashboard |
| Admin opens logs | Same message changes to a concise paginated log view with Back/Refresh |
| Toggle API call fails | Setting remains unchanged; one concise failure state is shown and event records failure reason |
