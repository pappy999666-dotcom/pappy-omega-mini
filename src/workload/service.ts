import crypto from "node:crypto";
import {
  appendWorkloadEvent,
  consumeWorkloadEnrollment,
  createWorkloadAssignment,
  createWorkloadCommand,
  cancelWorkloadCommandsForWorker,
  createWorkloadEnrollment,
  createWorkloadShare,
  createWorkloadWorker,
  deleteRevokedWorkloadWorkers,
  deleteWorkloadWorker,
  getWorkloadAssignment,
  getWorkloadAssignmentBySession,
  getWorkloadEnrollmentByTokenHash,
  getGlobalWorkloadMode,
  setGlobalWorkloadMode,
  getWorkspaceWorkloadMode,
  getWorkloadWorker,
  getWorkloadWorkerByCredentialHash,
  getWorkloadWorkerByDisplayKey,
  getWorkloadWorkerByWorkloadCode,
  getPendingWorkloadShareByTokenHash,
  getWorkloadShareById,
  getWorkloadCommand,
  expireStaleWorkloadCommands,
  listWorkloadAssignments,
  listWorkloadAssignmentsForWorker,
  listWorkloadWorkers,
  listWorkloadEvents,
  listActiveWorkloadSharesForWorkspace,
  listWorkloadSharesForWorker,
  updateWorkloadShareAccess,
  leaseWorkloadCommands,
  requeueStaleWorkloadCommands,
  completeWorkloadCommand as persistWorkloadCommandCompletion,
  updateWorkloadWorker,
  updateWorkloadAssignment,
  redeemWorkloadShare,
  revokeWorkloadShare,
  revokeWorkloadShareForRecipient,
  persistSession,
} from "../persistence/mongo.js";
import { getSession, refreshSessionRegistry, updateSession, updateWorkspaceWorkloadMode } from "../core/session-registry.js";
import { env } from "../config/env.js";
import { isWorkloadWorkerReady } from "./readiness.js";
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
  WorkloadEventRecord,
  WorkloadShareRecord,
} from "./types.js";

export interface WorkloadEnrollmentResult {
  enrollmentId: string;
  token: string;
  expiresAt: number;
}

export interface WorkloadPairingCodeResult {
  enrollmentId: string;
  pairingCode: string;
  expiresAt: number;
}

export interface WorkloadShareCodeResult {
  shareId: string;
  shareCode: string;
  expiresAt: number;
  workerName: string;
  workloadCode: string;
}

export type AccessibleWorkloadWorker = WorkloadWorkerRecord & {
  shared: boolean;
  shareId?: string;
};

export interface WorkloadShareRecipientSummary {
  shareId: string;
  workerId: string;
  workerName: string;
  workloadCode: string;
  recipientWorkspaceId: string;
  recipientTelegramUserId: string;
  recipientDisplayName: string;
  recipientUsername?: string;
  status: "ACTIVE" | "BLOCKED";
  updatedAt: number;
}

export interface AuthenticatedWorkloadWorker {
  worker: WorkloadWorkerRecord;
  credential: string;
}

const workloadCommandWaiters = new Map<string, Set<() => void>>();
const workloadCommandCompletionWaiters = new Map<string, Set<() => void>>();

export type WorkloadNotificationState = "CONNECTED" | "RECOVERED" | "OFFLINE" | "UNREACHABLE" | "ERROR";
export interface WorkloadNotification {
  state: WorkloadNotificationState;
  workspaceId: string;
  ownerTelegramUserId: string;
  workerId: string;
  workerName: string;
  workloadCode: string;
  workerVersion: string;
  assignedSessionCount: number;
  reason?: string;
}
let workloadNotifier: ((notification: WorkloadNotification) => Promise<void>) | undefined;
const lastWorkloadNotification = new Map<string, WorkloadNotificationState>();
const WORKLOAD_UI_CACHE_MS = 1_500;
const workloadWorkerListCache = new Map<string, { expiresAt: number; workers: WorkloadWorkerRecord[] }>();
const workloadLoggerCache = new Map<string, { expiresAt: number; snapshot: WorkloadLoggerSnapshot }>();

export function setWorkloadNotifier(
  notifier: (notification: WorkloadNotification) => Promise<void>,
): void {
  workloadNotifier = notifier;
}

function notifyWorkloadOwner(worker: WorkloadWorkerRecord, state: WorkloadNotificationState, reason?: string): void {
  if (!workloadNotifier) return;
  const previous = lastWorkloadNotification.get(worker.workerId);
  if (previous === state) return;
  lastWorkloadNotification.set(worker.workerId, state);
  const notification: WorkloadNotification = {
    state,
    workspaceId: worker.workspaceId,
    ownerTelegramUserId: worker.ownerTelegramUserId,
    workerId: worker.workerId,
    workerName: worker.workerName,
    workloadCode: worker.workloadCode ?? worker.displayKey,
    workerVersion: worker.workerVersion,
    assignedSessionCount: worker.assignedSessionIds.length,
    ...(reason ? { reason: reason.slice(0, 240) } : {}),
  };
  void workloadNotifier(notification).catch(() => {
    if (lastWorkloadNotification.get(worker.workerId) === state) lastWorkloadNotification.delete(worker.workerId);
  });
}

