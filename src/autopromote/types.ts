import type { JobMediaReference } from "../whatsapp/job-media-store.js";

export type AutoPromoteScope = "SESSION" | "USER" | "GLOBAL";
export type AutoPromoteCommand = "allstatus" | "allstatusd" | "allchat" | "allstatusx";
export type AutoPromoteState =
  | "SCHEDULED"
  | "QUEUED"
  | "WAITING_FOR_SESSION"
  | "RUNNING"
  | "COOLDOWN"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "PAUSED";
export type AutoPromoteRunStatus = AutoPromoteState;

export type AutoPromoteSlot =
  | "morning"
  | "afternoon"
  | "evening"
  | "night"
  | "lateNight";

export interface AutoPromotePayload {
  text?: string;
  media?: JobMediaReference;
  caption?: string;
  url?: string;
  quoted?: {
    messageId?: string;
    remoteJid?: string;
    text?: string;
  };
}

export interface AutoPromoteSlotTimes {
  morning: string;
  afternoon: string;
  evening: string;
  night: string;
  lateNight: string;
}

export interface AutoPromoteConfig {
  id: string;
  scope: AutoPromoteScope;
  ownerTelegramUserId: string;
  ownerWorkspaceId?: string;
  sessionId?: string;
  targetSessionIds?: string[];
  command: AutoPromoteCommand;
  payload: AutoPromotePayload;
  days: number;
  timesPerDay: number;
  allstatusxPostsPerGroup?: number;
  timezone: string;
  slotTimes: AutoPromoteSlotTimes;
  startDate: string;
  endDate: string;
  enabled: boolean;
  state: AutoPromoteState;
  cooldownMinutes: number;
  misfireGraceMinutes: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutoPromoteRun {
  id: string;
  configId: string;
  occurrenceId: string;
  scope: AutoPromoteScope;
  ownerTelegramUserId: string;
  sessionId: string;
  scheduledAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: AutoPromoteRunStatus;
  currentGroup?: string;
  totalGroups: number;
  completedGroups: number;
  failedGroups: number;
  currentRepetition: number;
  totalRepetitions: number;
  retryCount: number;
  successCount: number;
  cooldownUntil?: number;
  error?: string;
  jobId?: string;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_AUTOPROMOTE_TIMEZONE = "Africa/Lagos";
export const DEFAULT_AUTOPROMOTE_SLOT_TIMES: AutoPromoteSlotTimes = {
  morning: "09:00",
  afternoon: "14:00",
  evening: "19:00",
  night: "22:00",
  lateNight: "23:30",
};

export function slotsForTimesPerDay(timesPerDay: number): AutoPromoteSlot[] {
  switch (Math.max(1, Math.min(5, Math.floor(timesPerDay)))) {
    case 1:
      return ["evening"];
    case 2:
      return ["morning", "evening"];
    case 3:
      return ["morning", "afternoon", "evening"];
    case 4:
      return ["morning", "afternoon", "evening", "night"];
    default:
      return ["morning", "afternoon", "evening", "night", "lateNight"];
  }
}

export function validateAutoPromoteInput(input: {
  days: number;
  timesPerDay: number;
  allstatusxPostsPerGroup?: number;
}): void {
  if (!Number.isInteger(input.days) || input.days < 2 || input.days > 30)
    throw new Error("Auto Promote duration must be between 2 and 30 days.");
  if (
    !Number.isInteger(input.timesPerDay) ||
    input.timesPerDay < 1 ||
    input.timesPerDay > 5
  )
    throw new Error("Auto Promote times per day must be between 1 and 5.");
  if (
    input.allstatusxPostsPerGroup !== undefined &&
    (!Number.isInteger(input.allstatusxPostsPerGroup) ||
      input.allstatusxPostsPerGroup < 1 ||
      input.allstatusxPostsPerGroup > 10)
  )
    throw new Error("All Status X posts per group must be between 1 and 10.");
}

export function zonedTimeToUtc(
  date: string,
  time: string,
  timezone: string,
): number {
  const dateParts = date.split("-");
  const timeParts = time.split(":");
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  if (![year, month, day, hour, minute].every(Number.isFinite))
    throw new Error("Invalid Auto Promote schedule date or time.");
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return guess - (localAsUtc - guess);
}

export function occurrenceId(
  configId: string,
  date: string,
  slot: AutoPromoteSlot,
  sessionId: string,
): string {
  return `${configId}:${date}:${slot}:${sessionId}`;
}
