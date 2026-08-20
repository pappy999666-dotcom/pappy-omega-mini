export type JoinMode = "auto" | "immediate" | "request";

export interface JoinAttemptResult {
  success: boolean;
  jid?: string;
  title?: string;
  error?: string;
  alreadyMember?: boolean;
  requestRequired?: boolean;
  rateLimited?: boolean;
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

function isRateLimited(error: string): boolean {
  return /rate.?limit|too many requests|\b429\b|flood|throttl|temporarily banned|try again later|spam.?limit/i.test(error);
}

export async function joinWhatsAppInvite(
  socket: JoinSocket,
  target: string,
  options: { mode?: JoinMode } = {},
): Promise<JoinAttemptResult> {
  const trimmed = target.trim();
  try {
    const groups = (await socket.groupFetchAllParticipating?.()) ?? {};
    if (trimmed.endsWith("@g.us") && groups[trimmed])
      return {
        success: false,
        jid: trimmed,
        alreadyMember: true,
        error: "Already a member.",
      };

    const code = inviteCode(trimmed);
    if (!code)
      return { success: false, error: "Invalid WhatsApp invite link." };
    const info = await socket.groupGetInviteInfo?.(code);
    if (!info?.id)
      return {
        success: false,
        error: "Group invite is dead or no longer available.",
      };
    if (groups[info.id])
      return {
        success: false,
        jid: info.id,
        ...(info.subject ? { title: info.subject } : {}),
        alreadyMember: true,
        error: "Already a member.",
      };

    if (options.mode === "request") {
      if (!socket.groupRequestJoin)
        throw new Error(
          "Request-to-join is not supported by the installed Baileys transport.",
        );
      await socket.groupRequestJoin(code);
      return {
        success: false,
        requestRequired: true,
        jid: info.id,
        ...(info.subject ? { title: info.subject } : {}),
        error: "Join request submitted.",
      };
    }
    if (!socket.groupAcceptInvite)
      throw new Error(
        "The connected Baileys transport does not support group invites.",
      );
    const joined = await socket.groupAcceptInvite(code);
    return {
      success: true,
      jid: joined || info.id,
      ...(info.subject ? { title: info.subject } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      requestRequired: isRequestRequired(message),
      rateLimited: isRateLimited(message),
      error: message,
    };
  }
}