function notifyWorkloadCommandWaiters(workerId: string): void {
  const waiters = workloadCommandWaiters.get(workerId);
  if (!waiters) return;
  workloadCommandWaiters.delete(workerId);
  for (const wake of waiters) wake();
}

async function waitForWorkloadCommandSignal(workerId: string, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const waiters = workloadCommandWaiters.get(workerId) ?? new Set<() => void>();
    const timer = setTimeout(() => {
      waiters.delete(wake);
      if (!waiters.size) workloadCommandWaiters.delete(workerId);
      resolve();
    }, Math.min(timeoutMs, 25_000));
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      if (!waiters.size) workloadCommandWaiters.delete(workerId);
      resolve();
    };
    waiters.add(wake);
    workloadCommandWaiters.set(workerId, waiters);
  });
}

async function waitForWorkloadCommandCompletionSignal(commandId: string, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const waiters = workloadCommandCompletionWaiters.get(commandId) ?? new Set<() => void>();
    const timer = setTimeout(() => {
      waiters.delete(wake);
      if (!waiters.size) workloadCommandCompletionWaiters.delete(commandId);
      resolve();
    }, Math.min(timeoutMs, 1_000));
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      if (!waiters.size) workloadCommandCompletionWaiters.delete(commandId);
      resolve();
    };
    waiters.add(wake);
    workloadCommandCompletionWaiters.set(commandId, waiters);
  });
}

function notifyWorkloadCommandCompletion(commandId: string): void {
  const waiters = workloadCommandCompletionWaiters.get(commandId);
  if (!waiters) return;
  workloadCommandCompletionWaiters.delete(commandId);
  for (const wake of waiters) wake();
}

function normalizeWorkerName(input?: string): string {
  const normalized = String(input ?? "panel")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return normalized || "panel";
}

function createWorkloadCode(workerName: string): string {
  return `${workerName}-${crypto.randomBytes(3).toString("hex")}`;
}

function createHumanPairingCode(): string {
  const suffix = crypto.randomBytes(9).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toUpperCase();
  return `PAPPY-${suffix}`;
}

export async function createWorkloadPairingCode(
  workspaceId: string,
  ownerTelegramUserId: string,
  workerName?: string,
): Promise<WorkloadPairingCodeResult> {
  const pairingCode = createHumanPairingCode();
  const now = Date.now();
  const normalizedName = workerName ? normalizeWorkerName(workerName) : undefined;
  const record: WorkloadEnrollmentRecord = {
    enrollmentId: crypto.randomUUID(),
    workspaceId,
    ownerTelegramUserId,
    ...(normalizedName ? { workerName: normalizedName } : {}),
    tokenHash: hashCredential(pairingCode),
    expiresAt: now + WORKLOAD_ENROLLMENT_TTL_MS,
    createdAt: now,
  };
  await createWorkloadEnrollment(record);
  return { enrollmentId: record.enrollmentId, pairingCode, expiresAt: record.expiresAt };
}

export async function revokeSharedWorkloadAccess(
  recipientWorkspaceId: string,
  shareId: string,
): Promise<void> {
  const revoked = await revokeWorkloadShareForRecipient(shareId, recipientWorkspaceId);
  if (!revoked) throw new Error("Shared panel access was not found.");
  for (const assignment of (await listWorkloadAssignments(recipientWorkspaceId)).filter((item) => item.workerId === revoked.workerId && item.status !== "REVOKED")) {
    await updateWorkloadAssignment(assignment.assignmentId, { status: "REVOKED", lastError: "Shared panel access removed." });
  }
}

export async function createWorkloadShareCode(
  ownerWorkspaceId: string,
  ownerTelegramUserId: string,
  workerId: string,
): Promise<WorkloadShareCodeResult> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.workspaceId !== ownerWorkspaceId || worker.ownerTelegramUserId !== ownerTelegramUserId)
    throw new Error("Only the panel owner can create a share code.");
  if (["REVOKED", "DISABLED"].includes(worker.status))
    throw new Error("This workload cannot be shared while it is disabled or revoked.");
  const shareCode = `PAPPY-SHARE-${crypto.randomBytes(9).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toUpperCase()}`;
  const now = Date.now();
  const record: WorkloadShareRecord = {
    shareId: crypto.randomUUID(),
    workerId,
    ownerWorkspaceId,
    ownerTelegramUserId,
    tokenHash: hashCredential(shareCode),
    status: "PENDING",
    expiresAt: now + 24 * 60 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  };
  await createWorkloadShare(record);
  return { shareId: record.shareId, shareCode, expiresAt: record.expiresAt, workerName: worker.workerName, workloadCode: worker.workloadCode ?? worker.displayKey };
}

