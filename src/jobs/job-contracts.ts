export type JobKind =
  | "pairing"
  | "link-collection"
  | "link-validation"
  | "link-export"
  | "allstatus"
  | "allchat"
  | "tag"
  | "broadcast"
  | "scheduled"
  | "preview-hydration"
  | "media-processing"
  | "group-sync"
  | "cleanup";

export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "RETRYING";

export interface JobProgress {
  completed: number;
  total?: number;
  success: number;
  failed: number;
  skipped: number;
  retrying: number;
  rate: number;
  elapsedMs: number;
  etaMs?: number;
}

export interface JobRecord<TPayload = Record<string, unknown>> {
  jobId: string;
  idempotencyKey: string;
  workspaceId: string;
  sessionId?: string;
  kind: JobKind;
  payload: TPayload;
  state: JobState;
  progress: JobProgress;
  attempts: number;
  maxAttempts: number;
  cancellationRequested: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface WorkerContext {
  job: JobRecord;
  signal: AbortSignal;
  report(progress: Partial<JobProgress>): Promise<void>;
  isCancellationRequested(): boolean;
}

export type WorkerHandler = (
  context: WorkerContext,
) => Promise<Pick<JobProgress, "success" | "failed" | "skipped">>;

export function makeIdempotencyKey(input: {
  workspaceId: string;
  sessionId?: string;
  jobId: string;
  targetJid?: string;
  payloadHash: string;
}): string {
  return [
    input.workspaceId,
    input.sessionId ?? "-",
    input.jobId,
    input.targetJid ?? "-",
    input.payloadHash,
  ].join(":");
}
