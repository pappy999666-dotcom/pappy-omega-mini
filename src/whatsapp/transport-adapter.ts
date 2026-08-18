import type { WASocket } from "@crysnovax/baileys";
import { getWhatsAppSocket } from "./session-manager.js";

export type TransportCapability =
  | "profileName"
  | "profileBio"
  | "profilePicture"
  | "groupMetadata"
  | "groupInviteLink"
  | "groupStatus"
  | "mentions";

export interface GroupSummary {
  jid: string;
  subject: string;
  participantCount: number;
  inviteLink?: string;
}

function socketFor(workspaceId: string, sessionId: string): WASocket {
  return getWhatsAppSocket(workspaceId, sessionId);
}

function method(
  socket: WASocket,
  name: string,
): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const candidate = (socket as unknown as Record<string, unknown>)[name];
  return typeof candidate === "function"
    ? (candidate as (...args: unknown[]) => Promise<unknown>).bind(socket)
    : undefined;
}

export function hasTransportCapability(
  workspaceId: string,
  sessionId: string,
  capability: TransportCapability,
): boolean {
  const socket = socketFor(workspaceId, sessionId);
  const methods: Record<TransportCapability, string[]> = {
    profileName: ["updateProfileName"],
    profileBio: ["updateProfileStatus"],
    profilePicture: ["updateProfilePicture", "profilePictureUrl"],
    groupMetadata: ["groupFetchAllParticipating", "groupMetadata"],
    groupInviteLink: ["groupInviteCode"],
    groupStatus: ["sendGroupStatus"],
    mentions: ["sendMessage"],
  };
  return methods[capability].some((name) => Boolean(method(socket, name)));
}

export async function updateProfileName(
  workspaceId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "updateProfileName");
  if (!update) throw new Error("Unsupported capability: profileName");
  await update(name);
}

export async function updateProfileBio(
  workspaceId: string,
  sessionId: string,
  bio: string,
): Promise<void> {
  const update = method(
    socketFor(workspaceId, sessionId),
    "updateProfileStatus",
  );
  if (!update) throw new Error("Unsupported capability: profileBio");
  await update(bio);
}

export async function listGroups(
  workspaceId: string,
  sessionId: string,
): Promise<GroupSummary[]> {
  const socket = socketFor(workspaceId, sessionId);
  const fetchGroups = method(socket, "groupFetchAllParticipating");
  if (!fetchGroups) throw new Error("Unsupported capability: groupMetadata");
  const result = (await fetchGroups()) as Record<
    string,
    {
      subject?: string;
      participants?: unknown[];
    }
  >;
  return Object.entries(result).map(([jid, metadata]) => ({
    jid,
    subject: metadata.subject ?? jid,
    participantCount: metadata.participants?.length ?? 0,
  }));
}

export async function sendDirectText(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  await send(jid, { text });
}

export async function sendGroupText(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  await send(jid, { text });
}

export async function sendGroupStatus(
  workspaceId: string,
  sessionId: string,
  jid: string,
  payload: { text?: string; image?: unknown; video?: unknown },
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendGroupStatus");
  if (!send) throw new Error("Unsupported capability: groupStatus");
  await send(jid, payload);
}

export async function getGroupParticipants(
  workspaceId: string,
  sessionId: string,
  jid: string,
): Promise<string[]> {
  const metadata = method(socketFor(workspaceId, sessionId), "groupMetadata");
  if (!metadata) throw new Error("Unsupported capability: groupMetadata");
  const result = (await metadata(jid)) as {
    participants?: Array<{ id?: string }>;
  };
  return (result.participants ?? [])
    .map((participant) => participant.id)
    .filter((id): id is string => Boolean(id));
}

export async function sendGroupMentions(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
  participantCount?: number,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: mentions");
  const participants = await getGroupParticipants(workspaceId, sessionId, jid);
  const selected = participants.slice(
    0,
    Math.max(1, Math.min(participantCount ?? participants.length, 100)),
  );
  const mentionText = selected.map((id) => `@${id.split("@")[0]}`).join(" ");
  await send(jid, { text: `${mentionText}\n${text}`, mentions: selected });
}

export async function validateInviteLink(
  workspaceId: string,
  sessionId: string,
  inviteCode: string,
): Promise<{ subject?: string; participantCount?: number }> {
  const inspect = method(
    socketFor(workspaceId, sessionId),
    "groupGetInviteInfo",
  );
  if (!inspect) throw new Error("Unsupported capability: inviteValidation");
  const result = (await inspect(inviteCode)) as {
    subject?: string;
    size?: number;
    participantsCount?: number;
  };
  return {
    ...(result.subject ? { subject: result.subject } : {}),
    ...((result.participantsCount ?? result.size) !== undefined
      ? { participantCount: result.participantsCount ?? result.size }
      : {}),
  };
}

export async function getGroupInviteLink(
  workspaceId: string,
  sessionId: string,
  jid: string,
): Promise<string> {
  const invite = method(socketFor(workspaceId, sessionId), "groupInviteCode");
  if (!invite) throw new Error("Unsupported capability: groupInviteLink");
  const code = await invite(jid);
  if (typeof code !== "string" || !code)
    throw new Error("WhatsApp did not return a group invite code.");
  return `https://chat.whatsapp.com/${code}`;
}
