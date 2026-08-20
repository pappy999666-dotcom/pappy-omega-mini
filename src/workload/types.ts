export type WorkloadMode = "ON" | "OFF";

export type WorkloadWorkerStatus =
  | "PENDING"
  | "CONNECTING"
  | "ACTIVE"
  | "UNREACHABLE"
  | "OFFLINE"
  | "ERROR"
  | "DISABLED"
  | "INCOMPATIBLE"
  | "REVOKED";

export type WorkloadAssignmentStatus =
  | "PENDING"
  | "ASSIGNED"
  | "RUNNING"
  | "DEGRADED"
  | "OFFLINE"
  | "ERROR"
  | "REVOKED";

export type WorkloadCommandKind =
  | "session.start"
  | "session.stop"
  | "session.pair.request"
  | "bridge.command";

export type WorkloadCommandStatus =
  | "QUEUED"
  | "LEASED"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED";

export interface WorkloadWorkerRecord {
  workerId: string;
  workspaceId: string;
  ownerTelegramUserId: string;
  displayKey: string;
  credentialHash: string;
  credentialIssuedAt: number;
  status: WorkloadWorkerStatus;
  workerVersion: string;
  capabilities: string[];
  assignedSessionIds: string[];
  lastHeartbeatAt?: number;
  connectedAt?: number;
  lastError?: string;
  disabledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkloadEnrollmentRecord {
  enrollmentId: string;
  workspaceId: string;
  ownerTelegramUserId: string;
  tokenHash: string;
  expiresAt: number;
  consumedAt?: number;
  createdAt: number;
}

export interface WorkloadAssignmentRecord {
  assignmentId: string;
  workspaceId: string;
  sessionId: string;
  workerId: string;
  status: WorkloadAssignmentStatus;
  assignedAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface WorkloadCommandRecord {
  commandId: string;
  assignmentId: string;
  workspaceId: string;
  sessionId: string;
  workerId: string;
  kind: WorkloadCommandKind;
  payload: Record<string, unknown>;
  status: WorkloadCommandStatus;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  leasedAt?: number;
  completedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export type WorkloadEventKind =
  | "worker.registered"
  | "worker.heartbeat"
  | "worker.status"
  | "worker.disabled"
  | "worker.re-enabled"
  | "worker.revoked"
  | "assignment.created"
  | "assignment.updated"
  | "command.completed"
  | "command.failed";

export interface WorkloadEventRecord {
  eventId: string;
  workspaceId: string;
  workerId?: string;
  sessionId?: string;
  kind: WorkloadEventKind;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface WorkloadRegistrationRequest {
  enrollmentToken: string;
  workerVersion: string;
  capabilities: string[];
}

export interface WorkloadRegistrationResponse {
  workerId: string;
  displayKey: string;
  credential: string;
  heartbeatIntervalMs: number;
  controlVersion: number;
}

export interface WorkloadHeartbeatRequest {
  workerVersion: string;
  capabilities: string[];
  status: WorkloadWorkerStatus;
  assignedSessionIds: string[];
  lastError?: string;
}

export interface WorkloadCommandResultRequest {
  commandId: string;
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
