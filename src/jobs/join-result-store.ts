import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { JobRecord } from "./job-contracts.js";

export type JoinResultOutcome =
  | "JOINED"
  | "REQUESTED"
  | "ALREADY_JOINED"
  | "INVALID_LINK"
  | "LINK_EXPIRED"
  | "GROUP_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "WHATSAPP_RESTRICTED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "DEAD"
  | "RESTRICTED"
  | "TEMPORARY_ERROR"
  | "ERROR"
  | "UNKNOWN";

export interface JoinResultRecord {
  jobId: string;
  workspaceId: string;
  sessionId: string;
  canonicalUrl: string;
  cycle: number;
  outcome: JoinResultOutcome;
  retryCount: number;
  timestamp: number;
  jid?: string;
  title?: string;
  error?: string;
}

const PREFIX = "pappy-omega-mini:join-result:";

export class JoinResultStore {
  constructor(private readonly redis: Redis) {}

  async get(
    jobId: string,
    canonicalUrl: string,
    cycle: number,
  ): Promise<JoinResultRecord | undefined> {
    const value = await this.redis.get(this.key(jobId, canonicalUrl, cycle));
    return value ? (JSON.parse(value) as JoinResultRecord) : undefined;
  }

  async set(record: JoinResultRecord): Promise<void> {
    await this.redis.set(
      this.key(record.jobId, record.canonicalUrl, record.cycle),
      JSON.stringify(record),
    );
  }

  async listForJob(job: Pick<JobRecord, "jobId">): Promise<JoinResultRecord[]> {
    let cursor = "0";
    const records: JoinResultRecord[] = [];
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${PREFIX}${job.jobId}:*`,
        "COUNT",
        250,
      );
      cursor = next;
      if (keys.length) {
        const values = await this.redis.mget(...keys);
        for (const value of values) {
          if (value) records.push(JSON.parse(value) as JoinResultRecord);
        }
      }
    } while (cursor !== "0");
    return records.sort((a, b) => a.timestamp - b.timestamp);
  }

  async purgeJob(jobId: string): Promise<number> {
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${PREFIX}${jobId}:*`,
        "COUNT",
        250,
      );
      cursor = next;
      if (keys.length) removed += await this.redis.del(...keys);
    } while (cursor !== "0");
    return removed;
  }

  private key(jobId: string, canonicalUrl: string, cycle: number): string {
    const digest = createHash("sha256").update(canonicalUrl).digest("hex");
    return `${PREFIX}${jobId}:${cycle}:${digest}`;
  }
}

export function joinOutcomeFromClassification(
  classification: string,
): JoinResultOutcome {
  switch (classification) {
    case "joined":
      return "JOINED";
    case "request-required":
      return "REQUESTED";
    case "already-member":
      return "ALREADY_JOINED";
    case "invalid-invite":
      return "INVALID_LINK";
    case "dead-link":
    case "expired":
      return "LINK_EXPIRED";
    case "group-unavailable":
      return "GROUP_UNAVAILABLE";
    case "forbidden":
    case "permission-denied":
      return "PERMISSION_DENIED";
    case "rate-limit":
    case "restricted":
      return "WHATSAPP_RESTRICTED";
    case "timeout":
      return "TIMEOUT";
    case "transport":
    case "network-error":
    case "temporary-error":
      return "NETWORK_ERROR";
    case "failed":
    case "internal-error":
    case "error":
      return "INTERNAL_ERROR";
    default:
      return "UNKNOWN";
  }
}
