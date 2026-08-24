# PAPPY OMEGA MINI Preview Fix — Release 1.2.54

## Root cause confirmed

The live Redis records for the distinct invite URLs `KbDjI6Amhs38wh2nRz4pkN` and `BnoEtMaigLaGeq05113OhM` had different cache keys but identical metadata and thumbnail. Both records described the execution group. The records were created by the earlier destination-group metadata implementation and remained readable because the preview namespace was still `v8`.

## Code changes

- Bumped the native preview namespace from `v8` to `v9`.
- Purged only `pappy-omega-mini:preview:v8:*` keys on the VPS; 26 stale keys were removed.
- Added cache provenance validation: a cached record is rejected and deleted if its `canonicalUrl` does not equal the requested canonical URL.
- Added local-cache provenance validation.
- Added pre-existing-preview validation: a complete preview is reused only when its canonical or matched URL is the same as the outgoing text URL.
- Added same-scope sequential and concurrent source/destination regression tests.
- Added a localhost-only, encryption-secret-gated, non-sending diagnostic route for live invite lookup and redacted preview evidence.

## Live verification

The control plane was deployed as `1.2.54`. `/workload/health` returned `packageVersion: 1.2.54`; `pappy-omega-mini.service` remained active; the owner session `Pappyshe` returned to `ACTIVE` with `authHealth: VALID` after restart; and no v8 preview keys remained.

The live diagnostic exercised the actual control-process socket for both URLs. `BnoEtMaigLaGeq05113OhM` resolved to `120363429710580264@g.us`, subject `♡₊˚ KAWAII HAVEN ˚₊♡`, size 2. `KbDjI6Amhs38wh2nRz4pkN` was passed to Baileys under the exact source code and returned `not-authorized`; the public WhatsApp metadata request also returned HTTP 429 with an empty body. Therefore the source URL now remains the source URL in the outbound preview payload, but this particular invite cannot currently supply native source title/profile metadata and correctly falls back to the generic invite card rather than borrowing the destination group.

The live output showed, for both sequential and concurrent runs:

- `matched-text` equals the input URL.
- `canonical-url` equals the input URL.
- KbDj does not receive BnoEt title or thumbnail data.
- BnoEt retains its own title and thumbnail digest.

## Validation gates

`pnpm typecheck`, `pnpm build`, worker generation, worker syntax validation, and the full suite passed: **144 tests across 15 files**. The sandbox-only Redis connection-refused warnings remain expected because the sandbox has no local Redis; the VPS Redis was reachable during deployment.

## Honest remaining limitation

To obtain a native KbDj title and thumbnail, the source invite itself must be valid and accessible to the active WhatsApp account or its public metadata endpoint must stop returning 429. The deployed code will not use the execution group as a substitute. A known-valid source invite can now be tested without risking the former cross-URL cache contamination.
