import { createHash } from "node:crypto";
import { listSessions } from "../core/session-registry.js";
import type { WhatsAppSession } from "../types/domain.js";

const HEALTH_WINDOW_MS = 5 * 60 * 1000;

export function isHealthyWhatsAppSession(
  session: WhatsAppSession,
  now = Date.now(),
): boolean {
  if (session.status !== "ACTIVE") return false;
  if (session.authHealth === "INVALID") return false;
  const lastHealthy = session.lastHealthyAt ?? session.connectedAt;
  return !lastHealthy || now - lastHealthy <= HEALTH_WINDOW_MS;
}

export function selectHealthyWhatsAppSession(
  workspaceId: string,
  preferredSessionId?: string,
  affinityKey?: string,
): WhatsAppSession | undefined {
  const sessions = listSessions(workspaceId);
  const preferred = preferredSessionId
    ? sessions.find(
        (session) =>
          session.sessionId === preferredSessionId &&
          isHealthyWhatsAppSession(session),
      )
    : undefined;
  if (preferred) return preferred;
  const healthy = sessions
    .filter((session) => isHealthyWhatsAppSession(session))
    .sort((left, right) => score(right) - score(left));
  if (!healthy.length) return undefined;
  if (!affinityKey) return healthy[0];
  const digest = createHash("sha256").update(affinityKey).digest();
  const index = digest.readUInt32BE(0) % healthy.length;
  return healthy[index];
}

function score(session: WhatsAppSession): number {
  const auth =
    session.authHealth === "VALID"
      ? 1_000_000
      : session.authHealth === "DEGRADED"
        ? 100_000
        : 0;
  const healthyAt = session.lastHealthyAt ?? session.connectedAt ?? 0;
  const recentMessages = session.lastMessageReceivedAt ?? 0;
  const recentCommands = session.lastCommandProcessedAt ?? 0;
  return auth + healthyAt + recentMessages + recentCommands;
}
