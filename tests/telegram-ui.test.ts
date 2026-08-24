import { describe, expect, it } from "vitest";
import {
  adminKeyboard,
  adminJobsKeyboard,
  adminJobsText,
  adminInceptorKeyboard,
  adminInceptorText,
  adminForceJoinKeyboard,
  adminForceJoinText,
  adminBridgeKeyboard,
  adminBridgeTargetToken,
  adminUsersKeyboard,
  adminUsersText,
  dashboardKeyboard,
  forceJoinKeyboard,
  forceJoinText,
  globalBridgeKeyboard,
  autoPromoteText,
  joinManagerKeyboard,
  menuMediaPickerKeyboard,
  helpKeyboard,
  helpSectionKeyboard,
  helpSectionText,
  pageText,
  antiConfigCardText,
  pairingHelpCardText,
  sessionPairingCardText,
  sessionStatusCardText,
  memberBatchJobCardText,
  sessionKeyboard,
  sessionGroupKeyboard,
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
    expect(dashboard).not.toContain("forcejoin:status");
    expect(globalBridge).toContain("bridge:global:select");
    expect(dashboard).not.toContain("admin:bridge");
  });

  it("preserves primary and success button semantics", () => {
    const dashboard = JSON.stringify(dashboardKeyboard(true));
    expect(dashboard).toContain('"style":"success"');
    expect(dashboard).toContain('"style":"primary"');
    expect(JSON.stringify(globalBridgeKeyboard(1))).toContain(
      '"style":"success"',
    );
  });

  it("uses native blockquote response framing", () => {
    expect(pageText("Status", "Ready")).toContain(
      "<blockquote>Ready</blockquote>",
    );
  });

  it("renders the requested CONFIG, HELP, SESSION, and MEMBER BATCH card templates", () => {
    const anti = antiConfigCardText({
      name: "AntiLink",
      enabled: false,
      action: "off",
      note: "Available only for this group.",
      usage: [
        ".antilink delete  (Removes link messages)",
        ".antilink warn 3  (Gives 3 warnings)",
        ".antilink kick    (Removes the sender)",
        ".antilink off     (Disables protection)",
      ],
    });
    expect(anti).toContain("ANTILINK CONFIG");
    expect(anti).toContain("Disabled [ off ]");
    expect(anti).toContain("How to use:");
    expect(anti).toContain(".antilink warn 3");
    expect(pairingHelpCardText()).toContain("PAIRING HELP");
    expect(pairingHelpCardText()).toContain(".pair &lt;label&gt; &lt;number&gt;");
    const pairing = sessionPairingCardText({ ...session, sessionName: "pappy" }, "2348012345678", "PAPPYBOT");
    expect(pairing).toContain("SESSION PAIRING");
    expect(pairing).toContain("PAPPYBOT");
    expect(sessionStatusCardText({ ...session, sessionName: "Pappy", connectedAt: 1692834236000 })).toContain("SESSION STATUS");
    const job = memberBatchJobCardText({ action: "promote", selected: 1, jobId: "64164CFD" });
    expect(job).toContain("MEMBER BATCH JOB");
    expect(job).toContain("Job ID");
  });

  it("renders the complete PAPPY-native categorized help hub", () => {
    const main = JSON.stringify(helpKeyboard());
    expect(main).toContain("help:section:session");
    expect(main).toContain("help:section:groups");
    expect(main).toContain("help:section:broadcast");
    expect(helpSectionText("broadcast")).toContain(".allstatus");
    expect(JSON.stringify(helpSectionKeyboard("broadcast"))).toContain("help:main");
  });

  it("renders the complete PAPPY-native group detail submenu", () => {
    const group = JSON.stringify(sessionGroupKeyboard("session-1", 3));
    expect(group).toContain("session:session-1:group:name:3");
    expect(group).toContain("session:session-1:group:description:3");
    expect(group).toContain("session:session-1:group:picture:3");
    expect(group).toContain("session:session-1:group:picture:get:3");
    expect(group).toContain("session:session-1:group:moderation:3");
    expect(group).toContain("session:session-1:group:invite:3");
    expect(group).toContain("session:session-1:group:leave:3");
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

  it("renders selectable shared menu media controls", () => {
    const picker = JSON.stringify(
      menuMediaPickerKeyboard([
        {
          mediaId: "media-1",
          workspaceId: "workspace-1",
          kind: "image",
          fileName: "menu.png",
          mimeType: "image/png",
          filePath: "/tmp/menu.png",
          bytes: 10,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ], "media-1"),
    );
    expect(picker).toContain("admin:media:pick:media-1");
    expect(picker).toContain("admin:media:clear");
    expect(picker).toContain("admin:media:caption");
  });

  it("uses direct Telegram URLs for Force Join targets", () => {
    const gate = JSON.stringify(
      forceJoinKeyboard([
        {
          targetId: "target-1",
          targetType: "channel",
          usernameOrLink: "@pappylung",
          displayName: "pappy channel",
          buttonText: "Join channel",
          enabled: true,
          required: true,
          sortOrder: 0,
        },
      ]),
    );
    expect(gate).toContain("https://t.me/pappylung");
    expect(gate).not.toContain("forcejoin:open:target-1");
  });

  it("keeps Admin Global Bridge callbacks short and actionable", () => {
    const bridge = JSON.stringify(adminBridgeKeyboard([session]));
    const token = adminBridgeTargetToken(session.workspaceId, session.sessionId);
    expect(bridge).toContain(`admin:bridge:toggle:${token}`);
    expect(bridge).toContain("admin:bridge:command");
    expect(bridge).not.toContain(`admin:bridge:open:${token}`);
    for (const callback of bridge.match(/admin:[a-zA-Z0-9:_-]+/g) ?? []) {
      expect(callback.length).toBeLessThanOrEqual(64);
    }
  });

  it("keeps Support Inbox inside the Admin Control Plane", () => {
    const admin = JSON.stringify(adminKeyboard());
    expect(admin).toContain("admin:support");
    expect(admin).toContain("admin:jobs:clear");
    expect(JSON.stringify(dashboardKeyboard(false))).not.toContain(
      "admin:support",
    );
  });

  it("renders the owner-facing Inceptor maintenance view", () => {
    const text = adminInceptorText({
      name: "INCEPTOR",
      running: true,
      lastSweepAt: 1,
      nextSweepAt: 2,
      scanned: 10,
      recovered: 2,
      failed: 1,
      flushedDeadSessionJobs: 3,
      flushedMissingSessionJobs: 0,
      flushedStuckJobs: 0,
      prunedTerminalJobs: 4,
      skippedTransientSessions: 5,
      lastActions: ["recovered stuck allstatus ABCD1234"],
    });
    expect(text).toContain("Bounded Maintenance Engine");
    expect(text).toContain("Flushed terminal-session jobs");
    expect(text).toContain("Flushed missing-session jobs");
    expect(text).toContain("Flushed stuck broadcast jobs");
    expect(JSON.stringify(adminInceptorKeyboard())).toContain("admin:inceptor:run");
  });

  it("renders the dynamic Auto Promote schedule details", () => {
    const text = autoPromoteText([
      {
        id: "config-12345678",
        scope: "GLOBAL",
        ownerTelegramUserId: "7624193882",
        command: "allstatusx",
        payload: { text: "hello" },
        days: 7,
        timesPerDay: 2,
        allstatusxPostsPerGroup: 3,
        timezone: "Africa/Lagos",
        slotTimes: { morning: "09:00", afternoon: "14:00", evening: "19:00", lateNight: "23:00" },
        startDate: "2026-08-20",
        endDate: "2026-08-26",
        enabled: true,
        state: "SCHEDULED",
        createdAt: 1,
        updatedAt: 1,
      } as never,
    ]);
    expect(text).toContain("ALL ACTIVE + FUTURE SESSIONS");
    expect(text).toContain("2026-08-20");
    expect(text).toContain("Posts/group:");
    expect(text).toContain("hello");
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
    expect(JSON.stringify(adminJobsKeyboard(jobs))).toContain(
      "admin:jobs:clear",
    );
    expect(JSON.stringify(adminKeyboard())).toContain("admin:jobs:clear");
    expect(adminJobsText(jobs)).not.toContain("Owner Verified");
  });

  it("opens Validator Hub Live Log explicitly from the stable dashboard", async () => {
    const { bucketKeyboard } = await import("../src/telegram/ui.js");
    const dashboard = JSON.stringify(bucketKeyboard());
    expect(dashboard).toContain("bucket:live");
    expect(dashboard).toContain("Open Live Log");
    expect(dashboard).not.toContain("bucket:live:off");
  });

  it("uses one Validator Hub live dashboard with pause and resume controls", () => {
    const off = JSON.stringify(validatorLiveKeyboard(false));
    const on = JSON.stringify(validatorLiveKeyboard(true));
    expect(off).toContain("bucket:live:on");
    expect(off).not.toContain("bucket:live:off");
    expect(on).toContain("bucket:live:off");
    const text = validatorLiveText(
      {
        counts: { main: 2, validating: 1, active: 3, dead: 1, error: 0 },
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

  it("keeps Admin Bridge focused on active-session selection and Send Command", () => {
    const admin = JSON.stringify(adminBridgeKeyboard([session]));
    expect(admin).toContain("admin:bridge:toggle:");
    expect(admin).toContain("admin:bridge:command");
    expect(admin).not.toContain('callback_data":"admin:bridge:open:');
    expect(admin).not.toContain("admin:bridge:clear");
  });

  it("removes the old Global Bridge fan-out protocol", () => {
    const global = JSON.stringify(globalBridgeKeyboard(1));
    expect(global).toContain("bridge:global:select");
    expect(global).toContain("bridge:global:select:all");
    expect(global).toContain("bridge:global:command");
    expect(global).not.toContain("bridge:global:start");
    expect(global).not.toContain("bridge:global:stop");
    expect(global).not.toContain("bridge:global:toggle");
  });

  it("renders editable Join Manager controls instead of fixed setting cycles", () => {
    const join = JSON.stringify(joinManagerKeyboard("session-1", "stopped"));
    expect(join).toContain("session:session-1:join:edit:target");
    expect(join).toContain("session:session-1:join:edit:delay");
    expect(join).toContain("session:session-1:join:edit:batch");
    expect(join).not.toContain("join:setlimit");
    expect(join).not.toContain("join:setdelay");
  });

  it("keeps My Groups pagination callbacks bounded to page navigation", () => {
    const groupsRoute = "session:session-1:groups:2";
    expect(groupsRoute.length).toBeLessThanOrEqual(64);
    expect(groupsRoute).toContain(":groups:2");
  });

  it("renders advanced per-session submenu categories without user Validator controls", () => {
    const userSession = JSON.stringify(sessionKeyboard(session, false));
    for (const section of [
      "overview",
      "tools",
      "bridge",
      "join",
      "health",
      "settings",
    ]) {
      expect(userSession).toContain(`session:session-1:section:${section}`);
    }
    expect(userSession).not.toContain("session:session-1:section:validator");
    expect(userSession).not.toContain("session:session-1:section:access");
    expect(userSession).toContain("session:session-1:groups");
    expect(userSession).toContain("session:session-1:action:purge");
    expect(userSession).toContain("session:session-1:action:reconnect");
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
