#!/usr/bin/env bash
# ============================================================================
# PAPPY OMEGA-MINI — VPS health verification (read-only, safe to run anytime)
# Checks: container state, workload health endpoints, fresh-log errors,
#         Redis + MongoDB reachability from inside the container,
#         deployed revision stamp vs git HEAD.
# ============================================================================
set -uo pipefail

ROOT="${PAPPY_ROOT:-/opt/pappy-omega-mini}"
VOL="${PAPPY_VOLUME:-/var/lib/pterodactyl/volumes/960b30b0-882e-406c-91bc-cc71a3f38d64}"
SERVER_UUID="${PAPPY_SERVER_UUID:-960b30b0-882e-406c-91bc-cc71a3f38d64}"
HEALTH_URL="${PAPPY_HEALTH_URL:-http://127.0.0.1:2518/workload/health}"
HEALTH_DETAILED_URL="${PAPPY_HEALTH_DETAILED_URL:-http://127.0.0.1:2518/workload/health/detailed}"

failures=0
log()  { echo "[$(date '+%F %T')] $*"; }
bad()  { echo "[$(date '+%F %T')] FAIL: $*"; failures=$((failures+1)); }

# 1. container state
state="$(docker inspect -f '{{.State.Status}} restartCount={{.RestartCount}}' "$SERVER_UUID" 2>/dev/null || echo missing)"
case "$state" in
  running*) log "container: $state" ;;
  *) bad "container state is '$state' (expected running)" ;;
esac

# 2. workload health (basic + detailed)
code="$(curl -s -o /tmp/pappy-verify-health.out -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)"
if [ "$code" = "200" ]; then
  log "health: 200 $(head -c 200 /tmp/pappy-verify-health.out)"
else
  bad "health endpoint returned $code"
fi
code="$(curl -s -o /tmp/pappy-verify-detail.out -w '%{http_code}' --max-time 5 "$HEALTH_DETAILED_URL" || echo 000)"
if [ "$code" = "200" ]; then
  log "health/detailed: 200 $(head -c 400 /tmp/pappy-verify-detail.out)"
else
  log "health/detailed: $code (informational)"
fi

# 3. fresh-log error scan (last 5 minutes)
if docker logs --since 5m "$SERVER_UUID" 2>&1 | grep -qiE "unhandled rejection|uncaught exception|EADDRINUSE|FATAL"; then
  bad "error patterns in last-5m logs"
  docker logs --since 5m "$SERVER_UUID" 2>&1 | grep -iE "unhandled rejection|uncaught exception|EADDRINUSE|FATAL" | tail -10
else
  log "logs: no fatal patterns in last 5m"
fi

# 4. Redis + MongoDB reachable from inside the container
docker exec "$SERVER_UUID" node -e '
  const net = require("net");
  const gw = process.env.REDIS_HOST || "172.18.0.1";
  const s = net.connect({host: gw, port: 6379, timeout: 4000}, () => { console.log("redis-reachable"); process.exit(0); });
  s.on("error", () => { console.log("redis-unreachable"); process.exit(1); });
  s.on("timeout", () => { console.log("redis-unreachable"); process.exit(1); });
' >/tmp/pappy-verify-redis.out 2>&1 && log "redis: $(cat /tmp/pappy-verify-redis.out)" || { bad "redis unreachable from container ($(cat /tmp/pappy-verify-redis.out 2>/dev/null))"; }

docker exec "$SERVER_UUID" node -e '
  const net = require("net");
  const gw = process.env.MONGO_HOST || "172.18.0.1";
  const s = net.connect({host: gw, port: 27017, timeout: 4000}, () => { console.log("mongo-reachable"); process.exit(0); });
  s.on("error", () => { console.log("mongo-unreachable"); process.exit(1); });
  s.on("timeout", () => { console.log("mongo-unreachable"); process.exit(1); });
' >/tmp/pappy-verify-mongo.out 2>&1 && log "mongo: $(cat /tmp/pappy-verify-mongo.out)" || { bad "mongo unreachable from container ($(cat /tmp/pappy-verify-mongo.out 2>/dev/null))"; }

# 5. deployed stamp vs git HEAD
stamp="$(cat "$VOL/.pappy-deploy-stamp" 2>/dev/null || echo none)"
head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$stamp" = "$head" ]; then
  log "revision: volume stamp matches git HEAD ($head)"
else
  bad "revision drift: volume stamp=$stamp git HEAD=$head"
fi

# 6. resource snapshot
docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}}' "$SERVER_UUID" 2>/dev/null || true

if [ "$failures" -gt 0 ]; then
  echo "VERIFY RESULT: $failures check(s) FAILED"; exit 1
fi
echo "VERIFY RESULT: all checks passed"
