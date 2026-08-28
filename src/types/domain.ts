export type UserRole = "owner" | "admin" | "user";
export type SessionStatus =
  | "PAIRING"
  | "ACTIVE"
  | "DEGRADED"
  | "RECONNECTING"
  | "ERROR"
  | "FROZEN"
  | "LOGGED_OUT"
  | "BANNED";
export type MediaKind = "image" | "video";

export interface SessionJoinSettings {
  targetCount: number;
  delayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  batchCycles: number;
  maxConcurrency: number;
  retryLimit: number;
  retryBaseMs: number;
  sessionCooldownMs: number;
  restrictionThreshold: number;
  mode: "auto" | "immediate" | "request";
}

export interface Workspace {
  workspaceId: string;
  ownerTelegramUserId: string;
  /** Existing WhatsApp global sudo identities; retained for WhatsApp authorization. */
  globalSudoList: string[];
  /** Telegram users inherited by every session owned by this workspace user. */
  globalTelegramSudoIds: string[];
  /** Telegram users authorized across all sessions in the owner scope. */
  omniTelegramSudoIds: string[];
  /** Existing workspaces default to owner-VPS placement for zero-regression rollout. */
  workloadMode?: "ON" | "OFF";
  createdAt: number;
}

export interface User {
  telegramUserId: string;
  username?: string;
  displayName?: string;
  role: UserRole;
  status: "active" | "banned";
  workspaceId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface WhatsAppSession {
  sessionId: string;
  workspaceId: string;
  sessionName: string;
  phoneNumber?: string;
  status: SessionStatus;
  prefix: string;
  sudoList: string[];
  ignoredGroupLinks?: string[];
  autoJoinEnabled: boolean;
  joinSettings?: SessionJoinSettings;
  autoCollectLinks?: boolean;
  autoValidateLinks?: boolean;
  createdAt?: number;
  collectedLinkCount?: number;
  validatedLinkCount?: number;
  lastLinkCollectedAt?: number;
  lastLinkValidatedAt?: number;
  connectedAt?: number;
  lastHealthyAt?: number;
  lastMessageReceivedAt?: number;
  lastCommandProcessedAt?: number;
  lastOutboundMessageAt?: number;
  lastReconnectAt?: number;
  reconnectCount?: number;
  socketGeneration?: number;
  /** Monotonic in-process/persisted lifecycle observation sequence. */
  lifecycleVersion?: number;
  /** Event time used to reject delayed lifecycle callbacks. */
  lifecycleEventAt?: number;
  lifecycleSource?: "local" | "workload";
  authHealth?: "UNKNOWN" | "VALID" | "INVALID" | "DEGRADED";
  validatorRetiredUntil?: number;
  validatorRetireReason?: string;
  validatorFailureCount?: number;
  validatorRateLimitCount?: number;
  validatorConsecutiveRateLimitCount?: number;
  validatorLastSuccessAt?: number;
  workerNodeId?: string;
  /** Persisted external/owner worker assignment, if this session is panel-hosted. */
  workloadWorkerId?: string;
  lastError?: string | undefined;
  disconnectReason?: string | undefined;
}

export interface MenuMedia {
  mediaId: string;
  workspaceId: string;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  filePath: string;
  bytes: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MenuMediaSettings {
  workspaceId: string;
  whatsappMenuMediaId?: string;
  whatsappMenuCaption: string;
  updatedAt: number;
}

export interface Job {
  jobId: string;
  workspaceId: string;
  sessionId?: string;
  type: string;
  status: "queued" | "active" | "paused" | "completed" | "failed" | "cancelled";
  progress: number;
  attempts: number;
  createdAt: number;
  error?: string;
}
