import { describe, expect, it } from "vitest";
import { runBoundedBatch } from "../src/jobs/bounded-batch.js";
import type { JobRecord, WorkerContext } from "../src/jobs/job-contracts.js";

function context(cancelled = false): WorkerContext {
  const job: JobRecord = {
    jobId: "job-1",
    idempotencyKey: "idempotent-1",
    workspaceId: "workspace-1",
    kind: "allchat",
    payload: {},
    state: "RUNNING",
    progress: {
      completed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      retrying: 0,
      rate: 0,
      elapsedMs: 0,
    },
    attempts: 1,
    maxAttempts: 3,
    cancellationRequested: cancelled,
    createdAt: Date.now(),
  };
  return {
    job,
    signal: new AbortController().signal,
    isCancellationRequested: () => job.cancellationRequested,
    waitIfPaused: async () => undefined,
    report: async (progress) => {
      job.progress = { ...job.progress, ...progress };
    },
  };
}

describe("bounded workers", () => {
  it("limits concurrency and reports all item outcomes", async () => {
    let active = 0;
    let peak = 0;
    const result = await runBoundedBatch({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      context: context(),
      processItem: async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return item === 3
          ? { status: "failed" as const }
          : { status: "success" as const };
      },
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result).toEqual({ success: 4, failed: 1, skipped: 0 });
  });

  it("stops starting new work when cancellation is requested", async () => {
    const workerContext = context();
    let processed = 0;
    const result = await runBoundedBatch({
      items: [1, 2, 3, 4],
      concurrency: 1,
      context: workerContext,
      processItem: async () => {
        processed += 1;
        workerContext.job.cancellationRequested = true;
        return { status: "success" as const };
      },
    });
    expect(processed).toBe(1);
    expect(result.success).toBe(1);
  });
});
