import crypto from "node:crypto";
import {
  appendWorkloadEvent,
  consumeWorkloadEnrollment,
  createWorkloadAssignment,
  createWorkloadCommand,
  createWorkloadEnrollment,
  createWorkloadWorker,
  getWorkloadAssignment,
  getWorkloadAssignmentBySession,
  getWorkloadEnrollmentByTokenHash,
  getWorkspaceWorkloadMode,
  getWorkloadWorker,
  getWorkloadWorkerByCredentialHash,
  getWorkloadWorkerByDisplayKey,
  getWorkloadCommand,
  listWorkloadAssignments,
  listWorkloadWorkers,
  leaseWorkloadCommands,
  requeueStaleWorkloadCommands,
  completeWorkloadCommand as persistWorkloadCommandCompletion,
  updateWorkloadAssignment,
  updateWorkloadWorker,
} from "../persistence/mongo.js";
import { getSession, updateSession, updateWorkspaceWorkloadMode } from "../core/session-registry.js";
import { env } from "../config/env.js";
import {
  createDisplayKey,
  createOpaqueToken,
  createRequestId,
  hashCredential,
  verifyCredential,
  WORKLOAD_CONTROL_VERSION,
  WORKLOAD_ENROLLMENT_TTL_MS,
  WORKLOAD_HEARTBEAT_INTERVAL_MS,
  WORKLOAD_HEARTBEAT_TIMEOUT_MS,
} from "./security.js";
import type {
  WorkloadAssignmentRecord,
  WorkloadCommandKind,
  WorkloadCommandRecord,
  WorkloadEnrollmentRecord,
  WorkloadHeartbeatRequest,
  WorkloadRegistrationRequest,
  WorkloadRegistrationResponse,
  WorkloadWorkerRecord,
} from "./types.js";

export interface WorkloadEnrollmentResult {
  enrollmentId: string;
  token: string;
  expiresAt: number;
}

export interface AuthenticatedWorkloadWorker {
  worker: WorkloadWorkerRecord;
  credential: string;
}

export async function createWorkloadEnrollmentToken(
  workspaceId: string,
  ownerTelegramUserId: string,
): Promise<WorkloadEnrollmentResult> {
  const token = createOpaqueToken(24);
  const now = Date.now();
  const record: WorkloadEnrollmentRecord = {
    enrollmentId: crypto.randomUUID(),
    workspaceId,
    ownerTelegramUserId,
    tokenHash: hashCredential(token),
    expiresAt: now + WORKLOAD_ENROLLMENT_TTL_MS,
    createdAt: now,
  };
  await createWorkloadEnrollment(record);
  return { enrollmentId: record.enrollmentId, token, expiresAt: record.expiresAt };
}

