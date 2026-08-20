import { listAllSessions } from "../core/session-registry.js";
import type { JobRecord } from "./job-contracts.js";
import type { JobOrchestrator } from "./job-orchestrator.js";

const INCEPTOR_INTERVAL_MS = 45_000;
const STUCK_JOB_GRACE_MS = 3 * 60_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RECOVERIES_PER_SWEEP = 8;
const MAX_FLUSHES_PER_SWEEP = 100;
const MAX_PRUNES_PER_SWEEP = 50;

export interface InceptorSnapshot {
  name: "INCEPTOR";
  running: boolean;
  lastSweepAt?: number;
  nextSweepAt?: number;
  scanned: number;
  recovered: number;
  failed: number;
  flushedDeadSessionJobs: number;
  prunedTerminalJobs: number;
  skippedTransientSessions: number;
  lastActions: string[];
  lastError?: string;
}

let activeInceptor: Inceptor | undefined;

function isDeadSession(session: ReturnType<typeof listAllSessions>[number]): boolean {
  return session.status === "LOGGED_OUT" || session.status === "BANNED" || session.authHealth === "INVALID";
}

function isStuck(record: JobRecord, now: number): boolean {
  if (!(["RUNNING", "RETRYING", "QUEUED"].includes(record.state))) return false;
  const heartbeat = record.heartbeatAt ?? record.startedAt ?? record.createdAt;
  return now - heartbeat >= STUCK_JOB_GRACE_MS;
}

export class Inceptor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private snapshot: InceptorSnapshot = {
    name: "INCEPTOR",
    running: false,
    scanned: 0,
    recovered: 0,
    failed: 0,
    flushedDeadSessionJobs: 0,
    prunedTerminalJobs: 0,
    skippedTransientSessions: 0,
    lastActions: [],
  };

  constructor(private readonly orchestrator: JobOrchestrator) {}

  start(): void {
    if (this.timer) return;
    this.snapshot.running = true;
    this.timer = setInterval(() => void this.sweep(), INCEPTOR_INTERVAL_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  async sweep(): Promise<InceptorSnapshot> {
    if (this.sweeping) return this.snapshot;
    this.sweeping = true;
    const startedAt = Date.now();
    const actions: string[] = [];
    let recovered = 0;
    let failed = 0;
    let flushedDeadSessionJobs = 0;
    let prunedTerminalJobs = 0;
    let skippedTransientSessions = 0;
    try {
      const sessions = listAllSessions();
      const deadSessionKeys = new Set(
        sessions.filter(isDeadSession).map((session) => `${session.workspaceId}:${session.sessionId}`),
      );
      const records = await this.orchestrator.listAllJobs();
      for (const record of records) {
        if (!this.orchestrator.ownsSession(record.sessionId)) continue;
        if (record.sessionId && deadSessionKeys.has(`${record.workspaceId}:${record.sessionId}`)) {
          if (flushedDeadSessionJobs >= MAX_FLUSHES_PER_SWEEP) break;
          if (await this.orchestrator.flushJob(record.jobId)) {
            flushedDeadSessionJobs += 1;
            actions.push(`flushed ${record.kind} ${record.jobCode ?? record.jobId.slice(0, 8)} for terminal session ${record.sessionId.slice(0, 8)}`);
          }
          continue;
        }
        if (record.sessionId && sessions.some((session) => session.sessionId === record.sessionId && session.status !== "ACTIVE"))
          skippedTransientSessions += 1;
        if (!isStuck(record, startedAt) || recovered + failed >= MAX_RECOVERIES_PER_SWEEP) continue;
        const outcome = await this.orchestrator.forceRecoverJob(record.jobId);
        if (outcome === "recovered") {
          recovered += 1;
          actions.push(`recovered stuck ${record.kind} ${record.jobCode ?? record.jobId.slice(0, 8)}`);
        } else if (outcome === "failed") {
          failed += 1;
          actions.push(`failed exhausted ${record.kind} ${record.jobCode ?? record.jobId.slice(0, 8)}`);
        }
      }
      prunedTerminalJobs = await this.orchestrator.pruneTerminalJobs(
        TERMINAL_RETENTION_MS,
        MAX_PRUNES_PER_SWEEP,
      );
      if (prunedTerminalJobs) actions.push(`pruned ${prunedTerminalJobs} terminal job record(s)`);
      this.snapshot = {
        name: "INCEPTOR",
        running: true,
        lastSweepAt: startedAt,
        nextSweepAt: startedAt + INCEPTOR_INTERVAL_MS,
        scanned: records.length,
        recovered,
        failed,
        flushedDeadSessionJobs,
        prunedTerminalJobs,
        skippedTransientSessions,
        lastActions: actions.slice(-20),
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        running: true,
        lastSweepAt: startedAt,
        nextSweepAt: startedAt + INCEPTOR_INTERVAL_MS,
        recovered,
        failed,
        flushedDeadSessionJobs,
        prunedTerminalJobs,
        skippedTransientSessions,
        lastActions: actions.slice(-20),
        lastError: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.sweeping = false;
    }
    return this.snapshot;
  }

  getSnapshot(): InceptorSnapshot {
    return { ...this.snapshot, lastActions: [...this.snapshot.lastActions] };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.snapshot.running = false;
  }
}

export function startInceptor(orchestrator: JobOrchestrator): Inceptor {
  if (!activeInceptor) activeInceptor = new Inceptor(orchestrator);
  activeInceptor.start();
  return activeInceptor;
}

export function getInceptor(): Inceptor | undefined {
  return activeInceptor;
}
