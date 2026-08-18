import { randomUUID } from "node:crypto";
import type { ErrorCode, SafeBotErrorShape } from "../types/v2.js";

const defaults: Record<
  ErrorCode,
  {
    userMessage: string;
    retryable: boolean;
    severity: SafeBotErrorShape["severity"];
  }
> = {
  USER_INPUT_ERROR: {
    userMessage: "Please check the values and try again.",
    retryable: false,
    severity: "info",
  },
  PERMISSION_DENIED: {
    userMessage: "You do not have permission to perform that action.",
    retryable: false,
    severity: "warning",
  },
  SESSION_NOT_READY: {
    userMessage: "The WhatsApp session is not ready yet.",
    retryable: true,
    severity: "info",
  },
  SESSION_LOGGED_OUT: {
    userMessage: "This session is logged out. Please pair it again.",
    retryable: false,
    severity: "warning",
  },
  SESSION_BANNED: {
    userMessage: "This session is blocked and cannot reconnect automatically.",
    retryable: false,
    severity: "error",
  },
  RATE_LIMITED: {
    userMessage:
      "That action is temporarily rate-limited. Please try again later.",
    retryable: true,
    severity: "warning",
  },
  NETWORK_TRANSIENT: {
    userMessage:
      "A temporary network issue occurred. The session was preserved.",
    retryable: true,
    severity: "warning",
  },
  PLATFORM_REJECTED: {
    userMessage: "The platform rejected that operation.",
    retryable: false,
    severity: "warning",
  },
  MEDIA_INVALID: {
    userMessage: "That media file is not supported or failed validation.",
    retryable: false,
    severity: "warning",
  },
  MEDIA_TOO_LARGE: {
    userMessage: "That media file is larger than the configured limit.",
    retryable: false,
    severity: "warning",
  },
  PREVIEW_FAILED: {
    userMessage:
      "The preview could not be loaded, so the message can continue without it.",
    retryable: true,
    severity: "info",
  },
  GROUP_NOT_FOUND: {
    userMessage: "The requested group could not be found.",
    retryable: false,
    severity: "info",
  },
  QUEUE_FULL: {
    userMessage: "The job queue is busy. Please retry shortly.",
    retryable: true,
    severity: "warning",
  },
  INTERNAL_ERROR: {
    userMessage:
      "An internal error occurred. Please provide the reference ID to support.",
    retryable: false,
    severity: "error",
  },
};

export function createSafeError(
  code: ErrorCode,
  diagnostic: unknown,
  overrides: Partial<
    Pick<SafeBotErrorShape, "userMessage" | "retryable" | "severity">
  > = {},
): SafeBotErrorShape {
  const fallback = defaults[code];
  return {
    code,
    userMessage: overrides.userMessage ?? fallback.userMessage,
    diagnostic:
      diagnostic instanceof Error ? diagnostic.message : String(diagnostic),
    retryable: overrides.retryable ?? fallback.retryable,
    severity: overrides.severity ?? fallback.severity,
    correlationId: randomUUID(),
  };
}

export function renderSafeError(error: SafeBotErrorShape): string {
  return `${error.userMessage}\n\nReference: ${error.correlationId}`;
}
