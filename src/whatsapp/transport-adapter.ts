import type { WASocket } from "@crysnovax/baileys";
import { getWhatsAppSocket } from "./session-manager.js";
import { PreviewManager } from "../preview/preview-manager.js";
import {
  firstHttpUrl,
  linkPreviewPayload,
} from "../preview/default-adapter.js";

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
function ownJid(socket: WASocket): string {
  return (socket as WASocket & { user?: { id?: string } }).user?.id ?? "me";
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

export async function getProfilePictureUrl(
  workspaceId: string,
  sessionId: string,
): Promise<string | undefined> {
  const socket = socketFor(workspaceId, sessionId);
  const get = method(socket, "profilePictureUrl");
  if (!get) throw new Error("Unsupported capability: profilePicture");
  const result = await get(ownJid(socket), "image");
  return typeof result === "string" ? result : undefined;
}

export async function updateProfilePicture(
  workspaceId: string,
  sessionId: string,
  imageUrl: string | Buffer,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const update = method(socket, "updateProfilePicture");
  if (!update) throw new Error("Unsupported capability: profilePicture");
  await update(
    ownJid(socket),
    Buffer.isBuffer(imageUrl) ? imageUrl : { url: imageUrl },
  );
}

export async function updateGroupProfilePicture(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  imageUrl: string | Buffer,
): Promise<void> {
  const update = method(
    socketFor(workspaceId, sessionId),
    "updateProfilePicture",
  );
  if (!update) throw new Error("Unsupported capability: groupProfilePicture");
  await update(
    groupJid,
    Buffer.isBuffer(imageUrl) ? imageUrl : { url: imageUrl },
  );
}

export async function removeProfilePicture(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const remove = method(socket, "removeProfilePicture");
  if (!remove) throw new Error("Unsupported capability: profilePicture");
  await remove(ownJid(socket));
}

export async function createWhatsAppGroup(
  workspaceId: string,
  sessionId: string,
  subject: string,
  participants: string[] = [],
): Promise<string> {
  const create = method(socketFor(workspaceId, sessionId), "groupCreate");
  if (!create) throw new Error("Unsupported capability: groupCreate");
  const normalizedParticipants = participants
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (value.includes("@")) return value;
      const digits = value.replace(/\D/g, "");
      return digits ? `${digits}@s.whatsapp.net` : "";
    })
    .filter(Boolean);
  const result = (await create(subject.trim(), normalizedParticipants)) as {
    id?: string;
    gid?: { user?: string; server?: string } | string;
  };
  if (typeof result.id === "string" && result.id) return result.id;
  if (typeof result.gid === "string" && result.gid) return result.gid;
  if (
    result.gid &&
    typeof result.gid === "object" &&
    result.gid.user &&
    result.gid.server
  )
    return `${result.gid.user}@${result.gid.server}`;
  throw new Error(
    "WhatsApp created the group but returned no group identifier.",
  );
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
  previewManager?: PreviewManager,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  const url = firstHttpUrl(text);
  const preview =
    url && previewManager ? await previewManager.resolve(url) : undefined;
  await send(jid, (preview && linkPreviewPayload(preview, text)) ?? { text });
}

export async function sendGroupText(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
  previewManager?: PreviewManager,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  const url = firstHttpUrl(text);
  const preview =
    url && previewManager ? await previewManager.resolve(url) : undefined;
  await send(jid, (preview && linkPreviewPayload(preview, text)) ?? { text });
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

export async function updateWhatsAppGroupSubject(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  subject: string,
): Promise<void> {
  const update = method(
    socketFor(workspaceId, sessionId),
    "groupUpdateSubject",
  );
  if (!update) throw new Error("Unsupported capability: groupSubject");
  await update(groupJid, subject);
}

export async function updateWhatsAppGroupDescription(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  description: string,
): Promise<void> {
  const update = method(
    socketFor(workspaceId, sessionId),
    "groupUpdateDescription",
  );
  if (!update) throw new Error("Unsupported capability: groupDescription");
  await update(groupJid, description);
}

export async function leaveWhatsAppGroup(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
): Promise<void> {
  const leave = method(socketFor(workspaceId, sessionId), "groupLeave");
  if (!leave) throw new Error("Unsupported capability: groupLeave");
  await leave(groupJid);
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
  previewManager?: PreviewManager,
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
  const outboundText = `${mentionText}\n${text}`;
  const url = firstHttpUrl(outboundText);
  const preview =
    url && previewManager ? await previewManager.resolve(url) : undefined;
  await send(
    jid,
    preview && linkPreviewPayload(preview, outboundText)
      ? { ...linkPreviewPayload(preview, outboundText), mentions: selected }
      : { text: outboundText, mentions: selected },
  );
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
