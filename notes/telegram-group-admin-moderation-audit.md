# Telegram Group Admin and Per-Group Moderation Audit

## Scope

PAPPY’s Telegram session Groups view now uses the WhatsApp session’s actual group participant metadata. It shows only groups where the logged-in WhatsApp identity is an administrator or owner. The full participating-group inventory remains available to broadcast and status engines and was not narrowed, so broadcast behavior is unchanged.

For panel-assigned sessions, the worker now returns `isAdmin` in `listGroupSummaries`. Identity matching handles phone JIDs, device-suffixed JIDs, phone-number fields, and available LID/JID variants. The control plane uses strict `isAdmin === true` filtering and performs a fresh administrator check before every per-group mutating action.

## Connected per-group actions

The PAPPY-styled moderation dashboard is connected to canonical transport helpers for:

- Join approval ON/OFF.
- Member-add mode: all members or administrators only.
- Chat mode: administrators only or everyone.
- Group-info mode: administrators only or everyone.
- Disappearing messages: off, 24 hours, 7 days, or 90 days.
- Promote one current member.
- Demote one removable administrator; the group owner is protected.
- Pending join requests: approve all, approve by amount, or approve by country calling code.
- Invite revocation with confirmation.
- Bulk removal of non-admin members with confirmation and a 500-member cap.
- Bulk blocking of non-admin members with confirmation and a 500-member cap.
- Bulk demotion of removable administrators with confirmation and a 500-member cap.

Country approval uses only phone numbers explicitly exposed by WhatsApp. LID-only requests are not guessed or incorrectly mapped to a country.

## Isolation and safety

Moderation input state is isolated from pairing, profile, group-name, group-description, and other Telegram workflows. Every mutating route re-fetches group metadata and requires current administrator status. Bulk actions require a second confirmation, operate in small sequential batches, protect the group owner and the session identity, and report completed versus failed operations. No WhatsApp test traffic was sent during the audit.

## Validation and release

The full suite passed: 17 test files and 170 tests. TypeScript compilation and production build passed. The panel worker was regenerated as release 1.2.70 and now publishes administrator metadata. Production health returned OK with package version 1.2.70. The control service was restarted with a timestamped backup; the external panel service was not restarted and remained active.
