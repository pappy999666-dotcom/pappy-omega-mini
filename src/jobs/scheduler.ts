import { createHash } from "node:crypto";
import {
  claimSchedule,
  listDueSchedules,
  type ScheduleRecord,
} from "../persistence/mongo.js";
import { recordAudit } from "../core/control-plane.js";
import type { JobOrchestrator } from "./job-orchestrator.js";

export class DurableScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly orchestrator: JobOrchestrator) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
    void this.tick();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await listDueSchedules(now, 25);
      for (const schedule of due) await this.dispatch(schedule, now);
    } finally {
      this.running = false;
    }
  }

  private async dispatch(schedule: ScheduleRecord, now: number): Promise<void> {
    const claimed = await claimSchedule(schedule.scheduleId, now);
    if (!claimed) return;
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(claimed.payload))
      .digest("hex");
    try {
      await this.orchestrator.enqueue({
        workspaceId: claimed.workspaceId,
        ...(claimed.sessionId ? { sessionId: claimed.sessionId } : {}),
        kind: claimed.kind,
        payload: claimed.payload,
        idempotencyKey: `schedule:${claimed.scheduleId}:${claimed.lastRunAt ?? now}:${payloadHash}`,
      });
      recordAudit({
        workspaceId: claimed.workspaceId,
        actorTelegramUserId: "scheduler",
        action: "schedule.dispatch",
        success: true,
        metadata: { scheduleId: claimed.scheduleId, kind: claimed.kind },
      });
    } catch (error) {
      recordAudit({
        workspaceId: claimed.workspaceId,
        actorTelegramUserId: "scheduler",
        action: "schedule.dispatch",
        success: false,
        reason: error instanceof Error ? error.message : String(error),
        metadata: { scheduleId: claimed.scheduleId, kind: claimed.kind },
      });
    }
  }
}
