# Pappy Omega Mini — Join and Live Operations Audit Findings

## Omega-v1 behavioral reference

Omega-v1’s Join Manager uses a durable job/config contract with `targetCount`, `batchCycles`, `minDelayMs`, `maxDelayMs`, `maxRetries`, `retryBaseMs`, `sessionCooldownMs`, `restrictionThreshold`, and selected session IDs. Its low-level join operation first checks current membership, resolves invite metadata, calls the Baileys invite acceptance method once, and returns structured `success`, `jid`, `title`, `alreadyMember`, `requestRequired`, and `error` outcomes. Approval-required outcomes are tracked as pending/skipped rather than treated as hard failures. Revoked/expired/not-found links are retired from Active into an error/dead workflow. Rate limits release the claim, increment the rate-limit counter, exclude the session for a cooldown, and allow bounded retry. The Join Manager UI displays authoritative connected-group count, target, cursor/total, joined, skipped, failed, rate limits, current link, and live logs.

## Installed Baileys behavior

The installed `@crysnovax/baileys` fork exposes `groupAcceptInvite(code)`, `groupGetInviteInfo(code)`, and `groupFetchAllParticipating()`. `groupAcceptInvite` returns a group JID or undefined. Its group methods also include linked-group approval behavior, but there is no generic public invite-link request method; approval-required behavior is surfaced through transport errors/results and must be recorded as pending rather than simulated.

The installed Baileys profile-picture implementation supports `updateProfilePicture(jid, Buffer, { hd: true })`. The original bytes should be passed directly; URL-only updates and bot-side image cropping do not satisfy the desired HD behavior.

## Pappy Omega Mini gaps found

The previous Join Manager worker only listed a bounded Active slice, called `groupAcceptInvite` directly without invite metadata or membership checks, applied delay after joining rather than between attempts, did not expose request/already-member/dead-link counters, and moved invalid links into Dead instead of returning dead links to Main as requested. Its Telegram UI had target/delay/batch/retry/concurrency controls but no explicit automatic/immediate/request mode. Auto-join was toggled in session settings but did not enqueue a real Join Manager job when a newly validated link became Active.

The previous job records had only long UUIDs and no short live code. Telegram had no general Live Show lookup for a code, and pairing results had no native copy-text button. Broadcast workers used one-at-a-time delivery but did not report current target/action/last result in the durable progress record.

## Implemented in this audit so far

Added `src/jobs/join-operation.ts` with Baileys-backed invite normalization, membership check, invite-info resolution, immediate join, approval-required classification, and structured result handling. Reworked the Join Manager worker to use it, pace attempts with a minimum delay, expose joined/requested/already-member/dead/rate-limit/current-link/current-action/last-result progress, return invalid/dead invites to Main for re-validation, and stop after five rate-limit hits. Added durable `defaultJoinMode` settings and Telegram controls for AUTO, IMMEDIATE, and REQUEST modes. Added Auto-join enqueueing from successful validation for the originating session with idempotency.

Added short job codes to JobRecord creation with Redis code lookup, a Telegram Live Show renderer and copy button, a main-dashboard Live Show entry, code prompt/lookup callbacks, and pairing-code copy button. Broadcast workers now pace posts and report current group/action/last result with soft per-group failures. Validator Master results now expose code/copy/Live Show controls.

## Remaining implementation work

Finish purge semantics so deleting a session removes its auth, durable session record, session-owned jobs/idempotency/code keys, and source-session link records without touching sibling sessions. Add targeted tests for Join Operation classification, five-rate-limit stopping, short-code lookup, and purge isolation. Compile, run the full test suite, build, deploy to the VPS, and verify PM2 isolation and fresh logs.
