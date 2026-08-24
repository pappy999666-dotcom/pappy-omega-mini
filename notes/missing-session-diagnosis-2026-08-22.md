# Missing-session diagnosis

Live read-only checks on 2026-08-22 found the selected active panel session still persisted in MongoDB:

- sessionId: 0776b9ca-e4ff-4882-82a2-409d287e536a
- workspaceId: 48aafb88-1e92-42fa-a471-946e90d22ebc
- name: Pappy
- phone: 2347065217750
- session status: DEGRADED
- authHealth: DEGRADED
- workloadWorkerId/workerNodeId: 3d45149e-a536-42b3-9363-870af82d68dd
- disconnectReason: Panel heartbeat timeout; panel is offline. Session data is retained for recovery.

Assignment remains persisted:
- assignmentId: 3696d467-21ef-461e-98c3-c05f2e30e7c4
- status: OFFLINE
- lastError: Worker heartbeat timeout.

Worker pappy-v3 remains persisted but was UNREACHABLE, with stale heartbeat and workerVersion 1.2.64 before the panel restart. The session is hidden by the application visibility filter when a workload session is DEGRADED with a Panel heartbeat timeout; it was not deleted.

The panel supervisor was restarted non-destructively. It auto-updated to release 1.2.65, but the new process still reported zero sessions and repeatedly showed `Session is not owned by this workspace.` / `Worker is not authorized for this session.` This indicates the panel’s local session reconstruction/control payload is using a workspace value that does not match the persisted session/assignment, or the control-plane heartbeat/session-status contract still assumes the owner workspace. No auth/session files were deleted or purged.

Live services after restart: pappy-omega-mini.service ACTIVE; pappy-panel-v3.service ACTIVE. Control env WORKLOAD_PACKAGE_VERSION=1.2.65 and WORKLOAD_RELEASE_VERSION=1.2.65.

Next investigation: inspect panel local worker state without printing credentials, identify how persisted session workspace is mapped during restart, then apply a non-destructive control/panel fix. Do not mark the session ACTIVE manually or delete/re-pair it without evidence.
## Recovery confirmed

The root cause was not deletion. `recordWorkloadHeartbeat` was iterating all historical assignments for pappy-v3 and calling `getSession()` on purged/missing sessions. One orphaned assignment threw `Session is not owned by this workspace`, so the heartbeat failed before the valid retained session could be restored. The valid assignment had also been marked OFFLINE by the heartbeat timeout, preventing the panel from reporting its status.

The control-plane fix now ignores orphaned assignments for heartbeat purposes and safely changes valid retained OFFLINE/DEGRADED assignments back to ASSIGNED when the worker heartbeats. The panel then receives the retained session ID and starts it from its existing auth files.

After deploying the fix and restarting only the control service, live verification at 2026-08-22T10:09:51Z showed:

- pappy-panel-v3 and pappy-omega-mini services ACTIVE.
- Session 0776b9ca-e4ff-4882-82a2-409d287e536a status ACTIVE and authHealth VALID.
- Assignment 3696d467-21ef-461e-98c3-c05f2e30e7c4 status RUNNING.
- Worker pappy-v3 status ACTIVE, workerVersion 1.2.65, one assigned session, fresh heartbeat.
- No auth files were deleted, no purge was run, and no WhatsApp message was sent by the recovery check.
