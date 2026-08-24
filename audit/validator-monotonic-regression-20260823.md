# Validator Main/Active Non-Monotonic Regression — 2026-08-23

## Scope

This note records the read-only production investigation and the minimal control-plane correction for the Validator Hub requirement that canonical links progress from `MAIN` to `VALIDATING/PROCESSING` and then to `ACTIVE`, `DEAD`, or `ERROR`. No WhatsApp messages, broadcasts, group creation, joins, or destructive account actions were performed.

## Evidence before the fix

The live Redis source of truth contained 6,365 canonical records. A 15-second full-record fingerprint observed `MAIN 5968 → 5963`, `VALIDATING 0 → 5`, `ACTIVE 349 → 349`, `DEAD 48 → 48`, and `ERROR 0 → 0`. The fingerprint did not observe a specific Active URL move to Main during that interval, so an Active-to-Main event is not claimed as directly witnessed.

The chronological job probe did, however, show current `link-validation` batches ending `PARTIAL` with zero successes and errors including `growth-locked`, `bad-request`, `rate-overlimit`, and incomplete invite metadata. The pre-fix runtime automatically returned retryable validation failures, stale claims, enqueue failures, and several Join Manager outcomes to Main. This explains Main replenishment even when no confirmed Active record is being re-collected. The Redis record/index writer also performed the record write and bucket-index updates as separate commands, leaving a failure window in which the canonical record and indexes could disagree.

## Correction implemented

`src/links/link-bucket-store.ts` now writes the canonical record and bucket index updates through one Redis `MULTI/EXEC` transaction for both upsert and move. The generic move boundary rejects `ACTIVE → MAIN`.

`src/jobs/runtime.ts` now sends automatic retryable validation failures, rate-limit failures, stale validation claims, and enqueue failures to `ERROR` with `validationState: retryable-error` and `needsValidation: false`. Main is therefore intake-only during automatic processing; the existing explicit operator requeue action remains the route from Error back to Main.

Join Manager no longer recycles Active records into Main. An invalid invite is marked Dead. Retryable or rate-limited join outcomes remain Active with audit metadata; other permanent outcomes become Dead. The Validator Live explanatory text was updated to match these semantics.

Regression coverage was added for the canonical store boundary rejecting Active-to-Main and for transaction-capable deterministic Redis test doubles.

## Verification

The focused and full suites passed: 19 test files and 174 tests. TypeScript typecheck and production build passed. Redis connection-refused messages seen in local tests are expected because those unit tests run without a local Redis daemon; no test failed because of them.

The verified control dist was deployed with a timestamped remote backup. Only `pappy-omega-mini.service` was restarted. `pappy-panel-v3.service` remained active.

Post-deploy three-point read-only count watch:

| Time (UTC) | Main | Validating | Active | Dead | Error |
|---|---:|---:|---:|---:|---:|
| 06:17:53 | 5,849 | 7 | 352 | 48 | 109 |
| 06:18:03 | 5,839 | 2 | 353 | 48 | 123 |
| 06:18:13 | 5,824 | 4 | 354 | 48 | 135 |

The post-deploy full-record watch reported `activeToMain: []`. It observed only forward validation transitions and automatic failures into Error. Main reduced by 25 during the three-point watch, Active increased by 2, and Error rose as expected because retryable failures are no longer replenishing Main.

Post-deploy health was successful: control endpoint returned `ok: true`, `controlVersion: 1`, `heartbeatIntervalMs: 20000`, and package version `1.2.72`; both control and panel services were active. No temporary production probe file remained.

## Remaining limitations

This proves the corrected Redis behavior over the bounded live watch; it does not complete the larger Validator rebuild. Mongo durable state remains disabled as the source of truth, Redis dual-write is not enabled, durable migration/parity is outstanding, and the longer stress/fault-injection gates remain separate work. The dashboard counts are still Redis bucket counts, not proof that every session can freshly validate a new link.
