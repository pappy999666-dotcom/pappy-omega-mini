#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?host required}"
LABEL="omega-group-moderation-$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="/tmp/${LABEL}.tar.gz"
ROOT="/opt/pappy-omega-mini"

cd "$(dirname "$0")/.."
npm run build >/tmp/omega-group-moderation-build.log
node tools/build-single-file-worker.mjs >/tmp/omega-group-moderation-worker.log
grep -q 'group-control:confirm' dist/src/whatsapp/command-registry.js
grep -q 'demote-remove' dist/src/jobs/runtime.js
grep -q 'moderation-groups' dist/src/whatsapp/group-moderation-state.js
grep -q 'trackInboundMessage' dist/src/whatsapp/session-manager.js
grep -q 'sendGroupPoll' dist/src/whatsapp/transport-adapter.js
grep -q 'deleteall' dist/src/whatsapp/command-registry.js
grep -q 'mentions' dist/src/whatsapp/session-manager.js
grep -q 'realMention' dist/src/whatsapp/group-moderation-commands.js
grep -q 'buildAntiViolationResponse' dist/src/whatsapp/anti-system/engine.js
grep -q '𝗦𝗬𝗦𝗧𝗘𝗠 𝗪𝗔𝗥𝗡𝗜𝗡𝗚' dist/src/whatsapp/anti-system/response-format.js
grep -q 'ANTIGROUPSTATUS' dist/src/whatsapp/anti-system/response-format.js
grep -q 'CONFIG' dist/src/whatsapp/anti-system/response-format.js
grep -q 'How to use' dist/src/whatsapp/anti-system/response-format.js
grep -q 'PAIRING HELP' dist/src/telegram/ui.js
grep -q 'SESSION PAIRING' dist/src/telegram/ui.js
grep -q 'MEMBER BATCH JOB' dist/src/telegram/ui.js
grep -q 'banUsageCard' dist/src/whatsapp/response-cards.js
grep -q 'commandUsageCard' dist/src/whatsapp/response-cards.js
grep -q 'pairingHelpCard' dist/src/whatsapp/response-cards.js
! grep -Rql 'local-pappy-approval-probe' dist
test -s worker-package/index.js

EXPECTED_INDEX=$(sha256sum dist/src/index.js | cut -d' ' -f1)
EXPECTED_COMMAND=$(sha256sum dist/src/whatsapp/command-registry.js | cut -d' ' -f1)
EXPECTED_ENGINE=$(sha256sum dist/src/whatsapp/anti-system/engine.js | cut -d' ' -f1)
EXPECTED_RUNTIME=$(sha256sum dist/src/jobs/runtime.js | cut -d' ' -f1)
EXPECTED_SESSION=$(sha256sum dist/src/whatsapp/session-manager.js | cut -d' ' -f1)
EXPECTED_WORKER=$(sha256sum worker-package/index.js | cut -d' ' -f1)
tar -czf "$ARCHIVE" dist worker-package/index.js

