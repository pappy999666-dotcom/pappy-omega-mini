import { describe, expect, it } from "vitest";
import { isClosedGroupTransportError } from "../src/telegram/group-inventory-error.js";

describe("Telegram Groups inventory error handling", () => {
  it("classifies closed transport variants as recoverable session outages", () => {
    for (const value of [
      new Error("Connection Closed"),
      new Error("The WhatsApp session is not connected."),
      new Error("socket is closed"),
      new Error("websocket closed before response"),
    ]) {
      expect(isClosedGroupTransportError(value)).toBe(true);
    }
  });

  it("does not misclassify ordinary inventory failures", () => {
    expect(isClosedGroupTransportError(new Error("group inventory timed out"))).toBe(false);
    expect(isClosedGroupTransportError(new Error("unsupported capability"))).toBe(false);
    expect(isClosedGroupTransportError(undefined)).toBe(false);
  });
});
