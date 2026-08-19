# Sharpening Injection Artifact Findings

Tested source: WhatsApp group preview JPEG, `443 x 720`, `33,447` bytes.

The injected default group profile is sigma `0.55`, m1 `0.4`, m2 `1.1`, matching the existing group path. Its output remained `443 x 720`; no enlargement or crop occurred. The stronger profile used sigma `0.70`, m1 `0.45`, m2 `1.15`; the aggressive profile used sigma `0.95`, m1 `0.70`, m2 `1.50`.

Measured output:

| Variant | Bytes | Gradient mean | Laplacian variance |
|---|---:|---:|---:|
| Current/injected default | 56,085 | 11.2878 | 444.6968 |
| Stronger profile | 57,725 | 11.9857 | 565.0863 |
| Aggressive profile | 63,194 | 13.8577 | 803.4350 |

Visual inspection of the contact sheet and zoomed hair/face crop found no obvious bright halos, ringing, or clipped contours in the current/injected default. The stronger profile increases edge contrast modestly but does not recover source detail. The aggressive profile increases high-frequency contrast substantially and risks making hair strands and facial boundaries look brittle; it is not recommended.

The local injected source currently uses environment-controlled defaults and has not been deployed. Full local regression remains passing after the injection: strict TypeScript compilation passed and 74/74 tests passed. The test run emitted the known sandbox-local Redis connection-refused warnings.
