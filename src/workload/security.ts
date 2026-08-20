import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const WORKLOAD_CONTROL_VERSION = 1;
export const WORKLOAD_HEARTBEAT_INTERVAL_MS = 20_000;
export const WORKLOAD_HEARTBEAT_TIMEOUT_MS = 75_000;
export const WORKLOAD_ENROLLMENT_TTL_MS = 15 * 60_000;

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createDisplayKey(): string {
  return String(randomBytes(4).readUInt32BE(0) % 100000).padStart(5, "0");
}

export function hashCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyCredential(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCredential(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createRequestId(): string {
  return createOpaqueToken(16);
}

export function isFreshRequest(createdAt: number, now = Date.now()): boolean {
  return Number.isFinite(createdAt) && Math.abs(now - createdAt) <= 90_000;
}
