import { zonedTimeToUtc, occurrenceId, slotsForTimesPerDay } from "../../autopromote/types.js";

export interface AutopromoteComputeInput {
  configs: Array<{
    id: string;
    endDate: string;
    slotTimes: { morning: string; afternoon: string; evening: string; night: string; lateNight: string };
    startDate: string;
    days: number;
    timesPerDay: number;
    timezone: string;
    scope: "SESSION" | "USER" | "GLOBAL";
    sessionId?: string | undefined;
    targetSessionIds?: string[] | undefined;
    ownerTelegramUserId: string;
    ownerWorkspaceId?: string | undefined;
  }>;
  existingOccurrenceIds: string[];
  targetSessionIdsByConfig: Record<string, string[]>;
  now: number;
  horizon: number;
}

export interface AutopromoteOccurrenceToCreate {
  id: string;
  configId: string;
  sessionId: string;
  scheduledAt: number;
  occurrenceId: string;
}

export interface AutopromoteComputeResult {
  occurrencesToCreate: AutopromoteOccurrenceToCreate[];
  configIdsToEnd: string[];
}

/**
 * Pure CPU-bound computation: given autopromote configs and existing
 * occurrence ids, determine which new occurrences need to be created and which
 * configs have passed their end date. No I/O — safe to run in a worker thread.
 */
export function computeAutopromoteOccurrences(input: AutopromoteComputeInput): AutopromoteComputeResult {
  const { configs, existingOccurrenceIds, targetSessionIdsByConfig, now, horizon } = input;
  const existing = new Set(existingOccurrenceIds);
  const occurrencesToCreate: AutopromoteOccurrenceToCreate[] = [];
  const configIdsToEnd: string[] = [];

  for (const config of configs) {
    const sessions = targetSessionIdsByConfig[config.id] ?? [];
    if (!sessions.length) continue;

    if (now > zonedTimeToUtc(config.endDate, config.slotTimes.lateNight, config.timezone)) {
      configIdsToEnd.push(config.id);
      continue;
    }

    for (let day = 0; day < config.days; day += 1) {
      const date = addDays(config.startDate, day);
      if (zonedTimeToUtc(date, "00:00", config.timezone) > horizon) break;
      const slots = slotsForTimesPerDay(config.timesPerDay);
      for (const slot of slots) {
        const scheduledAt = zonedTimeToUtc(date, config.slotTimes[slot], config.timezone);
        if (scheduledAt > horizon) continue;
        for (const sessionId of sessions) {
          const id = occurrenceId(config.id, date, slot, sessionId);
          if (existing.has(id)) continue;
          occurrencesToCreate.push({
            id,
            configId: config.id,
            sessionId,
            scheduledAt,
            occurrenceId: id,
          });
        }
      }
    }
  }

  return { occurrencesToCreate, configIdsToEnd };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