export async function redeemWorkloadShareCode(
  recipientWorkspaceId: string,
  recipientTelegramUserId: string,
  shareCode: string,
  recipientIdentity?: { displayName?: string; username?: string },
): Promise<AccessibleWorkloadWorker> {
  const normalized = shareCode.trim().toUpperCase().replace(/\s+/g, "");
  const pending = await getPendingWorkloadShareByTokenHash(hashCredential(normalized));
  if (!pending) throw new Error("Share code is invalid, expired, or already used.");
  if (pending.ownerWorkspaceId === recipientWorkspaceId)
    throw new Error("A panel cannot be shared back into its owner workspace.");
  const worker = await getWorkloadWorker(pending.workerId);
  if (!worker || worker.workspaceId !== pending.ownerWorkspaceId || worker.status === "REVOKED")
    throw new Error("The shared panel is no longer available.");
  const redeemed = await redeemWorkloadShare(pending.shareId, recipientWorkspaceId, recipientTelegramUserId, recipientIdentity);
  if (!redeemed) throw new Error("Share code was already claimed. Ask the panel owner for a new code.");
  return { ...worker, shared: true, shareId: redeemed.shareId };
}

export async function listOwnerWorkloadShareRecipients(
  ownerWorkspaceId: string,
  workerId: string,
): Promise<WorkloadShareRecipientSummary[]> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.workspaceId !== ownerWorkspaceId)
    throw new Error("Only the panel owner can manage shared users.");
  const shares = (await listWorkloadSharesForWorker(workerId, ownerWorkspaceId)).filter(
    (share) => Boolean(
      share.recipientWorkspaceId &&
      share.recipientTelegramUserId &&
      ["ACTIVE", "BLOCKED"].includes(share.status),
    ),
  );
  return shares.map((share) => ({
    shareId: share.shareId,
    workerId,
    workerName: worker.workerName,
    workloadCode: worker.workloadCode ?? worker.displayKey,
    recipientWorkspaceId: share.recipientWorkspaceId!,
    recipientTelegramUserId: share.recipientTelegramUserId!,
    recipientDisplayName: share.recipientDisplayName ?? "Telegram user",
    ...(share.recipientUsername ? { recipientUsername: share.recipientUsername } : {}),
    status: share.status as "ACTIVE" | "BLOCKED",
    updatedAt: share.updatedAt,
  }));
}

export async function setOwnerSharedUserAccess(
  ownerWorkspaceId: string,
  workerId: string,
  shareId: string,
  status: "ACTIVE" | "BLOCKED",
): Promise<WorkloadShareRecipientSummary> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.workspaceId !== ownerWorkspaceId)
    throw new Error("Only the panel owner can manage shared users.");
  const updated = await updateWorkloadShareAccess(shareId, ownerWorkspaceId, status);
  if (!updated?.recipientWorkspaceId || !updated.recipientTelegramUserId || !["ACTIVE", "BLOCKED"].includes(updated.status))
    throw new Error("Shared user was not found for this panel.");
  const assignments = (await listWorkloadAssignments(updated.recipientWorkspaceId)).filter(
    (assignment) => assignment.workerId === workerId && assignment.status !== "REVOKED",
  );
  for (const assignment of assignments) {
    if (status === "BLOCKED")
      await updateWorkloadAssignment(assignment.assignmentId, { status: "OFFLINE", lastError: "Shared panel access blocked by owner." });
    else if (assignment.status === "OFFLINE" && assignment.lastError === "Shared panel access blocked by owner.")
      await updateWorkloadAssignment(assignment.assignmentId, { status: "ASSIGNED", lastError: undefined });
  }
  return {
    shareId: updated.shareId,
    workerId,
    workerName: worker.workerName,
    workloadCode: worker.workloadCode ?? worker.displayKey,
    recipientWorkspaceId: updated.recipientWorkspaceId,
    recipientTelegramUserId: updated.recipientTelegramUserId,
    recipientDisplayName: updated.recipientDisplayName ?? "Telegram user",
    ...(updated.recipientUsername ? { recipientUsername: updated.recipientUsername } : {}),
    status,
    updatedAt: updated.updatedAt,
  };
}

export async function setOwnerSharedUserAccessByShare(
  ownerWorkspaceId: string,
  shareId: string,
  status: "ACTIVE" | "BLOCKED",
): Promise<WorkloadShareRecipientSummary> {
  const share = await getWorkloadShareById(shareId, ownerWorkspaceId);
  if (!share || !share.recipientWorkspaceId || !share.recipientTelegramUserId)
    throw new Error("Shared user was not found.");
  return setOwnerSharedUserAccess(ownerWorkspaceId, share.workerId, shareId, status);
}

