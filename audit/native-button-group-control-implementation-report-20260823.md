# Native Button and Group-Control Implementation Report

**Date:** 23 August 2026  
**Project:** OMEGA‑MINI WhatsApp/Baileys control plane  
**Status:** Implemented and locally verified; production rollout blocked by SSH authorization

## Executive result

OMEGA‑MINI now has a source-grounded native interaction path for WhatsApp group controls. The implementation recognizes the Baileys native-flow response format, double-encoded `paramsJson`, native list selections, legacy buttons, and hydrated-template buttons. Exact Confirm and Cancel actions are routed through the existing WhatsApp command context instead of being interpreted as ordinary user text.

The destructive group-management flow has been changed from immediate execution to a two-step plan. Bulk approval, rejection, and protected member-removal commands first resolve a fresh group-admin-authorized selection and return a native interactive table with Confirm and Cancel controls. No durable job is queued at preview time. A confirmation is single-use, expires after 90 seconds, and is bound to the workspace, session, WhatsApp group, and requesting sender. Confirmation performs another group-admin check and, for approval/rejection, intersects the stored selection with the current pending-request list before queueing one bounded batch job.

## Control behavior

| Input or action | Result | Destructive job queued? |
|---|---|---:|
| `.approveall` | Displays selected pending requests and native Confirm/Cancel controls | No |
| `.rejectall` | Displays selected pending requests and native Confirm/Cancel controls | No |
| `.approveamt <amount>` / `.rejectamt <amount>` | Displays the bounded selection for confirmation | No |
| `.approvecountry <country> <amount|all>` / `.rejectcountry <country> <amount|all>` | Displays verified country-matched requests for confirmation | No |
| `.kickall`, `.kickamt`, `.kickcountry` | Displays protected non-admin selection for confirmation | No |
| `.approve`, `.reject`, or ambiguous `.reject all` | Returns usage guidance only | No |
| Native Confirm | Revalidates scope and queues exactly one existing durable batch job | Yes, only after confirmation |
| Native Cancel, expired token, wrong sender, wrong group, or wrong session | Refuses or cancels the action | No |

The existing one-batch worker behavior remains in place. The implementation does not add live kick, reject, block, delete, or approval activity.

## Native interaction and panel flow

Mini’s inbound extractor now handles `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`, including clients that encode JSON twice. It also handles `listResponseMessage.singleSelectReply.selectedRowId`, `buttonsResponseMessage.selectedButtonId`, and `templateButtonReplyMessage.selectedId`. Wrapper messages are unwrapped before parsing.

Local sessions pass the sanitized interaction ID through the existing WhatsApp router. Only exact `group-control:confirm:<token>` and `group-control:cancel:<token>` IDs bypass the normal direct WhatsApp prefix gate. Prefixless ordinary WhatsApp text remains ignored. Anti enforcement is not run on interaction messages.

Panel workers now extract and forward only the sanitized interaction ID. The workload event schema accepts it, and native confirmation tables are sent through the installed Baileys `sendInteractiveTable` API when available. Older runtimes fall back to the existing text/native-flow path. No raw message object or private key material is added to the workload event.

## Pending-request identity correction

Join-request records are now enriched with verified phone digits from an explicit phone number, a direct PN JID, or the Baileys signal-repository LID mapping. An unresolved LID-only identity remains country-unknown and is not guessed. This corrects misleading country counts such as a verified `+234` request being omitted solely because the runtime exposed the request through a PN JID without a separate `phoneNumber` field.

The pending-request view now includes a native table containing the current request rows, identity value, and country classification. Bulk confirmation displays masked identity labels while preserving the authoritative JIDs internally for the single durable batch job.

## Verification evidence

The following local checks passed:

| Check | Result |
|---|---:|
| TypeScript build | Passed |
| Worker-runtime JavaScript syntax check | Passed |
| Native interaction parser fixtures | Passed |
| Router-level native Confirm prefix-bypass test | Passed |
| Join Approval and group-control tests | 13 passed |
| Anti System tests | 10 passed |
| Menu/media regression tests | 23 passed |
| Complete repository suite | **26 files, 216 tests passed** |

The test process emitted expected local Redis connection-refused warnings because no local Redis instance is running in the sandbox. These warnings did not cause test failures.

## Production deployment status

The restored PEM parses successfully as a 2048-bit private key, but the production VPS rejected its public key for both tested SSH account names in public-key-only batch mode. No password was entered, no fallback credential was used, no production artifact was swapped, and no production service was restarted during this change.

The required next deployment step is to authorize the matching public key for the intended deployment account or provide the correct deployment key. Once SSH authorization is corrected, the already-tested control artifact can be deployed with the existing backup-and-swap procedure. The panel service must remain untouched unless a separately approved panel deployment is required; the worker source change is present locally and must be included in the appropriate panel/index release path.

## Safety boundary

No live destructive Anti System test, Join Approval rejection, Kick All, member removal, block, or message deletion was performed. The previous approval for a specific Join Approval test does not authorize these new actions. A controlled test group and explicit action scope are still required before enabling or exercising any destructive group-management operation in production.

## Final deployment attempt with restored credential

The supplied VPS credential was accepted and the host was reachable. Read-only preflight showed the control service and panel service active with a healthy workload endpoint. Several control-only deployment attempts were then made with backups and automatic rollback safeguards. They did not complete: the service’s `Restart=always` policy exposed a transient release-path failure during replacement, and the control process repeatedly reported a missing compiled entrypoint while the release tree was being changed. The release was restored to the previous healthy artifact, temporary staging files were removed, and the panel service was never restarted or modified.

Final production state: control active, panel active, workload health `ok`, live native-button marker absent because the new release was not committed. The native-button implementation remains fully built and locally verified, but it must not be described as live until a deployment procedure that respects the service’s restart policy is separately validated.

## Identity privacy hardening update

A centralized identity normalizer now accepts only 7–15 digit phone identities, normal international phone formatting, or verified PN JIDs. Inbound quoted senders and mentioned users are resolved through the Baileys LID mapping only when a real PN is returned; unresolved LIDs are dropped. WhatsApp Join Approval, member controls, `.setsudo`, Anti permits, Telegram moderation targeting, country filters, previews, and acknowledgements no longer use raw LID/JID values as user-facing identities or accepted targets. Pending tables use masked phone labels and a neutral `Verified phone unavailable` label when no verified phone exists.

The complete suite after this update passed **26 files / 217 tests**, including build verification and new unresolved-LID rejection/display coverage.

The restored VPS credential was accepted, but control-only deployment attempts were rolled back safely because the production service’s automatic restart behavior repeatedly encountered a transient compiled-entrypoint condition during release replacement. The final production control and panel services are healthy on the previous release; the new identity hardening is not yet live. No destructive WhatsApp operation was executed.

## Successful live rollout

The frozen release was subsequently deployed using a runtime systemd mask and stop-before-copy procedure, preventing the `Restart=always` race from observing a missing entrypoint. The control service was stopped while masked, the backed-up release was preserved, the new files were installed into the existing release path, and the service was unmasked and started. The panel service was not restarted.

Read-only post-deployment verification confirmed that the local and remote SHA-256 hashes matched for the control entrypoint, command registry, session manager, and generated worker package. The control service is active, the panel service is active, the workload health endpoint reports `ok`, the native group-control interaction marker is present, native table sending is present, panel interaction forwarding is present, temporary probe code is absent, and staging files are clean. No live destructive WhatsApp group action was performed.
