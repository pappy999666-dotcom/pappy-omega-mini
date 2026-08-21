import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WorkloadBroadcastIntent } from "../src/workload/types.js";

const workerSourcePath = new URL("../tools/worker-runtime-source.mjs", import.meta.url);

function makeIntent(): WorkloadBroadcastIntent {
  return {
    jobId: "job-compact-001",
    kind: "allstatus",
    text: "high-scale smoke test",
    delayMs: 1000,
    repeat: 1,
  };
}

describe("high-scale worker-local broadcast contract", () => {
  it.each([10, 100, 1000, 2000, 5000, 10000])(
    "keeps the control intent compact for %i groups",
    (groupCount) => {
      const groups = Array.from({ length: groupCount }, (_, index) => `group-${index}@g.us`);
      const intent = makeIntent();
      const encoded = JSON.stringify(intent);
      expect(groups).toHaveLength(groupCount);
      expect(encoded).not.toContain("@g.us");
      expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
    },
  );

  it("defines durable worker-local checkpointing and aggregated progress", async () => {
    const source = await readFile(workerSourcePath, "utf8");
    expect(source).toContain('join(DATA_DIR, "broadcasts")');
    expect(source).toContain("writeBroadcastCheckpoint");
    expect(source).toContain("nextDelivery");
    expect(source).toContain('control("/workload/progress"');
    expect(source).toContain("groupFetchAllParticipating");
    expect(source).toContain("broadcast.start");
    expect(source).toContain("broadcast.cancel");
  });

  it("does not place group inventory on the broadcast workload intent", () => {
    const intent = makeIntent() as WorkloadBroadcastIntent & { groups?: string[] };
    expect(intent.groups).toBeUndefined();
    expect(Object.keys(intent).sort()).toEqual(["delayMs", "jobId", "kind", "repeat", "text"]);
  });
});
