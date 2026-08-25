import { describe, expect, it } from "vitest";
import {
  joinWhatsAppInvite,
  remixJoinRecords,
  selectJoinInventoryRecords,
} from "../src/jobs/join-operation.js";
import { JoinResultStore } from "../src/jobs/join-result-store.js";
import { jobLiveText } from "../src/telegram/ui.js";
import type { JobRecord } from "../src/jobs/job-contracts.js";

function job(): JobRecord {
  return {
    jobId: "job-1",
    jobCode: "AB12CD34",
    idempotencyKey: "idempotent-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    kind: "join-manager",
    payload: {},
    state: "RUNNING",
    progress: {
      completed: 3,
      total: 10,
      success: 1,
      failed: 0,
      skipped: 2,
      retrying: 0,
      rate: 0.5,
      elapsedMs: 1000,
      joined: 1,
      alreadyMember: 2,
      requested: 0,
      deadLinks: 0,
      currentAction: "joined",
      currentGroup: "120@g.us",
      lastResult: "Joined Alpha",
    },
    attempts: 1,
    maxAttempts: 3,
    cancellationRequested: false,
    createdAt: Date.now(),
  };
}

describe("Baileys Join Operation", () => {
  it("joins a valid invite after checking metadata", async () => {
    const calls: string[] = [];
    const result = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({}),
        groupGetInviteInfo: async (code) => {
          calls.push(`info:${code}`);
          return { id: "120@g.us", subject: "Alpha" };
        },
        groupAcceptInvite: async (code) => {
          calls.push(`accept:${code}`);
          return "120@g.us";
        },
      },
      "https://chat.whatsapp.com/ABC_123",
    );
    expect(result).toMatchObject({
      success: true,
      jid: "120@g.us",
      title: "Alpha",
    });
    expect(calls).toEqual(["info:ABC_123", "accept:ABC_123"]);
  });

  it("returns already-member without accepting again", async () => {
    let accepted = false;
    const result = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({ "120@g.us": {} }),
        groupGetInviteInfo: async () => ({ id: "120@g.us", subject: "Alpha" }),
        groupAcceptInvite: async () => {
          accepted = true;
          return "120@g.us";
        },
      },
      "https://chat.whatsapp.com/ABC_123",
    );
    expect(result.alreadyMember).toBe(true);
    expect(accepted).toBe(false);
  });

  it("supports explicit request mode when the transport exposes it", async () => {
    const calls: string[] = [];
    const requested = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({}),
        groupGetInviteInfo: async () => ({ id: "120@g.us", subject: "Alpha" }),
        groupRequestJoin: async (code) => {
          calls.push(`request:${code}`);
          return "120@g.us";
        },
      },
      "https://chat.whatsapp.com/ABC_123",
      { mode: "request" },
    );
    expect(requested).toMatchObject({
      requestRequired: true,
      jid: "120@g.us",
      title: "Alpha",
    });
    expect(calls).toEqual(["request:ABC_123"]);
  });

  it("normalizes Baileys already-exists responses as already-member", async () => {
    const result = await joinWhatsAppInvite(
      {
        groupGetInviteInfo: async () => ({ id: "120@g.us", subject: "Alpha" }),
        groupAcceptInvite: async () => { throw new Error("already-exists"); },
      },
      "https://chat.whatsapp.com/ABC_123",
    );
    expect(result.alreadyMember).toBe(true);
    expect(result.error).toBe("Already a member.");
    expect(result.jid).toBe("120@g.us");
  });

  it("reuses a supplied membership snapshot without fetching participating groups", async () => {
    let membershipReads = 0;
    const result = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => {
          membershipReads += 1;
          return {};
        },
        groupGetInviteInfo: async () => ({ id: "120@g.us", subject: "Alpha" }),
        groupAcceptInvite: async () => "120@g.us",
      },
      "https://chat.whatsapp.com/ABC_123",
      { participatingGroups: {} },
    );
    expect(result.success).toBe(true);
    expect(membershipReads).toBe(0);
  });

  it("keeps the full Active inventory when full-inventory mode is enabled", () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      canonicalUrl: `https://chat.whatsapp.com/LINK_${index}`,
    }));
    const selected = selectJoinInventoryRecords(records, {
      fullInventory: true,
      targetCount: 1,
    });
    const remixed = remixJoinRecords(selected, "job-full", 0);
    expect(selected).toHaveLength(150);
    expect(remixed).toHaveLength(150);
    expect(new Set(remixed.map((record) => record.canonicalUrl)).size).toBe(150);
    expect(remixed.map((record) => record.canonicalUrl)).not.toEqual(
      records.map((record) => record.canonicalUrl),
    );
  });

  it("preserves an explicit finite target for single-link or bounded callers", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      canonicalUrl: `https://chat.whatsapp.com/LINK_${index}`,
    }));
    expect(selectJoinInventoryRecords(records, { targetCount: 3 })).toHaveLength(3);
    expect(selectJoinInventoryRecords(records, { fullInventory: true, targetCount: 3 })).toHaveLength(10);
  });

  it("remixes the same inventory between cycles deterministically", () => {
    const records = ["A", "B", "C", "D"].map((canonicalUrl) => ({ canonicalUrl }));
    const first = remixJoinRecords(records, "job-1", 0).map((record) => record.canonicalUrl);
    const second = remixJoinRecords(records, "job-1", 1).map((record) => record.canonicalUrl);
    expect(first).toHaveLength(records.length);
    expect(new Set(first)).toEqual(new Set(second));
    expect(second).not.toEqual(first);
    expect(remixJoinRecords(records, "job-1", 0).map((record) => record.canonicalUrl)).toEqual(first);
  });

  it("separates dead links, full groups, and account restrictions", async () => {
    const dead = await joinWhatsAppInvite(
      { groupGetInviteInfo: async () => { throw new Error("invite-link-revoked"); } },
      "https://chat.whatsapp.com/DEAD",
    );
    expect(dead.linkUnavailable).toBe(true);
    expect(dead.accountRestricted).toBe(false);

    const full = await joinWhatsAppInvite(
      {
        groupGetInviteInfo: async () => ({ id: "120@g.us" }),
        groupAcceptInvite: async () => { throw new Error("participant-limit reached"); },
      },
      "https://chat.whatsapp.com/FULL",
    );
    expect(full.groupFull).toBe(true);
    expect(full.accountRestricted).toBe(false);

    const endpointThrottle = await joinWhatsAppInvite(
      {
        groupGetInviteInfo: async () => ({ id: "120@g.us" }),
        groupAcceptInvite: async () => {
          throw new Error("invite endpoint rate limit; try again later");
        },
      },
      "https://chat.whatsapp.com/THROTTLED",
    );
    expect(endpointThrottle.rateLimited).toBe(true);
    expect(endpointThrottle.accountRestricted).toBe(false);

    const restricted = await joinWhatsAppInvite(
      {
        groupGetInviteInfo: async () => ({ id: "120@g.us" }),
        groupAcceptInvite: async () => { throw new Error("spam limit temporarily banned"); },
      },
      "https://chat.whatsapp.com/RESTRICTED",
    );
    expect(restricted.accountRestricted).toBe(true);
  });

  it("reports unsupported request mode honestly", async () => {
    const result = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({}),
        groupGetInviteInfo: async () => ({ id: "120@g.us" }),
      },
      "https://chat.whatsapp.com/ABC_123",
      { mode: "request" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Request-to-join is not supported");
  });

  it("classifies approval-required and dead invite responses", async () => {
    const requested = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({}),
        groupGetInviteInfo: async () => ({ id: "120@g.us" }),
        groupAcceptInvite: async () => {
          throw new Error("membership approval required");
        },
      },
      "https://chat.whatsapp.com/ABC_123",
    );
    expect(requested.requestRequired).toBe(true);

    const dead = await joinWhatsAppInvite(
      {
        groupFetchAllParticipating: async () => ({}),
        groupGetInviteInfo: async () => {
          throw new Error("invite revoked");
        },
      },
      "https://chat.whatsapp.com/DEAD",
    );
    expect(dead.success).toBe(false);
    expect(dead.error).toContain("invite revoked");
  });
});

