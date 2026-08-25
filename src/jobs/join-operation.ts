import { createHash } from "node:crypto";

export type JoinMode = "auto" | "immediate" | "request";

export interface JoinAttemptResult {
  success: boolean;
  jid?: string;
  title?: string;
  error?: string;
  alreadyMember?: boolean;
  requestRequired?: boolean;
  rateLimited?: boolean;
  accountRestricted?: boolean;
  linkUnavailable?: boolean;
  groupFull?: boolean;
  stage?: "membership" | "invite-info" | "accept" | "request";
  statusCode?: number;
}

interface JoinSocket {
  groupFetchAllParticipating?: () => Promise<Record<string, unknown>>;
  groupGetInviteInfo?: (code: string) => Promise<{
    id?: string;
    subject?: string;
    size?: number;
    participantsCount?: number;
  }>;
  groupAcceptInvite?: (code: string) => Promise<string | undefined>;
  groupRequestJoin?: (code: string) => Promise<string | undefined>;
}

function inviteCode(target: string): string | undefined {
  const match = target.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  return (
    match?.[1] ??
    (target.trim() && !target.includes("@") ? target.trim() : undefined)
  );
}

function isRequestRequired(error: string): boolean {
  return /request.?to.?join|approval|required|membership_approval|pending/i.test(
    error,
  );
}

function normalizedError(error: string): string {
  return error.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}
function isRateLimited(error: string): boolean {
  const normalized = normalizedError(error);
  return /rate(?: over)? limit|too many requests|\b429\b|flood|throttl|temporarily banned|try again later|spam limit/i.test(normalized);
}

function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { statusCode?: unknown; output?: { statusCode?: unknown } };
  const value = candidate.statusCode ?? candidate.output?.statusCode;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isLinkUnavailable(error: string): boolean {
  return /invite.*(?:revoked|expired|invalid|not found|gone)|unknown invite|group.*(?:not found|does not exist)|not-authorized|group-invite-invalid|invite-link-revoked/i.test(error);
}

function isGroupFull(error: string): boolean {
  return /group[- ]?(?:is )?full|participant[- ]?limit|too many participants|group capacity/i.test(error);
}

function isAlreadyMember(error: string, statusCode?: number): boolean {
  return statusCode === 409 || /already[- ]?(?:exists|a participant|member)|participant already exists|is already in the group/i.test(error);
}

export function remixJoinRecords<T extends { canonicalUrl: string }>(
  records: readonly T[],
  seed: string,
  cycle: number,
): T[] {
  return records
    .map((record) => ({
      record,
      sortKey: createHash("sha256")
        .update(`${seed}:${cycle}:${record.canonicalUrl}`)
        .digest("hex"),
    }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map(({ record }) => record);
}

export function selectJoinInventoryRecords<T>(
  records: readonly T[],
  options: { fullInventory?: boolean; targetCount?: number } = {},
): T[] {
  if (options.fullInventory) return [...records];
  const requested = Number(options.targetCount ?? records.length);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(10000, Math.floor(requested))
    : records.length;
  return records.slice(0, limit);
}

export async function joinWhatsAppInvite(
  socket: JoinSocket,
  target: string,
  options: { mode?: JoinMode; participatingGroups?: Record<string, unknown> } = {},
): Promise<JoinAttemptResult> {
  const trimmed = target.trim();
  let stage: JoinAttemptResult["stage"] = "membership";
  let knownJid: string | undefined;
  let knownTitle: string | undefined;
  try {
    const groups = options.participatingGroups ?? (await socket.groupFetchAllParticipating?.()) ?? {};
    if (trimmed.endsWith("@g.us") && groups[trimmed])
      return {
        success: false,
        jid: trimmed,
        alreadyMember: true,
        error: "Already a member.",
      };

    const code = inviteCode(trimmed);
    if (!code)
      return { success: false, error: "Invalid WhatsApp invite link.", linkUnavailable: true, stage: "invite-info" };
    stage = "invite-info";
    const info = await socket.groupGetInviteInfo?.(code);
    knownJid = info?.id;
    knownTitle = info?.subject;
    if (!info?.id)
      return {
        success: false,
        error: "Group invite is dead or no longer available.",
        linkUnavailable: true,
        stage: "invite-info",
      };
    const membershipGroups = options.participatingGroups ?? (await socket.groupFetchAllParticipating?.()) ?? {};
    if (membershipGroups[info.id])
      return {
        success: false,
        jid: info.id,
        ...(info.subject ? { title: info.subject } : {}),
        alreadyMember: true,
        error: "Already a member.",
        stage: "membership",
      };

    if (options.mode === "request") {
      if (!socket.groupRequestJoin)
        throw new Error(
          "Request-to-join is not supported by the installed Baileys transport.",
        );
      stage = "request";
      await socket.groupRequestJoin(code);
      return {
        success: false,
        requestRequired: true,
        jid: info.id,
        ...(info.subject ? { title: info.subject } : {}),
        error: "Join request submitted.",
        stage: "request",
      };
    }
    if (!socket.groupAcceptInvite)
      throw new Error(
        "The connected Baileys transport does not support group invites.",
      );
    stage = "accept";
    const joined = await socket.groupAcceptInvite(code);
    return {
      success: true,
      jid: joined || info.id,
      ...(info.subject ? { title: info.subject } : {}),
      stage: "accept",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = statusCodeFromError(error);
    if (isAlreadyMember(message, statusCode)) {
      return {
        success: false,
        alreadyMember: true,
        ...(knownJid ? { jid: knownJid } : {}),
        ...(knownTitle ? { title: knownTitle } : {}),
        stage,
        error: "Already a member.",
      };
    }
    const normalized = normalizedError(message);
    const rateLimited = isRateLimited(message) || statusCode === 429;
    const accountRestricted = /spam limit|temporarily banned|account restricted|too many groups|rate over limit/i.test(normalized);
    return {
      success: false,
      requestRequired: isRequestRequired(message),
      rateLimited,
      accountRestricted,
      linkUnavailable: isLinkUnavailable(message),
      groupFull: isGroupFull(message),
      stage,
      ...(statusCode !== undefined ? { statusCode } : {}),
      error: message,
    };
  }
}
