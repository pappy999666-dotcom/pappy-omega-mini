#!/usr/bin/env bash
# ============================================================================
# PAPPY OMEGA-MINI — VPS update pipeline (GitHub -> VPS -> panel volume)
#
#   1. fetch origin/main and verify it exists
#   2. safety-stash any local tracked modifications (never silently destroyed)
#   3. move /opt working tree to origin/main (git reset --hard AFTER stashing)
#   4. install deps + typecheck + build INSIDE the pinned runtime image
#   5. rsync code + build artifacts into the panel container volume,
#      preserving ALL persistent/runtime data (.env, sessions, secrets, media)
#   6. restart the bot via the panel client API (docker restart fallback)
#   7. health-check /workload/health until green (or fail loudly)
#
# Usage:
#   vps-update.sh                    # full update + restart + verify
#   vps-update.sh --no-restart       # sync code, do not restart
#   vps-update.sh --restart-only     # just restart + health check
#   vps-update.sh --skip-if-unchanged  # exit early when HEAD == deployed stamp
#
# Rollback: git -C $ROOT checkout <old-tag-or-sha> && vps-update.sh
# ============================================================================
set -euo pipefail

ROOT="${PAPPY_ROOT:-/opt/pappy-omega-mini}"
VOL="${PAPPY_VOLUME:-/var/lib/pterodactyl/volumes/960b30b0-882e-406c-91bc-cc71a3f38d64}"
IMAGE="${PAPPY_IMAGE:-pappy-omega-mini:runtime}"
SERVER_UUID="${PAPPY_SERVER_UUID:-960b30b0-882e-406c-91bc-cc71a3f38d64}"
PANEL_HOST_PORT="${PAPPY_PANEL_HOST:-pappy-panel.duckdns.org}"
HEALTH_URL="${PAPPY_HEALTH_URL:-http://127.0.0.1:2518/workload/health}"
PANEL_TOKEN_FILE="${PAPPY_PANEL_TOKEN_FILE:-/root/.pappy-panel-api}"
STAMP_FILE="$VOL/.pappy-deploy-stamp"
LOG_TAG="pappy-update"

NO_RESTART=0; RESTART_ONLY=0; SKIP_IF_UNCHANGED=0
for arg in "$@"; do
  case "$arg" in
    --no-restart)       NO_RESTART=1 ;;
    --restart-only)     RESTART_ONLY=1 ;;
    --skip-if-unchanged) SKIP_IF_UNCHANGED=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[$(date '+%F %T')] $*"; }