describe("Join Result Store", () => {
  it("round-trips one result per job, link, and cycle", async () => {
    const values = new Map<string, string>();
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value);
        return "OK";
      },
    } as never;
    const store = new JoinResultStore(redis);
    await store.set({
      jobId: "job-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      canonicalUrl: "https://chat.whatsapp.com/ABC_123",
      cycle: 2,
      outcome: "JOINED",
      retryCount: 1,
      timestamp: 123,
      jid: "120@g.us",
      title: "Alpha",
    });
    await expect(
      store.get("job-1", "https://chat.whatsapp.com/ABC_123", 2),
    ).resolves.toMatchObject({ outcome: "JOINED", jid: "120@g.us" });
    await expect(
      store.get("job-1", "https://chat.whatsapp.com/ABC_123", 3),
    ).resolves.toBeUndefined();
  });
});

describe("Live Show renderer", () => {
  it("renders the short code and operation counters", () => {
    const rendered = jobLiveText(job());
    expect(rendered).toContain("AB12CD34");
    expect(rendered).toContain("Already member");
    expect(rendered).toContain("Joined Alpha");
  });

  it("renders Group Control action labels and worker lease metadata", () => {
    const control = job();
    control.kind = "group-control";
    control.workerId = "control-worker-1";
    control.leaseExpiresAt = Date.now() + 30_000;
    control.payload = { delayMs: 350 };
    control.progress.currentAction = "processing approve";
    const rendered = jobLiveText(control);
    expect(rendered).toContain("Next action");
    expect(rendered).toContain("control-worker-1");
    expect(rendered).toContain("Lease until");
  });

  it("renders the live cadence, remaining count, and next-post countdown", () => {
    const running = job();
    running.kind = "allstatus";
    running.payload = { delayMs: 20_000 };
    running.progress.nextActionAt = Date.now() + 5_000;
    const rendered = jobLiveText(running);
    expect(rendered).toContain("Next post");
    expect(rendered).toContain("Cadence");
    expect(rendered).toContain("20s/group");
    expect(rendered).toContain("remaining");
  });
});
