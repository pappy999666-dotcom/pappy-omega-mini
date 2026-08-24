import { describe, expect, it } from "vitest";
import { StableSelectionStore } from "../src/telegram/group-selection.js";

type Group = { jid: string; subject: string };

describe("stable Telegram group selections", () => {
  it.each([10, 100, 500, 1000])("binds each of %i rendered groups to its exact record", (count) => {
    const store = new StableSelectionStore<Group>(120_000);
    const namespace = "workspace/session";
    const groups = Array.from({ length: count }, (_, index) => ({
      jid: `group-${index}@g.us`,
      subject: `Group ${index}`,
    }));
    const tokens = groups.map((group) => store.issue(namespace, group, 1_000));

    expect(new Set(tokens).size).toBe(count);
    for (const [index, token] of tokens.entries()) {
      expect(store.resolve(namespace, token, 1_001)).toEqual(groups[index]);
    }
  });

  it("does not remap an expired button to a changed inventory index", () => {
    const store = new StableSelectionStore<Group>(100);
    const namespace = "workspace/session";
    const oldToken = store.issue(namespace, { jid: "old@g.us", subject: "Old" }, 1_000);
    store.issue(namespace, { jid: "new@g.us", subject: "New" }, 1_101);

    expect(store.resolve(namespace, oldToken, 1_101)).toBeUndefined();
  });
});
