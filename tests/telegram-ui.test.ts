import { describe, expect, it } from "vitest";
import {
  adminJobsKeyboard,
  adminJobsText,
  dashboardKeyboard,
  globalBridgeKeyboard,
  pageText,
  sessionKeyboard,
  validatorLiveKeyboard,
} from "../src/telegram/ui.js";
import type { WhatsAppSession } from "../src/types/domain.js";

const session: WhatsAppSession = {
  sessionId: "session-1",
  workspaceId: "workspace-1",
  sessionName: "main",
  status: "ACTIVE",
  prefix: ".",
  sudoList: [],
  autoJoinEnabled: false,
};

function callbackData(keyboard: unknown): string[] {
  return JSON.stringify(keyboard).match(/callback_data[^,}]+/g) ?? [];
}

describe("Telegram UI authorization", () => {
  it("never renders the admin dashboard button to ordinary users", () => {
    expect(callbackData(dashboardKeyboard(false)).join(" ")).not.toContain(
      "admin:panel",
    );
    expect(callbackData(dashboardKeyboard(true)).join(" ")).toContain(
      "admin:panel",
    );
  });

  it("keeps Global Bridge on the user dashboard and session controls separate", () => {
    const dashboard = JSON.stringify(dashboardKeyboard(false));
    const globalBridge = JSON.stringify(globalBridgeKeyboard(2));
    expect(dashboard).toContain("bridge:global");
    expect(globalBridge).toContain("bridge:global:select");
    expect(dashboard).not.toContain("admin:bridge");
  });

  it("preserves primary, success, and danger button semantics", () => {
    const dashboard = JSON.stringify(dashboardKeyboard(true));
    expect(dashboard).toContain('"style":"success"');
    expect(dashboard).toContain('"style":"primary"');
    expect(JSON.stringify(globalBridgeKeyboard(1))).toContain(
      '"style":"danger"',
    );
  });

  it("uses native blockquote response framing", () => {
    expect(pageText("Status", "Ready")).toContain(
      "<blockquote>Ready</blockquote>",
    );
  });

  it("renders a real Admin Jobs control panel", () => {
    const jobs = [
      {
        jobId: "1234567890abcdef",
        kind: "allchat",
        workspaceId: "workspace-1",
        state: "RUNNING",
        progress: {
          completed: 3,
          total: 10,
          success: 3,
          failed: 0,
          skipped: 0,
          retrying: 0,
          rate: 1,
        },
        createdAt: Date.now(),
      },
    ];
    expect(adminJobsText(jobs)).toContain("Admin Jobs Control");
    expect(JSON.stringify(adminJobsKeyboard(jobs))).toContain(
      "admin:jobs:cancel:1234567890abcdef",
    );
    expect(adminJobsText(jobs)).not.toContain("Owner Verified");
  });

  it("keeps Validator Live Log off until explicitly enabled", () => {
    const off = JSON.stringify(validatorLiveKeyboard(false));
    const on = JSON.stringify(validatorLiveKeyboard(true));
    expect(off).toContain("bucket:live:on");
    expect(off).not.toContain("bucket:live:off");
    expect(on).toContain("bucket:live:off");
  });

  it("keeps the per-session sudo action owner-only", () => {
    expect(
      callbackData(sessionKeyboard(session, false)).join(" "),
    ).not.toContain("session:session-1:action:sudo");
    expect(callbackData(sessionKeyboard(session, true)).join(" ")).toContain(
      "session:session-1:action:sudo",
    );
  });
});
