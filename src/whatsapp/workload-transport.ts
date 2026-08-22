import type { WASocket } from "@crysnovax/baileys";
import { readFile } from "node:fs/promises";
import { getSession } from "../core/session-registry.js";
import { queueWorkloadCommand, waitForWorkloadCommand } from "../workload/service.js";

function encode(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __pappyBuffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

function decode(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.__pappyBuffer && typeof object.__pappyBuffer === "string") return Buffer.from(object.__pappyBuffer, "base64");
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decode(item)]));
  }
  if (Array.isArray(value)) return value.map(decode);
  return value;
}

export async function callAssignedWorkloadTransport(
  workspaceId: string,
  sessionId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const command = await queueWorkloadCommand(workspaceId, sessionId, "bridge.command", {
    method,
    args: encode(args),
  });
  const completed = await waitForWorkloadCommand(command.commandId);
  return decode(completed.result);
}

function remoteMethod(workspaceId: string, sessionId: string, method: string) {
  return async (...args: unknown[]) => callAssignedWorkloadTransport(workspaceId, sessionId, method, args);
}

function remotePreviewUpload(workspaceId: string, sessionId: string) {
  return async (filePath: string, options: unknown): Promise<unknown> => {
    const bytes = await readFile(filePath);
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new Error("Preview thumbnail upload exceeds the 8 MiB safety limit.");
    return callAssignedWorkloadTransport(workspaceId, sessionId, "previewUpload", [bytes, options]);
  };
}

export function isPanelAssignedSession(workspaceId: string, sessionId: string): boolean {
  return Boolean(getSession(workspaceId, sessionId).workloadWorkerId);
}

export function createAssignedWorkloadSocket(
  workspaceId: string,
  sessionId: string,
): WASocket {
  const methods = [
    "sendMessage",
    "sendStatus",
    "getStatusJidList",
    "sendGroupStatus",
    "updateProfileName",
    "updateProfileStatus",
    "updateProfilePicture",
    "removeProfilePicture",
    "profilePictureUrl",
    "groupCreate",
    "groupFetchAllParticipating",
    "listGroupSummaries",
    "groupInviteCode",
    "groupUpdateDescription",
    "groupUpdateSubject",
    "groupLeave",
    "groupMetadata",
    "groupGetInviteInfo",
    "groupAcceptInvite",
    "requestPairingCode",
  ];
  const target: Record<string, unknown> = {
    user: { id: "me" },
    ev: { on: () => undefined },
    __pappyAssignedWorkload: true,
    waUploadToServer: remotePreviewUpload(workspaceId, sessionId),
  };
  for (const method of methods) target[method] = remoteMethod(workspaceId, sessionId, method);
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return Reflect.get(current, property, receiver);
      if (property in current) return Reflect.get(current, property, receiver);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(property)) return undefined;
      return remoteMethod(workspaceId, sessionId, property);
    },
  }) as unknown as WASocket;
}
