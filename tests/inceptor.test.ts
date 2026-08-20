import { describe, expect, it } from "vitest";
import { Inceptor } from "../src/jobs/inceptor.js";
import type { JobOrchestrator } from "../src/jobs/job-orchestrator.js";

describe("Inceptor maintenance engine", () => {
  it("runs a bounded sweep and delegates terminal pruning safely", async () => {
    const runtime = {
      listAllJobs: async () => [],
      pruneTerminalJobs: async () => 4,
    } as unknown as JobOrchestrator;
    const inceptor = new Inceptor(runtime);
    const snapshot = await inceptor.sweep();
    expect(snapshot.name).toBe("INCEPTOR");
    expect(snapshot.running).toBe(true);
    expect(snapshot.scanned).toBe(0);
    expect(snapshot.recovered).toBe(0);
    expect(snapshot.flushedDeadSessionJobs).toBe(0);
    expect(snapshot.prunedTerminalJobs).toBe(4);
    expect(snapshot.lastSweepAt).toBeTypeOf("number");
  });
});
