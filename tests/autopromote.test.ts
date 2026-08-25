import { describe, expect, it } from "vitest";
import { isAutoPromoteWizardContinuation } from "../src/telegram/bot.js";
import {
  autoPromoteCommandKeyboard,
  autoPromoteConfirmKeyboard,
  autoPromoteDashboardKeyboard,
  autoPromoteDaysKeyboard,
  autoPromotePostsKeyboard,
  autoPromoteTimesKeyboard,
  autoPromoteGlobalTargetsKeyboard,
  autoPromoteScopeKeyboard,
} from "../src/telegram/ui.js";
import {
  DEFAULT_AUTOPROMOTE_SLOT_TIMES,
  DEFAULT_AUTOPROMOTE_TIMEZONE,
  occurrenceId,
  slotsForTimesPerDay,
  validateAutoPromoteInput,
  zonedTimeToUtc,
} from "../src/autopromote/types.js";
import { resolveTargetSessionIds } from "../src/autopromote/service.js";

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
    expect(commandData).toContain("allstatusd");
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
    const scopeData = JSON.stringify(autoPromoteScopeKeyboard(undefined, [
      { sessionId: "s1", sessionName: "Main", status: "ACTIVE", authHealth: "HEALTHY", workspaceId: "w1", createdAt: 1, updatedAt: 1 } as never,
    ]));
    expect(scopeData).toContain("autopromote:scope:SESSION:s1");
    expect(scopeData).toContain("autopromote:scope:USER");
    expect(isAutoPromoteWizardContinuation("autopromote:command:allstatus")).toBe(true);
    expect(isAutoPromoteWizardContinuation("autopromote:global:toggle:s1")).toBe(true);
    expect(isAutoPromoteWizardContinuation("admin:panel")).toBe(false);
  });

  it("enumerates live ACTIVE sessions even when persisted auth health is temporarily unknown", () => {
    const sessions = [
      { sessionId: "active", workspaceId: "w1", status: "ACTIVE", authHealth: "VALID" },
      { sessionId: "unknown", workspaceId: "w1", status: "ACTIVE", authHealth: "UNKNOWN" },
      { sessionId: "missing", workspaceId: "w1", status: "ACTIVE" },
      { sessionId: "invalid", workspaceId: "w1", status: "ACTIVE", authHealth: "INVALID" },
      { sessionId: "degraded", workspaceId: "w1", status: "DEGRADED", authHealth: "VALID" },
      { sessionId: "recovering", workspaceId: "w1", status: "RECONNECTING", authHealth: "VALID" },
      { sessionId: "logged-out", workspaceId: "w1", status: "LOGGED_OUT", authHealth: "VALID" },
    ] as never;
    const base = {
      id: "cfg",
      ownerTelegramUserId: "owner",
      command: "allstatus" as const,
      payload: { text: "hello" },
      days: 2,
      timesPerDay: 1,
      timezone: DEFAULT_AUTOPROMOTE_TIMEZONE,
      slotTimes: DEFAULT_AUTOPROMOTE_SLOT_TIMES,
      startDate: "2026-08-20",
      endDate: "2026-08-21",
      enabled: true,
      state: "SCHEDULED" as const,
      cooldownMinutes: 30,
      misfireGraceMinutes: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(resolveTargetSessionIds({ ...base, scope: "GLOBAL" }, sessions)).toEqual(["active", "unknown", "missing"]);
    expect(resolveTargetSessionIds({ ...base, scope: "GLOBAL", targetSessionIds: ["invalid", "degraded", "recovering", "active", "unknown"] }, sessions)).toEqual(["active", "unknown"]);
    expect(resolveTargetSessionIds({ ...base, scope: "SESSION", sessionId: "unknown" }, sessions)).toEqual(["unknown"]);
    expect(resolveTargetSessionIds({ ...base, scope: "SESSION", sessionId: "degraded" }, sessions)).toEqual([]);
  });

});
