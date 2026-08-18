import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import {
  loadAuditEvents,
  loadEmergencyState,
  persistAuditEvent,
  persistEmergencyState,
} from "../persistence/mongo.js";
import type {
  AuditEvent,
  EmergencyState,
  WorkspaceQuota,
} from "../types/v2.js";

const audits: AuditEvent[] = [];
const emergency: EmergencyState = {
  enabled: false,
  pauseMassSends: false,
  pauseJoins: false,
  pauseBroadcasts: false,
  pauseScheduler: false,
  disablePairing: false,
  updatedAt: 0,
  updatedBy: "",
};

const defaultQuota: WorkspaceQuota = {
  maxSessions: 5,
  maxScheduledJobs: 20,
  maxValidatorLinks: 500,
  maxJoinConcurrency: 2,
  maxBroadcastRecipients: 1000,
  maxMediaBytes: env.MAX_MEDIA_BYTES,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxMassOperationConcurrency: env.QUEUE_CONCURRENCY,
};

export function getWorkspaceQuota(): WorkspaceQuota {
  return { ...defaultQuota };
}

export function assertWithinQuota(
  usage: number,
  limit: number,
  label: string,
): void {
  if (usage >= limit) throw new Error(`Quota exceeded: ${label}.`);
}

export function recordAudit(
  input: Omit<AuditEvent, "correlationId" | "timestamp">,
): AuditEvent {
  const event: AuditEvent = {
    ...input,
    correlationId: randomUUID(),
    timestamp: Date.now(),
  };
  audits.push(event);
  if (audits.length > 10_000) audits.splice(0, audits.length - 10_000);
  void persistAuditEvent(event).catch(() => undefined);
  return event;
}

export function listAuditEvents(
  workspaceId: string,
  limit = 100,
): AuditEvent[] {
  return audits
    .filter((event) => event.workspaceId === workspaceId)
    .slice(-limit)
    .reverse();
}

export function getEmergencyState(): EmergencyState {
  return { ...emergency };
}

export function setEmergencyState(
  actorTelegramUserId: string,
  patch: Partial<Omit<EmergencyState, "updatedAt" | "updatedBy">>,
): EmergencyState {
  Object.assign(emergency, patch, {
    updatedAt: Date.now(),
    updatedBy: actorTelegramUserId,
  });
  void persistEmergencyState(emergency).catch(() => undefined);
  return getEmergencyState();
}

export async function hydrateControlPlane(): Promise<void> {
  const [persistedEmergency, persistedAudit] = await Promise.all([
    loadEmergencyState(),
    loadAuditEvents("__all__", 0).catch(() => []),
  ]);
  if (persistedEmergency) Object.assign(emergency, persistedEmergency);
  if (persistedAudit.length) audits.push(...persistedAudit);
}

export function assertOperationAllowed(
  operation: "massSend" | "join" | "broadcast" | "schedule" | "pairing",
): void {
  const blocked =
    operation === "massSend"
      ? emergency.pauseMassSends
      : operation === "join"
        ? emergency.pauseJoins
        : operation === "broadcast"
          ? emergency.pauseBroadcasts
          : operation === "schedule"
            ? emergency.pauseScheduler
            : operation === "pairing"
              ? emergency.disablePairing
              : false;
  if (emergency.enabled || blocked)
    throw new Error(`Emergency safe mode blocks ${operation}.`);
}
