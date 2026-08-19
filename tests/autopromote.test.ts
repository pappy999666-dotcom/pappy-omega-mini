import { describe, expect, it } from "vitest";
import {
  autoPromoteCommandKeyboard,
  autoPromoteConfirmKeyboard,
  autoPromoteDashboardKeyboard,
  autoPromoteDaysKeyboard,
  autoPromotePostsKeyboard,
  autoPromoteTimesKeyboard,
  autoPromoteGlobalTargetsKeyboard,
} from "../src/telegram/ui.js";
import {
  DEFAULT_AUTOPROMOTE_SLOT_TIMES,
  DEFAULT_AUTOPROMOTE_TIMEZONE,
  occurrenceId,
  slotsForTimesPerDay,
  validateAutoPromoteInput,
  zonedTimeToUtc,
} from "../src/autopromote/types.js";

describe("Auto Promote scheduling contracts", () => {
  it("uses the requested named daily slots for every times-per-day value", () => {
    expect(slotsForTimesPerDay(1)).toEqual(["evening"]);
    expect(slotsForTimesPerDay(2)).toEqual(["morning", "evening"]);
    expect(slotsForTimesPerDay(3)).toEqual(["morning", "afternoon", "evening"]);
    expect(slotsForTimesPerDay(4)).toEqual(["morning", "afternoon", "evening", "night"]);
    expect(slotsForTimesPerDay(5)).toEqual(["morning", "afternoon", "evening", "night", "lateNight"]);
  });

  it("rejects duration, daily frequency, and All Status X values outside the prompt bounds", () => {
    expect(() => validateAutoPromoteInput({ days: 1, timesPerDay: 1 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 31, timesPerDay: 1 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 2, timesPerDay: 0 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 2, timesPerDay: 6 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 2, timesPerDay: 1, allstatusxPostsPerGroup: 0 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 2, timesPerDay: 1, allstatusxPostsPerGroup: 11 })).toThrow();
    expect(() => validateAutoPromoteInput({ days: 7, timesPerDay: 3, allstatusxPostsPerGroup: 5 })).not.toThrow();
  });

  it("calculates an explicit Africa/Lagos occurrence instead of using server timezone", () => {
    const timestamp = zonedTimeToUtc("2026-08-20", DEFAULT_AUTOPROMOTE_SLOT_TIMES.evening, DEFAULT_AUTOPROMOTE_TIMEZONE);
    expect(new Date(timestamp).toISOString()).toBe("2026-08-20T18:00:00.000Z");
  });

  it("makes each config/date/slot/session occurrence unique and restart-safe", () => {
    expect(occurrenceId("cfg", "2026-08-20", "evening", "session-a")).toBe("cfg:2026-08-20:evening:session-a");
    expect(occurrenceId("cfg", "2026-08-20", "evening", "session-a")).not.toBe(occurrenceId("cfg", "2026-08-20", "evening", "session-b"));
  });

  it("exposes the complete guided Telegram creation controls", () => {
    const commandData = JSON.stringify(autoPromoteCommandKeyboard());
    const daysData = JSON.stringify(autoPromoteDaysKeyboard());
    const timesData = JSON.stringify(autoPromoteTimesKeyboard());
    const postsData = JSON.stringify(autoPromotePostsKeyboard());
    const confirmData = JSON.stringify(autoPromoteConfirmKeyboard());
    expect(commandData).toContain("allstatus");
    expect(commandData).toContain("allchat");
    expect(commandData).toContain("allstatusx");
    expect(daysData).toContain("autopromote:days:30");
    expect(timesData).toContain("autopromote:times:5");
    expect(postsData).toContain("autopromote:posts:10");
    expect(confirmData).toContain("autopromote:confirm");
    expect(JSON.stringify(autoPromoteDashboardKeyboard([]))).toContain("autopromote:new");
    const targetData = JSON.stringify(autoPromoteGlobalTargetsKeyboard([
      { sessionId: "s1", sessionName: "Main", status: "ACTIVE", authHealth: "HEALTHY", workspaceId: "w1", createdAt: 1, updatedAt: 1 } as never,
    ], new Set(["s1"])));
    expect(targetData).toContain("autopromote:global:toggle:s1");
    expect(targetData).toContain("autopromote:global:ready");
  });

});
