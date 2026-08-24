# Native Button and Group-Control Audit

## Confirmed Omega‑V1 contract

Omega‑V1 serializes native interactive controls as `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`. The JSON contains an action `id` and a human-readable `display_text`; some clients double-encode the JSON and the parser handles both forms. Native list rows use `listResponseMessage.singleSelectReply.selectedRowId`. Legacy button clients use `buttonsResponseMessage.selectedButtonId`, and hydrated-template clients use `templateButtonReplyMessage.selectedId`.

The Omega‑V1 interaction router deep-unwraps future-proof wrappers, parses all four response forms, routes every interaction before Anti checks, and applies identity-scoped handling. The scope is session + chat + sender. Bulk confirmations are mapped to one central confirmation consumer, so Confirm and Cancel use the same expiry, authorization, pending-plan, and group checks as typed confirmations. Unknown or unmatched interactions fall through without being treated as ordinary commands.

Omega‑V1’s native rich helper confirms that a native table is a `richResponseMessage` table primitive, while an interactive selection is a `single_select` native-flow button with `buttonParamsJson`. The first table row is the header. Legacy button fallback is used where native-flow decryption is unreliable.

## Current Mini findings

OMEGA‑MINI can attach a `nativeFlow` array to outbound content, but its inbound extractor currently recognizes only conversation text, extended text, and media captions. It does not extract native-flow response IDs, list row IDs, legacy button IDs, or template button IDs. The session manager therefore passes no structured interaction to a central listener, and a tapped native control cannot reliably execute a Mini action.

Mini’s panel worker contract forwards normalized text, quoted text, quoted sender, mentions, media, and `fromMe`, but not raw interactive response objects or full message keys. Outbound content fields are preserved by the generic materializer, so outbound native buttons can likely travel to panel workers; inbound panel taps require an explicit worker-contract extension before they can be fully supported there.

The current Mini group-control commands have two unsafe behaviors. `approveall` has the alias `approve`, and `rejectall` has the alias `reject`, so short or accidentally spaced input can directly queue bulk operations. The approval/rejection commands also execute immediately rather than presenting a native Confirm/Cancel prompt. Kick commands already have a text-only preview/confirm pattern but do not yet use the native interaction contract.

`approvalCountry()` currently uses only `request.phoneNumber`. A join request carrying a JID/LID-derived identity but no phoneNumber is therefore excluded, which explains the inaccurate country count. Omega‑V1 resolves identity using the authoritative request/JID fields and explicitly avoids guessing a country when only an unresolved LID is available.

## Safe redesign boundary

Exact bulk commands must first resolve a fresh, admin-authorized plan, display a native table/summary, and register a scoped pending confirmation keyed by workspace/session/group/sender with a short expiry. Confirm and Cancel must be exact interaction IDs and must not be inferred from arbitrary ordinary text. Ambiguous text such as a bare `reject`, `reject all`, or an invalid extra-space form must return usage guidance and never enqueue a job.

A pending join request is country-matchable only when a verified phone-number identity is available. The system must normalize phoneNumber, PN JID, and resolvable LID mappings; unresolved LID-only records must remain explicitly excluded rather than assigned a guessed country. All bulk approval/rejection remains one durable batch job after confirmation.

## Implemented and verified locally

Mini now extracts native-flow `paramsJson` (including double-encoded JSON), list `selectedRowId`, legacy `selectedButtonId`, and template `selectedId` from wrapped inbound messages. Exact `group-control:confirm:<token>` and `group-control:cancel:<token>` IDs bypass only the ordinary WhatsApp prefix gate and are routed through the existing owner/group-admin and durable worker context. Ordinary prefixless WhatsApp text remains ignored.

Bulk approval, rejection, and member-removal controls now create a scoped 90-second plan and return a native interactive table with Confirm and Cancel buttons. Bare `.approve`, `.reject`, and ambiguous `.reject all` are non-destructive usage guidance. Confirmation consumes a token once, binds it to workspace/session/group/sender, and revalidates pending requests or group context before queueing one batch job. Pending request country matching accepts a verified phone number or direct PN JID; unresolved LID-only identities remain country-unknown.

Panel workers now extract and forward only the sanitized interaction ID. The control-plane workload schema accepts it, and panel outbound `nativeTable` replies use the installed Baileys `sendInteractiveTable` helper when available, falling back to the existing native-flow/text reply path. Local build, worker syntax check, Anti tests, menu/media tests, and Join Approval/native-interaction tests passed. No production deployment or live destructive action was performed in this change set.