export async function registerWorkloadWorker(
  input: WorkloadRegistrationRequest,
): Promise<WorkloadRegistrationResponse & { workspaceId: string }> {
  const enrollment = await getWorkloadEnrollmentByTokenHash(hashCredential(input.enrollmentToken));
  if (!enrollment) throw new Error("Workload enrollment token is invalid or expired.");
  if (!(await consumeWorkloadEnrollment(enrollment.enrollmentId)) )
    throw new Error("Workload enrollment token was already consumed.");

  const now = Date.now();
  const credential = createOpaqueToken(48);
  const worker: WorkloadWorkerRecord = {
    workerId: crypto.randomUUID(),
    workspaceId: enrollment.workspaceId,
    ownerTelegramUserId: enrollment.ownerTelegramUserId,
    displayKey: createDisplayKey(),
    credentialHash: hashCredential(credential),
    credentialIssuedAt: now,
    status: "CONNECTING",
    workerVersion: input.workerVersion,
    capabilities: [...new Set(input.capabilities)].slice(0, 50),
    assignedSessionIds: [],
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await createWorkloadWorker(worker);
  await appendWorkloadEvent({
    workspaceId: worker.workspaceId,
    workerId: worker.workerId,
    kind: "worker.registered",
    metadata: { version: worker.workerVersion, capabilities: worker.capabilities },
  });
  return {
    workerId: worker.workerId,
    displayKey: worker.displayKey,
    credential,
    heartbeatIntervalMs: WORKLOAD_HEARTBEAT_INTERVAL_MS,
    controlVersion: WORKLOAD_CONTROL_VERSION,
    workspaceId: worker.workspaceId,
  };
}

export async function authenticateWorkloadWorker(
  credential: string,
): Promise<AuthenticatedWorkloadWorker> {
  if (!credential || credential.length < 32) throw new Error("Missing workload credential.");
  const worker = await getWorkloadWorkerByCredentialHash(hashCredential(credential));
  if (!worker) throw new Error("Workload worker authentication failed.");
  if (["DISABLED", "REVOKED"].includes(worker.status))
    throw new Error(`Workload worker is ${worker.status.toLowerCase()}.`);
  return { worker, credential };
}

export async function recordWorkloadHeartbeat(
  credential: string,
  input: WorkloadHeartbeatRequest,
): Promise<WorkloadWorkerRecord> {
  const { worker } = await authenticateWorkloadWorker(credential);
  if (input.workerVersion < env.WORKLOAD_MIN_WORKER_VERSION)
    throw new Error(`Worker version ${input.workerVersion} is incompatible.`);
  const now = Date.now();
  const next = await updateWorkloadWorker(worker.workerId, {
    status: input.status === "ERROR" ? "ERROR" : "ACTIVE",
    workerVersion: input.workerVersion,
    capabilities: [...new Set(input.capabilities)].slice(0, 50),
    assignedSessionIds: [...new Set(input.assignedSessionIds)].slice(0, 100),
    lastHeartbeatAt: now,
    connectedAt: worker.connectedAt ?? now,
    ...(input.lastError ? { lastError: input.lastError.slice(0, 500) } : {}),
  });
  if (!next) throw new Error("Workload worker no longer exists.");
  await appendWorkloadEvent({
    workspaceId: next.workspaceId,
    workerId: next.workerId,
    kind: "worker.heartbeat",
    metadata: { status: next.status, assignedSessionCount: next.assignedSessionIds.length },
  });
  return next;
}

export async function assignWorkloadSession(
  workspaceId: string,
  sessionId: string,
  workerId: string,
): Promise<WorkloadAssignmentRecord> {
  const session = getSession(workspaceId, sessionId);
  if (!session || session.workspaceId !== workspaceId) throw new Error("Session is not in this workspace.");
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.workspaceId !== workspaceId) throw new Error("Worker is not owned by this workspace.");
  if (worker.status !== "ACTIVE") throw new Error("Worker must be ACTIVE before assignment.");
  const existing = await getWorkloadAssignmentBySession(sessionId);
  if (existing && existing.workerId !== workerId && ["ASSIGNED", "RUNNING", "DEGRADED", "OFFLINE"].includes(existing.status))
    throw new Error("Session already has an active workload assignment.");
  const now = Date.now();
  const assignment: WorkloadAssignmentRecord = existing && existing.workerId === workerId
    ? (await updateWorkloadAssignment(existing.assignmentId, { status: "ASSIGNED" })) ?? existing
    : {
        assignmentId: crypto.randomUUID(),
        workspaceId,
        sessionId,
        workerId,
        status: "ASSIGNED",
        assignedAt: now,
        updatedAt: now,
      };
  if (!existing || existing.workerId !== workerId) await createWorkloadAssignment(assignment);
  const assignedSessionIds = [...new Set([...worker.assignedSessionIds, sessionId])];
  await updateWorkloadWorker(workerId, { assignedSessionIds });
  updateSession(workspaceId, sessionId, { workloadWorkerId: workerId, workerNodeId: workerId });
  await appendWorkloadEvent({
    workspaceId,
    workerId,
    sessionId,
    kind: "assignment.created",
    metadata: { assignmentId: assignment.assignmentId },
  });
  return assignment;
}