export async function listAccessibleWorkspaceWorkloadWorkers(
  workspaceId: string,
): Promise<AccessibleWorkloadWorker[]> {
  const [owned, shares] = await Promise.all([
    listWorkspaceWorkloadWorkers(workspaceId),
    listActiveWorkloadSharesForWorkspace(workspaceId),
  ]);
  const ownedIds = new Set(owned.map((worker) => worker.workerId));
  const shared = (await Promise.all(shares.map(async (share) => {
    if (ownedIds.has(share.workerId)) return undefined;
    const worker = await getWorkloadWorker(share.workerId);
    if (!worker || worker.status === "REVOKED" || worker.workspaceId !== share.ownerWorkspaceId) return undefined;
    return { ...worker, shared: true, shareId: share.shareId } satisfies AccessibleWorkloadWorker;
  }))).filter((worker): worker is NonNullable<typeof worker> => worker !== undefined);
  return [...owned.map((worker) => ({ ...worker, shared: false as const })), ...shared];
}

export async function getAccessibleWorkspaceWorkloadWorkerByCode(
  workspaceId: string,
  workloadCode: string,
): Promise<AccessibleWorkloadWorker | undefined> {
  const worker = await getWorkloadWorkerByWorkloadCode(workloadCode.trim().toLowerCase());
  if (!worker || worker.status === "REVOKED") return undefined;
  if (worker.workspaceId === workspaceId) return { ...worker, shared: false };
  const share = (await listActiveWorkloadSharesForWorkspace(workspaceId)).find((item) => item.workerId === worker.workerId);
  return share ? { ...worker, shared: true, shareId: share.shareId } : undefined;
}

export async function getAccessibleWorkspaceWorkloadWorkerByDisplayKey(
  workspaceId: string,
  displayKey: string,
): Promise<AccessibleWorkloadWorker | undefined> {
  const worker = await getWorkloadWorkerByDisplayKey(displayKey.trim());
  if (!worker || worker.status === "REVOKED") return undefined;
  if (worker.workspaceId === workspaceId) return { ...worker, shared: false };
  const share = (await listActiveWorkloadSharesForWorkspace(workspaceId)).find((item) => item.workerId === worker.workerId);
  return share ? { ...worker, shared: true, shareId: share.shareId } : undefined;
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
  const suppliedCode = input.pairingCode ?? input.enrollmentToken;
  if (!suppliedCode) throw new Error("Panel pairing code is required.");
  const enrollment = await getWorkloadEnrollmentByTokenHash(hashCredential(suppliedCode));
  if (!enrollment) throw new Error(input.pairingCode ? "Panel pairing code is invalid or expired." : "Workload enrollment token is invalid or expired.");
  if (!(await consumeWorkloadEnrollment(enrollment.enrollmentId)) )
    throw new Error(input.pairingCode ? "Panel pairing code was already used." : "Workload enrollment token was already consumed.");

  const now = Date.now();
  const credential = createOpaqueToken(48);
  const workerName = normalizeWorkerName(enrollment.workerName ?? input.workerName);
  let workloadCode: string | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = createWorkloadCode(workerName);
    if (!(await getWorkloadWorkerByWorkloadCode(candidate))) {
      workloadCode = candidate;
      break;
    }
  }
  if (!workloadCode) throw new Error("Could not allocate a unique workload code. Try again.");
  const worker: WorkloadWorkerRecord = {
    workerId: crypto.randomUUID(),
    workspaceId: enrollment.workspaceId,
    ownerTelegramUserId: enrollment.ownerTelegramUserId,
    workerName,
    workloadCode,
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
    metadata: { version: worker.workerVersion, capabilities: worker.capabilities, workerName: worker.workerName, workloadCode: worker.workloadCode },
  });
  return {
    workerId: worker.workerId,
    workerName: worker.workerName,
    workloadCode: worker.workloadCode,
    displayKey: worker.displayKey,
    credential,
    heartbeatIntervalMs: WORKLOAD_HEARTBEAT_INTERVAL_MS,
    controlVersion: WORKLOAD_CONTROL_VERSION,
    workspaceId: worker.workspaceId,
  };
}

export async function authenticateWorkloadWorker(
  credential: string,
  options: { allowDisabled?: boolean } = {},
): Promise<AuthenticatedWorkloadWorker> {
  if (!credential || credential.length < 32) throw new Error("Missing workload credential.");
  const worker = await getWorkloadWorkerByCredentialHash(hashCredential(credential));
  if (!worker) throw new Error("Workload worker authentication failed.");
  if (worker.status === "REVOKED" || (worker.status === "DISABLED" && options.allowDisabled !== true))
    throw new Error(`Workload worker is ${worker.status.toLowerCase()}.`);
  return { worker, credential };
}

