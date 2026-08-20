import { env } from "../config/env.js";
import { WORKLOAD_HEARTBEAT_TIMEOUT_MS } from "./security.js";
import type { WorkloadWorkerRecord } from "./types.js";

function versionParts(value: string): number[] {
  return value.split(".").map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ""), 10) || 0).slice(0, 3);
}

export function compareWorkerVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function isWorkloadWorkerReady(worker: WorkloadWorkerRecord, now = Date.now()): boolean {
  return worker.status === "ACTIVE" &&
    Boolean(worker.lastHeartbeatAt && now - worker.lastHeartbeatAt <= WORKLOAD_HEARTBEAT_TIMEOUT_MS) &&
    compareWorkerVersions(worker.workerVersion, env.WORKLOAD_MIN_WORKER_VERSION) >= 0;
}