export async function getAuthorizedWorkloadAssignment(
  workerId: string,
  sessionId: string,
): Promise<WorkloadAssignmentRecord> {
  const assignment = await getWorkloadAssignmentBySession(sessionId);
  if (!assignment || assignment.workerId !== workerId || ["REVOKED", "OFFLINE"].includes(assignment.status))
    throw new Error("Worker is not authorized for this session.");
  return assignment;
}

export async function queueWorkloadCommand(
  workspaceId: string,
  sessionId: string,
  kind: WorkloadCommandKind,
  payload: Record<string, unknown>,
  ttlMs = 60_000,
): Promise<WorkloadCommandRecord> {
  const assignment = await getWorkloadAssignmentBySession(sessionId);
  if (!assignment || assignment.workspaceId !== workspaceId || ["REVOKED", "OFFLINE"].includes(assignment.status))
    throw new Error("Session has no reachable workload assignment.");
  const now = Date.now();
  const record: WorkloadCommandRecord = {
    commandId: crypto.randomUUID(),
    assignmentId: assignment.assignmentId,
    workspaceId,
    sessionId,
    workerId: assignment.workerId,
    kind,
    payload,
    status: "QUEUED",
    requestId: createRequestId(),
    createdAt: now,
    expiresAt: now + Math.max(5_000, Math.min(ttlMs, 10 * 60_000)),
  };
  await createWorkloadCommand(record);
  return record;
}

export async function pollWorkloadCommands(
  credential: string,
  limit = 10,
): Promise<WorkloadCommandRecord[]> {
  const { worker } = await authenticateWorkloadWorker(credential);
  await updateWorkloadWorker(worker.workerId, { lastHeartbeatAt: Date.now(), status: "ACTIVE" });
  await requeueStaleWorkloadCommands(worker.workerId);
  return leaseWorkloadCommands(worker.workerId, limit);
}

export async function completeWorkloadCommand(
  credential: string,
  input: { commandId: string; requestId: string; ok: boolean; result?: Record<string, unknown>; error?: string },
): Promise<WorkloadCommandRecord> {
  const { worker } = await authenticateWorkloadWorker(credential);
  const command = await getWorkloadCommand(input.commandId);
  if (!command || command.workerId !== worker.workerId || command.requestId !== input.requestId)
    throw new Error("Command is not owned by this worker.");
  const completed = await persistWorkloadCommandCompletion({
    ...command,
    ...input,
  } as WorkloadCommandRecord & { ok: boolean });
  if (!completed) throw new Error("Command was already completed, expired, or not leased.");
  await appendWorkloadEvent({
    workspaceId: completed.workspaceId,
    workerId: worker.workerId,
    sessionId: completed.sessionId,
    kind: input.ok ? "command.completed" : "command.failed",
    metadata: { commandId: completed.commandId, kind: completed.kind },
  });
  return completed;
}

