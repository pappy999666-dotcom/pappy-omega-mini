import { describe, expect, it } from "vitest";
import { dashboardKeyboard, sessionKeyboard } from "../src/telegram/ui.js";
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
      "admin:home",
    );
    expect(callbackData(dashboardKeyboard(true)).join(" ")).toContain(
      "admin:home",
    );
  });

  it("keeps the per-session sudo action owner-only", () => {
    expect(
      callbackData(sessionKeyboard(session, false)).join(" "),
    ).not.toContain("session:action:session-1:sudo");
    expect(callbackData(sessionKeyboard(session, true)).join(" ")).toContain(
      "session:action:session-1:sudo",
    );
  });
});
