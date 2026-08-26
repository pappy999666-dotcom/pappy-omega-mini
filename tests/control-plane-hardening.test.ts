import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  acceptRemoteBridgeRequestForTests,
  remoteBridgeResponsePrefixForTests,
  resetRemoteBridgeReplayForTests,
  signRemoteBridgeRequestForTests,
  validateRemoteBridgeRequestForTests,
  type RemoteBridgeSerializedMessage,
} from "../src/whatsapp/remote-bridge.js";
import { shouldAcceptWorkloadStatus } from "../src/workload/service.js";
import { shouldRecoverOutstandingJob } from "../src/jobs/job-orchestrator.js";

describe("internal bridge protocol hardening", () => {
  const message: RemoteBridgeSerializedMessage = {
    workspaceId: "workspace-test",
    sessionId: "session-test",
    senderJid: "12345@s.whatsapp.net",
    text: "ping",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    resetRemoteBridgeReplayForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function signedRequest(overrides: Partial<{
    requestId: string;
    responseKey: string;
    issuedAt: number;
    message: RemoteBridgeSerializedMessage;
  }> = {}) {
    const requestId = overrides.requestId ?? "request-1";
    const responseKey = overrides.responseKey ?? `${remoteBridgeResponsePrefixForTests()}${requestId}`;
    const issuedAt = overrides.issuedAt ?? Date.now();
    const requestMessage = overrides.message ?? message;
    return {
      requestId,
      responseKey,
      issuedAt,
      message: requestMessage,
      signature: signRemoteBridgeRequestForTests({ requestId, responseKey, issuedAt, message: requestMessage }),
    };
  }

  it("accepts a correctly signed current request", () => {
    expect(validateRemoteBridgeRequestForTests(signedRequest())).toBe(true);
  });

  it("rejects missing, tampered, expired, and foreign response-key requests", () => {
    const valid = signedRequest();
    const { signature: _signature, ...unsigned } = valid;
    expect(validateRemoteBridgeRequestForTests(unsigned)).toBe(false);
    expect(validateRemoteBridgeRequestForTests({ ...valid, message: { ...message, text: "tampered" } })).toBe(false);
    expect(validateRemoteBridgeRequestForTests({ ...valid, issuedAt: Date.now() - 60_001 })).toBe(false);
    expect(
      validateRemoteBridgeRequestForTests({
        ...valid,
        responseKey: "some-other-prefix:request-1",
      }),
    ).toBe(false);
  });

  it("accepts each request id once and rejects replay", () => {
    expect(acceptRemoteBridgeRequestForTests("request-once")).toBe(true);
    expect(acceptRemoteBridgeRequestForTests("request-once")).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(acceptRemoteBridgeRequestForTests("request-once")).toBe(true);
  });
});

describe("startup job recovery decisions", () => {
  const base = {
    state: "RUNNING" as const,
    bullExists: true,
    bullWaiting: false,
    bullActive: true,
    bullDelayed: false,
    heartbeatAge: 5_000,
    retryableBroadcastFailure: false,
  };

  it("does not duplicate a fresh active job", () => {
    expect(shouldRecoverOutstandingJob(base)).toBe(false);
  });

  it("recovers a missing queue entry", () => {
    expect(shouldRecoverOutstandingJob({ ...base, bullExists: false })).toBe(true);
  });

  it("recovers an inactive running job after the stale grace period", () => {
    expect(shouldRecoverOutstandingJob({ ...base, bullActive: false, heartbeatAge: 61_000 })).toBe(true);
  });

  it("recovers a retrying job with no active queue state", () => {
    expect(
      shouldRecoverOutstandingJob({ ...base, state: "RETRYING", bullActive: false }),
    ).toBe(true);
  });
});

describe("workload callback acceptance", () => {
  it("accepts legacy callbacks without a generation", () => {
    expect(shouldAcceptWorkloadStatus({ expectedGeneration: 4, eventAt: 200, currentEventAt: 100 })).toBe(true);
  });

  it("rejects callbacks from an old assignment generation", () => {
    expect(
      shouldAcceptWorkloadStatus({ expectedGeneration: 4, incomingGeneration: 3, eventAt: 200, currentEventAt: 100 }),
    ).toBe(false);
  });

  it("rejects an older event from the current generation", () => {
    expect(
      shouldAcceptWorkloadStatus({ expectedGeneration: 4, incomingGeneration: 4, eventAt: 99, currentEventAt: 100 }),
    ).toBe(false);
  });

  it("accepts a matching generation and newer event", () => {
    expect(
      shouldAcceptWorkloadStatus({ expectedGeneration: 4, incomingGeneration: 4, eventAt: 101, currentEventAt: 100 }),
    ).toBe(true);
  });
});
