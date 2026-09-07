# Deployment & Update Pipeline

Production pipeline: **GitHub → VPS test deployment → verification → panel production**.
GitHub (`main`) is the single source of truth for application code. Secrets, sessions,
databases and persistent runtime data **never** enter the repository.

## Layout on the VPS

| Path | Role |
| --- | --- |
| `/opt/pappy-omega-mini` | canonical git checkout + build workspace (repo `pappy999666-dotcom/pappy-omega-mini`) |
| `/var/lib/pterodactyl/volumes/960b30b0-882e-406c-91bc-cc71a3f38d64` | live panel server volume (`/home/container` inside the container) — code synced here, runtime data lives here |
| `pappy-omega-mini:runtime` | pinned Docker image (node:22 + pnpm + ffmpeg/yt-dlp, built from `/root/pappy-panel-image/Dockerfile`) |
| `/root/.pappy-panel-api` | panel client API token (chmod 600, never in git) |

Persistent state that must never be synced over: `.env`, `storage/` (sessions),
`data/` (media), `.secrets/`, Redis, MongoDB (host services, reached via docker
bridge gateway `172.18.0.1`).

## Daily update flow

```
developer: git commit && git push        # code + tests, no secrets
VPS:       /opt/pappy-omega-mini/scripts/vps-update.sh
           → fetch origin/main
           → auto-stash any local drift (never destroyed)
           → reset tree to origin/main
           → pnpm install --frozen-lockfile + typecheck + build (inside pinned image)
           → rsync code/dist/node_modules into the panel volume
             (persistent data untouched, ownership preserved)
           → write .pappy-deploy-stamp
           → restart bot via panel API (docker restart fallback)
           → wait for /workload/health 200 + fresh-log error scan
```

Verify anytime (read-only): `scripts/vps-verify.sh` — container state, health
endpoints, Redis/MongoDB reachability from the container, log scan, deployed
revision vs git HEAD, resource snapshot.

### Flags

- `vps-update.sh --no-restart` — sync code only; applies at next restart.
- `vps-update.sh --restart-only` — restart + health check without syncing.
- `vps-update.sh --skip-if-unchanged` — no-op when HEAD matches the deployed stamp.

## Test gate before panel/user rollout

1. `scripts/vps-verify.sh` passes.
2. Test suite green on the VPS: `docker run --rm --entrypoint /bin/bash -v /opt/pappy-omega-mini:/app -w /app pappy-omega-mini:runtime -c "pnpm test"` (known-flaky: 2 preview-manager load tests in parallel runs pass in isolation).
3. Live checks: Telegram polling, WhatsApp session recovery line in logs, broadcast queue resumed, media/preview rendering.

## Panel deployment for new users

New panel servers are created from the same building blocks the VPS test server
uses, so they cannot drift from the tested version:

1. Panel egg **"PAPPY OMEGA-MINI"** (egg id 20) + image `pappy-omega-mini:runtime`.
2. Upload/clone the same GitHub revision into the server volume (or run
   `vps-update.sh` against that server's volume + UUID — script parameters are
   environment-overridable: `PAPPY_VOLUME`, `PAPPY_SERVER_UUID`).
3. Set per-server variables (MONGO/REDIS URIs at `172.18.0.1`, `BROADCAST_CONCURRENCY`,
   Telegram token) via panel server variables — never in the repo.
4. STARTUP (already baked into the egg): installs deps if missing, builds if
   `dist` missing, then `node dist/src/index.js`.

## Rollback

```
git -C /opt/pappy-omega-mini checkout release-20260907-panel-cutover   # or any tag/sha
/opt/pappy-omega-mini/scripts/vps-update.sh
```

Runtime data is never touched by updates, so rollback only swaps code.

## Future (optional)

- A cron entry or small webhook listener can run `vps-update.sh --skip-if-unchanged`
  periodically for push-to-deploy; manual run remains the default for a test-gated flow.
- GitHub Actions CI running `pnpm test` + `tsc --noEmit` on every push would make
  the gate automatic before the VPS ever pulls.
