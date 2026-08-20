import { describe, expect, it } from "vitest";
import { formatBroadcastReadyMessage } from "../src/jobs/broadcast-format.js";

describe("broadcast READY formatter", () => {
  it.each(["allstatus", "allchat"] as const)(
    "renders real line breaks for %s",
    (kind) => {
      const rendered = formatBroadcastReadyMessage({
        kind,
        totalGroups: 25,
        expectedPosts: 25,
        delaySeconds: 20,
        expectedMinutes: 8,
        expectedSeconds: 0,
        jobCode: "9ADD871D",
      });
      expect(rendered).toContain("Total groups  · 25\nExpected posts · 25");
      expect(rendered).not.toContain("\\n");
      expect(rendered).toContain(
        kind === "allstatus"
          ? "Status delivery is now posting"
          : "Hidden-member mention delivery is now posting",
      );
    },
  );
});