export async function recordWorkloadSessionStatus(
  workerId: string,
  input: { workspaceId: string; sessionId: string; status: "PAIRING" | "ACTIVE" | "RECONNECTING" | "DEGRADED" | "ERROR" | "LOGGED_OUT"; authHealth?: "UNKNOWN" | "VALID" | "INVALID" | "DEGRADED"; phoneNumber?: string; reason?: string },
): Promise<void> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const assignment = await getAuthorizedWorkloadAssignment(workerId, input.sessionId);
  if (assignment.workspaceId !== input.workspaceId) throw new Error("Workload session workspace mismatch.");
  updateSession(input.workspaceId, input.sessionId, {
    status: input.status,
    ...(input.authHealth ? { authHealth: input.authHealth } : {}),
    ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
    ...(input.reason ? { disconnectReason: input.reason.slice(0, 240) } : {}),
    ...(input.status === "ACTIVE" ? { connectedAt: Date.now(), lastHealthyAt: Date.now(), disconnectReason: undefined } : {}),
  });
  await updateWorkloadAssignment(assignment.assignmentId, {
    status: input.status === "ACTIVE" ? "RUNNING" : input.status === "ERROR" ? "ERROR" : input.status === "LOGGED_OUT" ? "OFFLINE" : "DEGRADED",
    ...(input.reason ? { lastError: input.reason.slice(0, 500) } : input.status === "ACTIVE" ? { lastError: undefined } : {}),
  });
  await appendWorkloadEvent({ workspaceId: input.workspaceId, workerId, sessionId: input.sessionId, kind: "worker.status", metadata: { status: input.status, authHealth: input.authHealth } });
  if (input.status === "LOGGED_OUT") {
    try {
      const { purgeWhatsAppSession } = await import("../whatsapp/session-manager.js");
      await purgeWhatsAppSession(input.workspaceId, input.sessionId);
    } catch (error) {
      // The periodic control-plane cleanup remains the retry path if Mongo,
      // Redis, or the panel is unavailable during this status callback.
      console.error(
        `[pappy-omega-mini] logged-out workload session cleanup deferred session=${input.sessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export interface WorkloadLoggerSnapshot {
  worker: WorkloadWorkerRecord;
  connectionCount: number;
  timeoutCount: number;
  errorCount: number;
  lastConnectedAt?: number;
  lastTimeoutAt?: number;
  events: Array<{ at: number; state: string; detail?: string | undefined }>;
}

export async function getWorkloadLoggerSnapshot(
  workspaceId: string,
  workerId: string,
): Promise<WorkloadLoggerSnapshot> {
  const cacheKey = `${workspaceId}:${workerId}`;
  const cached = workloadLoggerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.workspaceId !== workspaceId) throw new Error("Workload worker not found.");
  const records = (await listWorkloadEvents(workspaceId, 300))
    .filter((event) => event.workerId === workerId);
  const statusEvents = records.filter((event) => event.kind === "worker.status");
  const status = (event: WorkloadEventRecord): string => {
    const value = event.metadata && typeof event.metadata === "object" ? (event.metadata as Record<string, unknown>).status : undefined;
    return typeof value === "string" ? value : event.kind;
  };
  const reason = (event: WorkloadEventRecord): string | undefined => {
    const value = event.metadata && typeof event.metadata === "object" ? (event.metadata as Record<string, unknown>).reason : undefined;
    return typeof value === "string" ? value.slice(0, 180) : undefined;
  };
  const connected = statusEvents.filter((event) => ["CONNECTED", "RECOVERED"].includes(status(event)));
  const timeouts = statusEvents.filter((event) => ["UNREACHABLE"].includes(status(event)) || reason(event) === "heartbeat-timeout");
  const errors = statusEvents.filter((event) => ["ERROR", "DEGRADED", "LOGGED_OUT"].includes(status(event)));
  const snapshot: WorkloadLoggerSnapshot = {
    worker,
    connectionCount: connected.length,
    timeoutCount: timeouts.length,
    errorCount: errors.length,
    ...(connected[0]?.createdAt ? { lastConnectedAt: connected[0].createdAt } : {}),
    ...(timeouts[0]?.createdAt ? { lastTimeoutAt: timeouts[0].createdAt } : {}),
    events: statusEvents.slice(0, 16).map((event) => ({ at: event.createdAt, state: status(event), ...(reason(event) ? { detail: reason(event) } : {}) })),
  };
  workloadLoggerCache.set(cacheKey, { expiresAt: Date.now() + WORKLOAD_UI_CACHE_MS, snapshot });
  return snapshot;
}

export async function recordWorkloadHeartbeat(
  credential: string,
  input: WorkloadHeartbeatRequest,
): Promise<WorkloadWorkerRecord> {
  const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
  if (input.workerVersion < env.WORKLOAD_MIN_WORKER_VERSION)
    throw new Error(`Worker version ${input.workerVersion} is incompatible.`);
  // A panel may be enrolled or assigned after the control process starts. Merge
  // those persisted records before filtering durable assignments, otherwise a
  // healthy external session can be treated as historical and dropped.
  await refreshSessionRegistry();
  const now = Date.now();
  const previousStatus = worker.status;
  const activeSharedWorkspaceIds = new Set(
    (await listWorkloadSharesForWorker(worker.workerId))
      .filter((share) => share.status === "ACTIVE" && share.recipientWorkspaceId)
      .map((share) => share.recipientWorkspaceId!),
  );
  const durableAssignments = (await listWorkloadAssignmentsForWorker(worker.workerId))
    .filter((assignment) => {
      if (assignment.workerId !== worker.workerId || !["ASSIGNED", "RUNNING", "DEGRADED", "OFFLINE"].includes(assignment.status)) return false;
      if (assignment.workspaceId !== worker.workspaceId && !activeSharedWorkspaceIds.has(assignment.workspaceId)) return false;
      try {
        const session = getSession(assignment.workspaceId, assignment.sessionId);
        return session.status !== "LOGGED_OUT" && session.authHealth !== "INVALID";
      } catch {
        // Historical assignments can outlive a purged session. They must not
        // prevent the worker heartbeat or hide every other valid session.
        return false;
      }
    });
  for (const assignment of durableAssignments) {
    if (assignment.status === "OFFLINE" || assignment.status === "DEGRADED")
      await updateWorkloadAssignment(assignment.assignmentId, { status: "ASSIGNED", lastError: undefined });
    if (input.status === "ACTIVE") {
      try {
        const session = getSession(assignment.workspaceId, assignment.sessionId);
        if (session.status === "ACTIVE" && session.authHealth === "VALID")
          updateSession(assignment.workspaceId, assignment.sessionId, { lastHealthyAt: now });
      } catch {
        // The assignment filter above already excludes records purged between
        // the snapshot and this heartbeat.
      }
    }
  }
  const durableSessionIds = durableAssignments.map((assignment) => assignment.sessionId);
  const authorizedSessionIds = new Set(durableSessionIds);
  const assignedSessionIds = [...new Set([
    ...input.assignedSessionIds.filter((sessionId) => authorizedSessionIds.has(sessionId)),
    ...durableSessionIds,
  ])].slice(0, 100);
  const paused = worker.status === "DISABLED";
  const next = await updateWorkloadWorker(worker.workerId, {
    status: paused ? "DISABLED" : input.status === "ERROR" ? "ERROR" : "ACTIVE",
    workerVersion: input.workerVersion,
    capabilities: [...new Set(input.capabilities)].slice(0, 50),
    assignedSessionIds,
    lastHeartbeatAt: now,
    connectedAt: worker.connectedAt ?? now,
    ...(input.lastError ? { lastError: input.lastError.slice(0, 500) } : { lastError: undefined }),
  });
  if (!next) throw new Error("Workload worker no longer exists.");
  if (next.status === "ACTIVE") {
    const state = previousStatus === "UNREACHABLE" || previousStatus === "OFFLINE" ? "RECOVERED" : "CONNECTED";
    if (previousStatus !== "ACTIVE") {
      notifyWorkloadOwner(next, state);
      await appendWorkloadEvent({ workspaceId: next.workspaceId, workerId: next.workerId, kind: "worker.status", metadata: { status: state, authHealth: "VALID" } });
    }
  } else if (next.status === "ERROR") {
    notifyWorkloadOwner(next, "ERROR", input.lastError);
    if (previousStatus !== "ERROR") await appendWorkloadEvent({ workspaceId: next.workspaceId, workerId: next.workerId, kind: "worker.status", metadata: { status: "ERROR", reason: input.lastError } });
  }
  if (!paused) {
    for (const sessionId of next.assignedSessionIds) {
      const assignment = await getWorkloadAssignmentBySession(sessionId);
      if (assignment && assignment.workerId === next.workerId && assignment.status === "OFFLINE")
        await updateWorkloadAssignment(assignment.assignmentId, { status: "RUNNING" });
    }
  }
  await appendWorkloadEvent({
    workspaceId: next.workspaceId,
    workerId: next.workerId,
    kind: "worker.heartbeat",
    metadata: { status: next.status, assignedSessionCount: next.assignedSessionIds.length },
  });
  return next;
}

export async function isWorkloadWorkerAuthorizedForWorkspace(
  workerId: string,
  workspaceId: string,
): Promise<boolean> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker || worker.status === "REVOKED") return false;
  if (worker.workspaceId === workspaceId) return true;
  const shares = await listWorkloadSharesForWorker(workerId);
  return shares.some((share) => share.status === "ACTIVE" && share.recipientWorkspaceId === workspaceId);
}

export async function assignWorkloadSession(
  workspaceId: string,
  sessionId: string,
  workerId: string,
): Promise<WorkloadAssignmentRecord> {
  const session = getSession(workspaceId, sessionId);
  if (!session || session.workspaceId !== workspaceId) throw new Error("Session is not in this workspace.");
  const worker = await getWorkloadWorker(workerId);
  if (!worker || !(await isWorkloadWorkerAuthorizedForWorkspace(workerId, workspaceId))) throw new Error("Worker is not shared with this workspace.");
  if (worker.workspaceId === workspaceId && await getWorkspaceWorkloadMode(workspaceId) === "OFF") throw new Error("Admin Workload is OFF; new external-panel assignments are disabled.");
  if (!isWorkloadWorkerReady(worker)) throw new Error("Worker must be ACTIVE, compatible, and have a fresh heartbeat before assignment.");
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
  const persistedSession = updateSession(workspaceId, sessionId, {
    workloadWorkerId: workerId,
    workerNodeId: workerId,
  });
  await persistSession(persistedSession);
  await appendWorkloadEvent({
    workspaceId,
    workerId,
    sessionId,
    kind: "assignment.created",
    metadata: { assignmentId: assignment.assignmentId },
  });
  return assignment;
}

export async function revokeWorkloadSessionAssignment(
  workspaceId: string,
  sessionId: string,
  reason = "Session purged.",
): Promise<void> {
  const assignment = await getWorkloadAssignmentBySession(sessionId);
  if (!assignment || assignment.workspaceId !== workspaceId) return;
  await updateWorkloadAssignment(assignment.assignmentId, {
    status: "REVOKED",
    lastError: reason.slice(0, 500),
  });
  const worker = await getWorkloadWorker(assignment.workerId);
  if (worker) {
    await updateWorkloadWorker(assignment.workerId, {
      assignedSessionIds: worker.assignedSessionIds.filter((id) => id !== sessionId),
    });
  }
  await appendWorkloadEvent({
    workspaceId,
    workerId: assignment.workerId,
    sessionId,
    kind: "assignment.revoked",
    metadata: { reason },
  });
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
  const worker = await getWorkloadWorker(assignment.workerId);
  if (!worker || ["DISABLED", "REVOKED", "OFFLINE", "UNREACHABLE", "ERROR"].includes(worker.status))
    throw new Error("Workload traffic is paused or the panel is not reachable.");
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
  notifyWorkloadCommandWaiters(assignment.workerId);
  return record;
}

export async function pollWorkloadCommands(
  credential: string,
  limit = 10,
  waitMs = 20_000,
): Promise<WorkloadCommandRecord[]> {
  const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
  const paused = worker.status === "DISABLED";
  await updateWorkloadWorker(worker.workerId, { lastHeartbeatAt: Date.now(), status: paused ? "DISABLED" : "ACTIVE" });
  if (paused) {
    await waitForWorkloadCommandSignal(worker.workerId, Math.min(Math.max(waitMs, 0), 5_000));
    return [];
  }
  await expireStaleWorkloadCommands(worker.workerId);
  await requeueStaleWorkloadCommands(worker.workerId);
  let commands = await leaseWorkloadCommands(worker.workerId, limit);
  if (commands.length || waitMs <= 0) return commands;
  await waitForWorkloadCommandSignal(worker.workerId, waitMs);
  await expireStaleWorkloadCommands(worker.workerId);
  await requeueStaleWorkloadCommands(worker.workerId);
  commands = await leaseWorkloadCommands(worker.workerId, limit);
  return commands;
}

export async function completeWorkloadCommand(
  credential: string,
  input: { commandId: string; requestId: string; ok: boolean; result?: unknown; error?: string },
): Promise<WorkloadCommandRecord> {
  const { worker } = await authenticateWorkloadWorker(credential, { allowDisabled: true });
  const command = await getWorkloadCommand(input.commandId);
  if (!command || command.workerId !== worker.workerId || command.requestId !== input.requestId)
    throw new Error("Command is not owned by this worker.");
  const completed = await persistWorkloadCommandCompletion({
    ...command,
    ...input,
  } as WorkloadCommandRecord & { ok: boolean });
  if (!completed) throw new Error("Command was already completed, expired, or not leased.");
  notifyWorkloadCommandCompletion(completed.commandId);
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
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) break;
    await waitForWorkloadCommandCompletionSignal(commandId, remaining);
  }
  throw new Error("Assigned workload worker did not respond before the control timeout.");
}

export async function setWorkloadMode(
  workspaceId: string,
  mode: "ON" | "OFF",
): Promise<void> {
  // Admin Workload is a global VPS policy. Persist it before rendering the
  // result so every user workspace reads the same authoritative value.
  await setGlobalWorkloadMode(mode);
  updateWorkspaceWorkloadMode(workspaceId, mode);
}

export async function disconnectWorkloadWorker(workerId: string): Promise<WorkloadWorkerRecord> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const updated = await updateWorkloadWorker(workerId, { status: "OFFLINE", lastError: "Graceful disconnect." });
  if (!updated) throw new Error("Workload worker could not be disconnected.");
  notifyWorkloadOwner(updated, "OFFLINE", "Graceful disconnect.");
  for (const assignment of (await listWorkloadAssignmentsForWorker(workerId)).filter((item) => item.status !== "REVOKED"))
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
    const updated = await updateWorkloadWorker(worker.workerId, { status: "UNREACHABLE", lastError: "Heartbeat timeout." });
    if (updated) notifyWorkloadOwner(updated, "UNREACHABLE", "Heartbeat timeout.");
    const assignments = await listWorkloadAssignmentsForWorker(worker.workerId);
    for (const assignment of assignments.filter((item) => item.workerId === worker.workerId && item.status !== "REVOKED")) {
      await updateWorkloadAssignment(assignment.assignmentId, { status: "OFFLINE", lastError: "Worker heartbeat timeout." });
      try {
        const session = getSession(assignment.workspaceId, assignment.sessionId);
        if (session.status !== "LOGGED_OUT" && session.status !== "BANNED") {
          updateSession(assignment.workspaceId, assignment.sessionId, {
            status: "DEGRADED",
            authHealth: session.authHealth === "INVALID" ? "INVALID" : "DEGRADED",
            disconnectReason: "Panel heartbeat timeout; panel is offline. Session data is retained for recovery.",
          });
        }
      } catch {
        // The assignment remains auditable even if its durable session row was removed separately.
      }
    }
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
  return (await getGlobalWorkloadMode()) ?? getWorkspaceWorkloadMode(workspaceId);
}

export async function listWorkspaceWorkloadWorkers(workspaceId: string): Promise<WorkloadWorkerRecord[]> {
  const cached = workloadWorkerListCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.workers;
  await deleteRevokedWorkloadWorkers(workspaceId);
  const workers = await listWorkloadWorkers(workspaceId);
  workloadWorkerListCache.set(workspaceId, { expiresAt: Date.now() + WORKLOAD_UI_CACHE_MS, workers });
  return workers;
}

export async function getWorkspaceWorkloadWorkerByDisplayKey(
  workspaceId: string,
  displayKey: string,
): Promise<WorkloadWorkerRecord | undefined> {
  const worker = await getWorkloadWorkerByDisplayKey(displayKey.trim());
  return worker?.workspaceId === workspaceId ? worker : undefined;
}

export async function getWorkspaceWorkloadWorkerByCode(
  workspaceId: string,
  workloadCode: string,
): Promise<WorkloadWorkerRecord | undefined> {
  const worker = await getWorkloadWorkerByWorkloadCode(workloadCode.trim().toLowerCase());
  return worker?.workspaceId === workspaceId ? worker : undefined;
}

export async function getOwnerWorkloadWorkerByCode(
  ownerTelegramUserId: string,
  workloadCode: string,
): Promise<WorkloadWorkerRecord | undefined> {
  const worker = await getWorkloadWorkerByWorkloadCode(workloadCode.trim().toLowerCase());
  return worker?.ownerTelegramUserId === ownerTelegramUserId ? worker : undefined;
}

export async function getOwnerWorkloadWorkerByDisplayKey(
  ownerTelegramUserId: string,
  displayKey: string,
): Promise<WorkloadWorkerRecord | undefined> {
  const worker = await getWorkloadWorkerByDisplayKey(displayKey.trim());
  return worker?.ownerTelegramUserId === ownerTelegramUserId ? worker : undefined;
}

export async function revokeWorkloadWorker(workerId: string): Promise<WorkloadWorkerRecord> {
  const worker = await getWorkloadWorker(workerId);
  if (!worker) throw new Error("Workload worker not found.");
  const updated = await updateWorkloadWorker(workerId, { status: "REVOKED" });
  if (!updated) throw new Error("Workload worker could not be revoked.");
  for (const assignment of (await listWorkloadAssignmentsForWorker(workerId)).filter((item) => item.status !== "REVOKED")) {
    await updateWorkloadAssignment(assignment.assignmentId, { status: "REVOKED", lastError: "Workload worker removed." });
  }
  await appendWorkloadEvent({
    workspaceId: updated.workspaceId,
    workerId: updated.workerId,
    kind: "worker.revoked",
    metadata: { reason: "user-removed-key", deletedImmediately: true },
  });
  if (!(await deleteWorkloadWorker(workerId))) throw new Error("Workload worker could not be deleted after revocation.");
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
  const cancelledCommands = disabled
    ? await cancelWorkloadCommandsForWorker(workerId)
    : 0;
  await appendWorkloadEvent({
    workspaceId: updated.workspaceId,
    workerId: updated.workerId,
    kind: disabled ? "worker.disabled" : "worker.re-enabled",
    metadata: { status: updated.status, cancelledCommands },
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