fail() { echo "[$(date '+%F %T')] FAIL: $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
preflight() {
  [ -d "$ROOT/.git" ]     || fail "no git repo at $ROOT"
  [ -d "$VOL" ]           || fail "panel volume missing: $VOL"
  command -v git   >/dev/null || fail "git not found"
  command -v rsync >/dev/null || fail "rsync not found"
  command -v docker >/dev/null || fail "docker not found"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE not built"
}

panel_restart() {
  if [ ! -f "$PANEL_TOKEN_FILE" ]; then
    log "no panel token file $PANEL_TOKEN_FILE — falling back to docker restart"
    docker restart "$SERVER_UUID" >/dev/null
    return 0
  fi
  local token; token="$(tr -d '[:space:]' < "$PANEL_TOKEN_FILE")"
  log "restarting server $SERVER_UUID via panel API..."
  local code
  code="$(curl -sk -o /tmp/pappy-power.out -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -H "Host: $PANEL_HOST_PORT" -d '{"signal":"restart"}' \
    "https://127.0.0.1/api/client/servers/$SERVER_UUID/power" || echo curl-error)"
  if [ "$code" != "204" ] && [ "$code" != "200" ]; then
    log "panel API restart returned $code — falling back to docker restart"
    docker restart "$SERVER_UUID" >/dev/null
  else
    log "panel API accepted restart ($code)"
  fi
}

health_wait() {
  local deadline=$((SECONDS + 180)) code=000
  log "waiting for $HEALTH_URL to go healthy (up to 180s)..."
  while [ $SECONDS -lt $deadline ]; do
    code="$(curl -s -o /tmp/pappy-health.out -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)"
    if [ "$code" = "200" ]; then
      log "HEALTHY: $(head -c 300 /tmp/pappy-health.out)"
      return 0
    fi
    sleep 5
  done
  echo "--- last container log lines ---"
  docker logs --tail 40 "$SERVER_UUID" 2>&1 | tail -40 || true
  fail "health check never reached 200 (last code $code)"
}

post_restart_log_scan() {
  log "scanning fresh logs for errors..."
  docker logs --since 3m "$SERVER_UUID" 2>&1 \
    | grep -iE "unhandled rejection|uncaught exception|EADDRINUSE|409 conflict|FATAL" \
    && fail "error patterns found in fresh logs (see above)" \
    || log "log scan clean"
}

# ----------------------------------------------------------------------------
preflight

if [ "$RESTART_ONLY" = "1" ]; then
  panel_restart; health_wait; post_restart_log_scan
  log "restart-only complete."
  exit 0
fi

cd "$ROOT"

# -- step 1: fetch -----------------------------------------------------------
log "fetching origin..."
git fetch origin main
REMOTE_SHA="$(git rev-parse origin/main)"
log "origin/main = $REMOTE_SHA"

# -- step 2: safety-stash local tracked modifications ------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  STASH_MSG="vps-update auto-stash $(date '+%F %T') from $(git rev-parse --short HEAD)"
  git stash push -m "$STASH_MSG" || fail "could not stash local modifications"
  log "local modifications stashed ('$STASH_MSG') — inspect with: git -C $ROOT stash list"
fi

# -- step 3: move tree to origin/main ----------------------------------------
LOCAL_SHA="$(git rev-parse HEAD)"
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ] && [ "$SKIP_IF_UNCHANGED" = "1" ] \
   && [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$REMOTE_SHA" ]; then
  log "already at origin/main and volume stamp matches — nothing to do."
  exit 0
fi
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  log "updating tree: $LOCAL_SHA -> $REMOTE_SHA"
  git reset --hard "$REMOTE_SHA"   # safe: local mods were stashed above
else
  log "tree already at origin/main ($LOCAL_SHA)"
fi

# -- step 4: deps + typecheck + build inside the pinned image ----------------
log "installing dependencies + building inside $IMAGE (this mounts $ROOT)..."
docker run --rm --entrypoint /bin/bash -v "$ROOT:/app" -w /app "$IMAGE" -c '
  set -e
  pnpm install --frozen-lockfile >/tmp/pnpm-install.log 2>&1 || { tail -20 /tmp/pnpm-install.log; exit 1; }
  pnpm run typecheck >/tmp/tsc-check.log 2>&1 || { tail -20 /tmp/tsc-check.log; exit 1; }
  pnpm run build >/tmp/tsc-build.log 2>&1 || { tail -20 /tmp/tsc-build.log; exit 1; }
  echo build-ok
' || fail "deps/typecheck/build failed inside image — tree left at $REMOTE_SHA, NOT deployed"

# -- step 5: sync code + build artifacts into the panel volume ---------------
# Explicit code paths ONLY — persistent/runtime data (.env, storage/, data/,
# .secrets/, media, logs) is never touched. --delete applies per synced path.
OWNER="$(stat -c '%u:%g' "$VOL/package.json" 2>/dev/null || echo "$(stat -c '%u:%g' "$VOL")")"
log "syncing code into $VOL (owner $OWNER)..."
rsync -a --delete "$ROOT/package.json"       "$VOL/" || fail "rsync package.json"
rsync -a --delete "$ROOT/pnpm-lock.yaml"     "$VOL/" || fail "rsync lockfile"
rsync -a --delete "$ROOT/pnpm-workspace.yaml" "$VOL/" || fail "rsync workspace"
rsync -a --delete "$ROOT/tsconfig.json"      "$VOL/" || fail "rsync tsconfig"
rsync -a --delete "$ROOT/vitest.config.ts"   "$VOL/" || fail "rsync vitest config"
rsync -a --delete "$ROOT/.env.example"       "$VOL/" || fail "rsync env example"
rsync -a --delete "$ROOT/README.md"          "$VOL/" || fail "rsync README"
rsync -a --delete "$ROOT/src/"               "$VOL/src/" || fail "rsync src/"
rsync -a --delete "$ROOT/dist/"              "$VOL/dist/" || fail "rsync dist/"
rsync -a --delete "$ROOT/patches/"           "$VOL/patches/" || fail "rsync patches/"
rsync -a --delete "$ROOT/worker-package/"    "$VOL/worker-package/" || fail "rsync worker-package/"
rsync -a --delete "$ROOT/scripts/"           "$VOL/scripts/" || fail "rsync scripts/"
rsync -a --delete "$ROOT/tests/"             "$VOL/tests/" || fail "rsync tests/"
rsync -a --delete --exclude '.cache/' "$ROOT/node_modules/" "$VOL/node_modules/" || fail "rsync node_modules/"
chown -R "$OWNER" "$VOL/src" "$VOL/dist" "$VOL/node_modules" "$VOL/patches" \
  "$VOL/worker-package" "$VOL/scripts" "$VOL/tests" 2>/dev/null || true
printf '%s\n' "$REMOTE_SHA" > "$STAMP_FILE"
chown "$OWNER" "$STAMP_FILE" 2>/dev/null || true
log "volume synced; deployed stamp = $REMOTE_SHA"

# -- step 6: restart ----------------------------------------------------------
if [ "$NO_RESTART" = "1" ]; then
  log "--no-restart given: code synced but bot NOT restarted (applies on next restart)."
  exit 0
fi
panel_restart

# -- step 7: verify ------------------------------------------------------------
health_wait
post_restart_log_scan
log "UPDATE COMPLETE: VPS runs $REMOTE_SHA (= origin/main, tagged release)."