: "${SSHPASS:?SSHPASS must be provided by the caller}"
sshpass -e scp -q -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$ARCHIVE" "root@${HOST}:/tmp/"
sshpass -e ssh -q -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@${HOST}" bash -s -- "$LABEL" "$EXPECTED_INDEX" "$EXPECTED_COMMAND" "$EXPECTED_ENGINE" "$EXPECTED_RUNTIME" "$EXPECTED_SESSION" "$EXPECTED_WORKER" <<'REMOTE'
set -euo pipefail
LABEL="$1"; EXPECTED_INDEX="$2"; EXPECTED_COMMAND="$3"; EXPECTED_ENGINE="$4"; EXPECTED_RUNTIME="$5"; EXPECTED_SESSION="$6"; EXPECTED_WORKER="$7"
cd /opt/pappy-omega-mini
STAGE="/tmp/${LABEL}-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "/tmp/${LABEL}.tar.gz" -C "$STAGE"
test -f "$STAGE/dist/src/index.js"
grep -q 'group-control:confirm' "$STAGE/dist/src/whatsapp/command-registry.js"
grep -q 'demote-remove' "$STAGE/dist/src/jobs/runtime.js"
grep -q 'moderation-groups' "$STAGE/dist/src/whatsapp/group-moderation-state.js"
grep -q 'trackInboundMessage' "$STAGE/dist/src/whatsapp/session-manager.js"
grep -q 'sendGroupPoll' "$STAGE/dist/src/whatsapp/transport-adapter.js"
grep -q 'deleteall' "$STAGE/dist/src/whatsapp/command-registry.js"
grep -q 'mentions' "$STAGE/dist/src/whatsapp/session-manager.js"
grep -q 'realMention' "$STAGE/dist/src/whatsapp/group-moderation-commands.js"
grep -q 'buildAntiViolationResponse' "$STAGE/dist/src/whatsapp/anti-system/engine.js"
grep -q '𝗦𝗬𝗦𝗧𝗘𝗠 𝗪𝗔𝗥𝗡𝗜𝗡𝗚' "$STAGE/dist/src/whatsapp/anti-system/response-format.js"
grep -q 'ANTIGROUPSTATUS' "$STAGE/dist/src/whatsapp/anti-system/response-format.js"
grep -q 'CONFIG' "$STAGE/dist/src/whatsapp/anti-system/response-format.js"
grep -q 'How to use' "$STAGE/dist/src/whatsapp/anti-system/response-format.js"
grep -q 'PAIRING HELP' "$STAGE/dist/src/telegram/ui.js"
grep -q 'SESSION PAIRING' "$STAGE/dist/src/telegram/ui.js"
grep -q 'MEMBER BATCH JOB' "$STAGE/dist/src/telegram/ui.js"
grep -q 'banUsageCard' "$STAGE/dist/src/whatsapp/response-cards.js"
grep -q 'commandUsageCard' "$STAGE/dist/src/whatsapp/response-cards.js"
grep -q 'pairingHelpCard' "$STAGE/dist/src/whatsapp/response-cards.js"
! grep -Rql 'local-pappy-approval-probe' "$STAGE/dist"
test -s "$STAGE/worker-package/index.js"
test "$(systemctl is-active pappy-panel-v3.service)" = active
mkdir -p .deploy-backups
if [ -d dist ]; then tar -czf ".deploy-backups/${LABEL}-dist.tar.gz" dist; fi
if [ -f worker-package/index.js ]; then cp -a worker-package/index.js ".deploy-backups/${LABEL}-worker-index.js"; fi
rollback() {
  set +e
  systemctl mask --runtime pappy-omega-mini.service >/dev/null 2>&1 || true
  systemctl stop pappy-omega-mini.service >/dev/null 2>&1 || true
  if [ -f ".deploy-backups/${LABEL}-dist.tar.gz" ]; then
    RESTORE_DIR=$(mktemp -d /tmp/pappy-rollback.XXXXXX)
    tar -xzf ".deploy-backups/${LABEL}-dist.tar.gz" -C "$RESTORE_DIR"
    cp -a "$RESTORE_DIR/dist/." dist/
    rm -rf "$RESTORE_DIR"
  fi
  if [ -f ".deploy-backups/${LABEL}-worker-index.js" ]; then cp -a ".deploy-backups/${LABEL}-worker-index.js" worker-package/index.js; fi
  systemctl unmask pappy-omega-mini.service >/dev/null 2>&1 || true
  systemctl start pappy-omega-mini.service >/dev/null 2>&1 || true
  rm -rf "$STAGE"
  rm -f "/tmp/${LABEL}.tar.gz" "/tmp/${LABEL}-health.json"
  exit 1
}
trap rollback ERR
systemctl mask --runtime pappy-omega-mini.service
systemctl stop pappy-omega-mini.service
for _ in $(seq 1 30); do
  [ "$(systemctl is-active pappy-omega-mini.service 2>/dev/null || true)" = inactive ] && break
  sleep 1
done
test "$(systemctl is-active pappy-omega-mini.service 2>/dev/null || true)" = inactive
cp -a "$STAGE/dist/." dist/
install -m 0700 "$STAGE/worker-package/index.js" worker-package/index.js
systemctl unmask pappy-omega-mini.service
systemctl start pappy-omega-mini.service
READY=false
for _ in $(seq 1 180); do
  if systemctl is-active --quiet pappy-omega-mini.service && curl -fsS --max-time 3 http://127.0.0.1:8788/workload/health > "/tmp/${LABEL}-health.json"; then READY=true; break; fi
  sleep 1
done
test "$READY" = true
test "$(systemctl is-active pappy-omega-mini.service)" = active
test "$(systemctl is-active pappy-panel-v3.service)" = active
grep -q '"ok":true' "/tmp/${LABEL}-health.json"
test "$(sha256sum dist/src/index.js | cut -d' ' -f1)" = "$EXPECTED_INDEX"
test "$(sha256sum dist/src/whatsapp/command-registry.js | cut -d' ' -f1)" = "$EXPECTED_COMMAND"
test "$(sha256sum dist/src/whatsapp/anti-system/engine.js | cut -d' ' -f1)" = "$EXPECTED_ENGINE"
test "$(sha256sum dist/src/jobs/runtime.js | cut -d' ' -f1)" = "$EXPECTED_RUNTIME"
test "$(sha256sum dist/src/whatsapp/session-manager.js | cut -d' ' -f1)" = "$EXPECTED_SESSION"
test "$(sha256sum worker-package/index.js | cut -d' ' -f1)" = "$EXPECTED_WORKER"
! grep -Rql 'local-pappy-approval-probe' dist
trap - ERR
printf 'control=%s\n' "$(systemctl is-active pappy-omega-mini.service)"
printf 'panel=%s\n' "$(systemctl is-active pappy-panel-v3.service)"
printf 'health_ok=true\n'
printf 'moderation_markers=present\n'
printf 'worker_hash=match\n'
printf 'probe_absent=true\n'
rm -rf "$STAGE"
rm -f "/tmp/${LABEL}.tar.gz" "/tmp/${LABEL}-health.json"
REMOTE
rm -f "$ARCHIVE"
unset SSHPASS
