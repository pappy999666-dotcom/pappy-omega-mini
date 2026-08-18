import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { env } from "../config/env.js";

const algorithm = "aes-256-gcm";

function key(): Buffer {
  return createHash("sha256")
    .update(env.ENCRYPTION_SECRET ?? "development-only-insecure-key")
    .digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptJson(value: string): unknown {
  const payload = Buffer.from(value, "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv(algorithm, key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      "utf8",
    ),
  );
}

export async function writeEncryptedJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encryptJson(value), { mode: 0o600 });
}

export async function readEncryptedJson(path: string): Promise<unknown> {
  return decryptJson(await readFile(path, "utf8"));
}

export async function removeEncryptedJson(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
