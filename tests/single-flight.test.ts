import { describe, expect, it } from "vitest";
import { SingleFlight } from "../src/telegram/single-flight.js";

describe("Telegram recovery single-flight", () => {
  it("shares one task for concurrent clicks on the same session", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const requests = Array.from({ length: 50 }, () =>
      flight.run("workspace:session", async () => {
        calls += 1;
        return gate;
      }),
    );
    expect(calls).toBe(0);
    expect(requests.filter((request) => request.shared)).toHaveLength(49);
    expect(flight.size()).toBe(1);
    release(1);
    expect(await Promise.all(requests.map((request) => request.promise))).toEqual(
      Array(50).fill(1),
    );
    expect(calls).toBe(1);
    expect(flight.size()).toBe(0);
  });

  it("allows a later recovery after the first task fails", async () => {
    const flight = new SingleFlight<boolean>();
    const first = flight.run("workspace:session", async () => {
      throw new Error("closed");
    });
    await expect(first.promise).rejects.toThrow("closed");
    expect(flight.size()).toBe(0);
    const second = flight.run("workspace:session", async () => true);
    expect(second.shared).toBe(false);
    await expect(second.promise).resolves.toBe(true);
  });
});
