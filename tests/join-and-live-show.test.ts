import { describe, expect, it } from "vitest";
import { joinWhatsAppInvite } from "../src/jobs/join-operation.js";
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

describe("Live Show renderer", () => {
  it("renders the short code and operation counters", () => {
    const rendered = jobLiveText(job());
    expect(rendered).toContain("AB12CD34");
    expect(rendered).toContain("Already member");
    expect(rendered).toContain("Joined Alpha");
  });
});
