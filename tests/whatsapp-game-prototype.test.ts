import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gamePrototypeStateCount,
  resetGamePrototypeState,
  runGameAction,
  runGameCommand,
} from "../src/whatsapp/game-prototype.js";
import type { CommandContext } from "../src/whatsapp/command-registry.js";

function context(senderJid = "12345@s.whatsapp.net"): CommandContext {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    isOwner: true,
    senderJid,
    args: [],
  };
}

afterEach(() => {
  resetGamePrototypeState();
  vi.restoreAllMocks();
});

describe("WhatsApp rich-response game prototype", () => {
  it("builds a table dashboard with stable action IDs", () => {
    const reply = runGameAction(context(), "game");

    expect(reply.nativeTable?.headers).toEqual(["Metric", "Value"]);
    expect(reply.nativeTable?.rows).toEqual(
      expect.arrayContaining([
        ["Credits", "530"],
        ["Bet", "10"],
        ["Spins", "0"],
      ]),
    );
    expect(reply.nativeFlow).toEqual(
      expect.arrayContaining([
        { text: "Spin", id: "game:spin" },
        { text: "Balance", id: "game:balance" },
        { text: "Reset demo", id: "game:reset" },
      ]),
    );
    expect(reply.richResponse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Game Status" }),
      ]),
    );
  });

  it("updates credits and best win after a winning spin", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    const ctx = context();

    runGameAction(ctx, "game");
    const reply = runGameAction(ctx, "spin");

    expect(reply.nativeTable?.rows).toEqual(
      expect.arrayContaining([
        ["Credits", "620"],
        ["Best Win", "100"],
        ["Spins", "1"],
        ["Last result", "WIN +100"],
      ]),
    );
  });

  it("keeps state isolated between senders and supports command aliases", () => {
    const first = runGameCommand({ ...context(), args: ["balance"] });
    const second = runGameCommand({
      ...context("67890@s.whatsapp.net"),
      args: ["balance"],
    });

    expect(first.nativeTable?.rows).toContainEqual(["Credits", "530"]);
    expect(second.nativeTable?.rows).toContainEqual(["Credits", "530"]);
    expect(gamePrototypeStateCount()).toBe(2);
  });
});
