export type ErrorCode =
  | "USER_INPUT_ERROR"
  | "PERMISSION_DENIED"
  | "SESSION_NOT_READY"
  | "SESSION_LOGGED_OUT"
  | "SESSION_BANNED"
  | "RATE_LIMITED"
  | "NETWORK_TRANSIENT"
  | "PLATFORM_REJECTED"
  | "MEDIA_INVALID"
  | "MEDIA_TOO_LARGE"
  | "PREVIEW_FAILED"
  | "GROUP_NOT_FOUND"
  | "QUEUE_FULL"
  | "INTERNAL_ERROR";

export interface SafeBotErrorShape {
  code: ErrorCode;
  userMessage: string;
  diagnostic: string;
  retryable: boolean;
  severity: "info" | "warning" | "error" | "critical";
  correlationId: string;
}

export interface AuditEvent {
  correlationId: string;
  actorTelegramUserId: string;
  workspaceId: string;
  sessionId?: string;
  action: string;
  success: boolean;
  reason?: string;
  metadata: Record<string, string | number | boolean>;
  timestamp: number;
}

export interface WorkspaceQuota {
  maxSessions: number;
  maxScheduledJobs: number;
  maxValidatorLinks: number;
  maxJoinConcurrency: number;
  maxBroadcastRecipients: number;
  maxMediaBytes: number;
  maxStorageBytes: number;
  maxMassOperationConcurrency: number;
}

export interface EmergencyState {
  enabled: boolean;
  pauseMassSends: boolean;
  pauseJoins: boolean;
  pauseBroadcasts: boolean;
  pauseScheduler: boolean;
  disablePairing: boolean;
  updatedAt: number;
  updatedBy: string;
}
