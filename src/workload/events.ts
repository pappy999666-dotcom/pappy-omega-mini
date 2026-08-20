import type { WorkloadInboundEvent, WorkloadInboundResult } from "./types.js";

let handler: ((event: WorkloadInboundEvent) => Promise<WorkloadInboundResult>) | undefined;

export function setWorkloadInboundEventHandler(
  next: (event: WorkloadInboundEvent) => Promise<WorkloadInboundResult>,
): void {
  handler = next;
}

export async function handleWorkloadInboundEvent(
  event: WorkloadInboundEvent,
): Promise<WorkloadInboundResult> {
  if (!handler) throw new Error("Workload inbound-event handler is not ready.");
  return handler(event);
}