export async function waitForWorkloadCommand(
  commandId: string,
  timeoutMs = 45_000,
): Promise<WorkloadCommandRecord> {
  const deadline = Date.now() + Math.max(5_000, Math.min(timeoutMs, 120_000));
  while (Date.now() < deadline) {
    const command = await getWorkloadCommand(commandId);
    if (!command) throw new Error("Workload command disappeared.");
    if (["COMPLETED", "FAILED", "EXPIRED"].includes(command.status)) {
      if (command.status !== "COMPLETED") throw new Error(command.error ?? "Workload command failed.");
      return command;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Assigned workload worker did not respond before the control timeout.");
}

export async function setWorkloadMode(
  workspaceId: string,
  mode: "ON" | "OFF",
): Promise<void> {
  updateWorkspaceWorkloadMode(workspaceId, mode);
}

export async function disconnectWorkloadWorker(workerId: string): Promise<WorkloadWorkerRecord> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const updated = await updateWorkloadWorker(workerId, { status: "OFFLINE", lastError: "Graceful disconnect." });
  if (!updated) throw new Error("Workload worker could not be disconnected.");
  for (const assignment of (await listWorkloadAssignments(worker.workspaceId)).filter((item) => item.workerId === workerId && item.status !== "REVOKED"))
    await updateWorkloadAssignment(assignment.assignmentId, { status: "OFFLINE", lastError: "Worker disconnected." });
  await appendWorkloadEvent({ workspaceId: updated.workspaceId, workerId, kind: "worker.status", metadata: { status: "OFFLINE", reason: "graceful-disconnect" } });
  return updated;
}

export async function markUnreachableWorkloadWorkers(
  timeoutMs = WORKLOAD_HEARTBEAT_TIMEOUT_MS,
): Promise<number> {
  const cutoff = Date.now() - timeoutMs;
  let changed = 0;
  for (const worker of await listWorkloadWorkers()) {
    if (!["ACTIVE", "CONNECTING"].includes(worker.status)) continue;
    if (!worker.lastHeartbeatAt || worker.lastHeartbeatAt >= cutoff) continue;
    await updateWorkloadWorker(worker.workerId, { status: "UNREACHABLE", lastError: "Heartbeat timeout." });
    const assignments = await listWorkloadAssignments(worker.workspaceId);
    for (const assignment of assignments.filter((item) => item.workerId === worker.workerId && item.status !== "REVOKED"))
      await updateWorkloadAssignment(assignment.assignmentId, { status: "OFFLINE", lastError: "Worker heartbeat timeout." });
    await appendWorkloadEvent({
      workspaceId: worker.workspaceId,
      workerId: worker.workerId,
      kind: "worker.status",
      metadata: { status: "UNREACHABLE", reason: "heartbeat-timeout" },
    });
    changed += 1;
  }
  return changed;
}

export async function getWorkloadMode(workspaceId: string): Promise<"ON" | "OFF"> {
  return getWorkspaceWorkloadMode(workspaceId);
}

export async function listWorkspaceWorkloadWorkers(workspaceId: string): Promise<WorkloadWorkerRecord[]> {
  return listWorkloadWorkers(workspaceId);
}

export async function getWorkspaceWorkloadWorkerByDisplayKey(
  workspaceId: string,
  displayKey: string,
): Promise<WorkloadWorkerRecord | undefined> {
  const worker = await getWorkloadWorkerByDisplayKey(displayKey.trim());
  return worker?.workspaceId === workspaceId ? worker : undefined;
}

export async function revokeWorkloadWorker(workerId: string): Promise<WorkloadWorkerRecord> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const updated = await updateWorkloadWorker(workerId, { status: "REVOKED" });
  if (!updated) throw new Error("Workload worker could not be revoked.");
  await appendWorkloadEvent({
    workspaceId: updated.workspaceId,
    workerId: updated.workerId,
    kind: "worker.revoked",
    metadata: { reason: "user-removed-key" },
  });
  return updated;
}

export async function toggleWorkloadWorker(workerId: string): Promise<WorkloadWorkerRecord> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const disabled = worker.status !== "DISABLED";
  const updated = await updateWorkloadWorker(workerId, {
    status: disabled ? "DISABLED" : "ACTIVE",
    ...(disabled ? { disabledAt: Date.now() } : { disabledAt: undefined }),
  } as Partial<WorkloadWorkerRecord>);
  if (!updated) throw new Error("Workload worker could not be updated.");
  await appendWorkloadEvent({
    workspaceId: updated.workspaceId,
    workerId: updated.workerId,
    kind: disabled ? "worker.disabled" : "worker.re-enabled",
    metadata: { status: updated.status },
  });
  return updated;
}

export function workloadControlSummary(): Record<string, number | string> {
  return {
    controlVersion: WORKLOAD_CONTROL_VERSION,
    heartbeatIntervalMs: WORKLOAD_HEARTBEAT_INTERVAL_MS,
    packageVersion: env.WORKLOAD_PACKAGE_VERSION,
  };
}
