import { describe, expect, it } from "vitest";
import { formatBroadcastReadyMessage } from "../src/jobs/broadcast-format.js";
import { createGroupStatusDesign } from "../src/whatsapp/status-design.js";
import { createCommandRegistry } from "../src/whatsapp/command-registry.js";

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


describe("styled group-status design", () => {
  it("keeps the URL while producing different group-aware designs", () => {
    const url = "https://example.com/post";
    const first = createGroupStatusDesign({ groupName: "Alpha", text: url, seed: "one" });
    const second = createGroupStatusDesign({ groupName: "Beta", text: url, seed: "two" });
    expect(first.text).toContain(url);
    expect(second.text).toContain(url);
    expect(first.text).toContain("Alpha");
    expect(second.text).toContain("Beta");
    expect(first.text !== second.text || first.backgroundColor !== second.backgroundColor).toBe(true);
    expect(first.backgroundColor).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("registers styled status commands separately from ordinary status commands", () => {
    const names = createCommandRegistry().map((command) => command.name);
    expect(names).toContain("gstatus");
    expect(names).toContain("dgstatus");
    expect(names).toContain("allstatus");
    expect(names).toContain("dallstatus");
  });
});
