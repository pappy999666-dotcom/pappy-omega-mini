# Allstatus / Redis audit — 2026-08-21

## User symptom

Screenshot shows `.allstatus` acknowledging 37 groups, 37 expected posts, 20s delay, and live code `9A6488AE`, but no status posts are delivered.

## Live VPS findings on 167.86.85.193

- `pappy-omega-mini.service`: active.
- `pappy-panel-v3.service`: active.
- Redis: `127.0.0.1:6379`, no rejected connections; instantaneous ops observed between ~1,900 and ~5,000/s.
- Main PAPPY process: ~107% CPU during audit, ~383–387 MB RSS after restart.
- Local control process environment: `PROCESS_ROLE=full`, `QUEUE_CONCURRENCY=4`.
- Secondary PM2 PAPPY worker: online, `PROCESS_ROLE=worker`, `QUEUE_CONCURRENCY=16`, `WORKER_CONCURRENCY=8`, eight configured worker sessions. It uses the shared Redis/Mongo tunnel.
- Redis has unrelated `elite-broadcast-*` queues: ~3,772 keys at the time of audit.
- PAPPY BullMQ queue state: `wait=5`, `active=16`, `delayed=29`, `prioritized=483`, `failed=59`, `stalled=12`, `completed=2468`.
- Redis had ~1,341 PAPPY job records, ~1,358 job/idempotency/code keys, ~1,601 broadcast-done keys, and ~1,520 completion-notified keys.
- Multiple PAPPY queue consumers exist: local full process plus remote worker through the shared tunnel. Active jobs exceed the local concurrency because the remote worker also consumes the same queue.
- The queue includes long-lived Join Manager/recovery jobs and many prioritized jobs. An observed allstatus recovery record had `error="Broadcast session operation busy; retry scheduled."`, indicating session-operation-lock contention rather than a simple Redis connection refusal.
- The current architecture uses Redis for durable job records, BullMQ queue leasing, idempotency, restart recovery, broadcast-done markers, and Inceptor recovery. Removing Redis from allstatus outright would break restart durability and exactly-once/idempotent delivery guarantees.
- The panel worker has no Redis/Mongo/Telegram credentials; panel isolation remains intact.

## Source findings

- `src/whatsapp/message-router.ts`: allstatus enqueues a durable job with payload groups, delay, media reference, and source chat; it waits only for `runtime.enqueue()` to persist and queue the job, then returns the WhatsApp acknowledgement. It does not wait for the first delivery.
- `src/jobs/runtime.ts`: allstatus waits for session readiness, resolves groups if absent, acquires a per-session operation lock, then sends one status at a time with a delay. The first post can be blocked by readiness, inventory lookup, session lock, or other active jobs.
- `src/jobs/job-orchestrator.ts`: immediate posting kinds are prioritized, but priority does not preempt already-active long jobs. BullMQ and Redis are required for durable restart recovery.
- `src/jobs/inceptor.ts`: stale jobs and dead-session jobs are recovered/flushed, but observed queue state contains many recovery/Join Manager records.
- `src/whatsapp/transport-adapter.ts`: allstatus calls `sendGroupStatus`, then panel/local transport determines status delivery.

## Likely root cause

Redis is under shared workload and contributes contention, but the direct allstatus failure pattern is queue saturation plus per-session operation-lock contention. The acknowledgement is intentionally emitted after durable queue insertion, before the first post. Priority cannot preempt existing active jobs, and a session can remain blocked by a long Join Manager or stale recovery job.

## Recommended implementation direction

Do not remove Redis from durable allstatus processing. Instead:

1. Isolate PAPPY from unrelated `elite-broadcast` queues using a dedicated Redis instance/port or dedicated Redis deployment.
2. Add a dedicated high-priority broadcast lane/queue or reserved worker capacity so allstatus/allchat cannot be starved by Join Manager/Validator jobs.
3. Make the first-post readiness and session-lock path fail fast with an explicit durable state, and let Inceptor recover stale locks/jobs.
4. Ensure one active broadcast per session is enforced with a visible conflict state, while unrelated sessions/jobs continue independently.
5. Add focused tests for immediate dispatch, queue starvation, lock contention, restart recovery, and first-post success/failure reporting.

No code was changed for this audit yet; full implementation and regression testing remain pending.
