import { describe, expect, it } from "vitest";
import {
  adminKeyboard,
  adminJobsKeyboard,
  adminJobsText,
  adminForceJoinKeyboard,
  adminForceJoinText,
  adminUsersKeyboard,
  adminUsersText,
  dashboardKeyboard,
  forceJoinKeyboard,
  forceJoinText,
  globalBridgeKeyboard,
  pageText,
  sessionKeyboard,
  validatorLiveKeyboard,
  validatorLiveText,
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

  it("renders real Force Join user and owner controls", () => {
    const targets = [
      {
        targetId: "target-1",
        targetType: "channel" as const,
        usernameOrLink: "@pappy_updates",
        displayName: "Pappy Updates",
        buttonText: "Join Updates",
        enabled: true,
        required: true,
        sortOrder: 1,
      },
    ];
    expect(forceJoinText(targets)).toContain("Check Membership");
    expect(JSON.stringify(forceJoinKeyboard(targets))).toContain(
      "forcejoin:check",
    );
    expect(adminForceJoinText(targets)).toContain(
      "Persistent Membership Policy",
    );
    expect(JSON.stringify(adminForceJoinKeyboard(targets))).toContain(
      "admin:forcejoin:toggle:target-1",
    );
  });

  it("keeps Support Inbox inside the Admin Control Plane", () => {
    const admin = JSON.stringify(adminKeyboard());
    expect(admin).toContain("admin:support");
    expect(JSON.stringify(dashboardKeyboard(false))).not.toContain(
      "admin:support",
    );
  });

  it("renders a real Admin Users directory", () => {
    const users = [
      {
        telegramUserId: "7624193882",
        username: "owner",
        displayName: "Owner",
        status: "active" as const,
        workspaceId: "workspace-1",
        lastSeenAt: Date.now(),
        sessionCount: 2,
      },
    ];
    expect(adminUsersText(users, 0)).toContain("Tenant Directory");
    expect(JSON.stringify(adminUsersKeyboard(users, 0))).toContain(
      "admin:user:ban:7624193882",
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

  it("uses one Validator Hub live dashboard with pause and resume controls", () => {
    const off = JSON.stringify(validatorLiveKeyboard(false));
    const on = JSON.stringify(validatorLiveKeyboard(true));
    expect(off).toContain("bucket:live:on");
    expect(off).not.toContain("bucket:live:off");
    expect(on).toContain("bucket:live:off");
    const text = validatorLiveText(
      {
        counts: { main: 2, active: 3, dead: 1, error: 0, master: 6 },
        recent: [
          { canonicalUrl: "https://chat.whatsapp.com/abc", bucket: "active" },
        ],
        capturedAt: Date.now(),
      },
      true,
      [
        {
          jobId: "validation-job-1",
          jobCode: "AB12CD34",
          state: "RUNNING",
          progress: {
            completed: 1,
            total: 4,
            success: 1,
            failed: 0,
            currentLink: "https://chat.whatsapp.com/xyz",
            currentAction: "validating",
          },
        },
      ],
    );
    expect(text).toContain("Validator Hub · Live");
    expect(text).toContain("AB12CD34");
    expect(text).toContain("Live validation workers");
  });

  it("renders advanced per-session submenu categories without placeholders", () => {
    const userSession = JSON.stringify(sessionKeyboard(session, false));
    for (const section of [
      "overview",
      "tools",
      "groups",
      "bridge",
      "validator",
      "join",
      "health",
      "settings",
    ]) {
      expect(userSession).toContain(`session:session-1:section:${section}`);
    }
    expect(userSession).not.toContain("session:session-1:section:access");
    expect(userSession).toContain("session:session-1:action:purge");
    expect(userSession).not.toContain("Coming soon");
    expect(userSession).not.toContain("placeholder");
  });

  it("keeps Access/Sudo owner-only while exposing purge to users", () => {
    const userSession = callbackData(sessionKeyboard(session, false)).join(" ");
    expect(userSession).not.toContain("session:session-1:section:access");
    expect(userSession).toContain("session:session-1:action:purge");
    expect(callbackData(sessionKeyboard(session, true)).join(" ")).toContain(
      "session:session-1:section:access",
    );
  });
});
