import type { WASocket } from "@crysnovax/baileys";
import { getWhatsAppSocket } from "./session-manager.js";
import { prepareOutboundContent } from "./outbound-preview.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";

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

export function nativePreview(text: string): { richPreview?: true } {
  return /https?:\/\/\S+/i.test(text) ? { richPreview: true } : {};
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
    groupStatus: ["sendGroupStatus", "sendMessage"],
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
    { hd: true },
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
    { hd: true },
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
  const socket = socketFor(workspaceId, sessionId);
  const create = method(socket, "groupCreate");
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
  const self = ownJid(socket);
  if (!normalizedParticipants.length && self && !self.endsWith("@lid"))
    normalizedParticipants.push(self);
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

export async function updateGroupDescription(
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
  await update(groupJid, description.trim());
}

export async function getGroupInviteCode(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
): Promise<string | undefined> {
  const get = method(socketFor(workspaceId, sessionId), "groupInviteCode");
  if (!get) throw new Error("Unsupported capability: groupInviteLink");
  const result = await get(groupJid);
  return typeof result === "string" ? result : undefined;
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
  await send(jid, await prepareOutboundContent({ text, content: { text } }));
}

export type GroupMediaPayload = WhatsAppMediaPayload;

function messagePayload(
  text: string,
  media?: GroupMediaPayload,
): Record<string, unknown> {
  if (!media) return { text };
  const caption = media.caption ?? text;
  if (media.kind === "audio")
    return {
      audio: media.bytes,
      ...(media.mimeType ? { mimetype: media.mimeType } : {}),
      ...(media.ptt !== undefined ? { ptt: media.ptt } : {}),
    };
  if (media.kind === "sticker")
    return {
      sticker: media.bytes,
      mimetype: media.mimeType ?? "image/webp",
    };
  return {
    [media.kind]: media.bytes,
    ...(caption ? { caption } : {}),
    ...(media.mimeType ? { mimetype: media.mimeType } : {}),
    ...(media.kind === "document"
      ? { fileName: media.fileName ?? "document.bin" }
      : {}),
  };
}

export async function sendGroupText(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
  media?: GroupMediaPayload,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  const content = messagePayload(text, media);
  await send(jid, await prepareOutboundContent({ text, content }));
}

export async function sendGroupStatus(
  workspaceId: string,
  sessionId: string,
  jid: string,
  payload: {
    text?: string;
    image?: unknown;
    video?: unknown;
    media?: GroupMediaPayload;
  },
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const native = method(socket, "sendGroupStatus");
  const text = payload.text ?? "";
  if (native && !payload.media && !/https?:\/\/\S+/i.test(text)) {
    await native(jid, payload);
    return;
  }
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: groupStatus");
  const { media, ...statusPayload } = payload;
  const content = {
    ...statusPayload,
    ...(media ? messagePayload(text, media) : {}),
    groupStatus: true,
  };
  const prepared = await prepareOutboundContent({
    text,
    content,
    target: "group-status",
  });
  await send(jid, prepared);
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
  const socket = socketFor(workspaceId, sessionId);
  const metadata = method(socket, "groupMetadata");
  if (!metadata) throw new Error("Unsupported capability: groupMetadata");
  const result = (await metadata(jid)) as {
    participants?: Array<{ id?: string; phoneNumber?: string; pn?: string }>;
  };
  const lidMapping = (
    socket as unknown as {
      signalRepository?: {
        lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> };
      };
    }
  ).signalRepository?.lidMapping;
  const resolved: string[] = [];
  for (const participant of result.participants ?? []) {
    const candidate =
      participant.phoneNumber ?? participant.pn ?? participant.id;
    if (!candidate) continue;
    let phoneJid = candidate;
    if (phoneJid.endsWith("@lid") || phoneJid.endsWith("@hosted.lid"))
      phoneJid = (await lidMapping?.getPNForLID?.(phoneJid)) ?? "";
    else if (!phoneJid.includes("@")) phoneJid = `${phoneJid}@s.whatsapp.net`;
    if (!phoneJid.endsWith("@s.whatsapp.net")) continue;
    if (!resolved.includes(phoneJid)) resolved.push(phoneJid);
  }
  return resolved;
}

export async function sendGroupHidetag(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: mentions");
  const participants = await getGroupParticipants(workspaceId, sessionId, jid);
  if (!participants.length)
    throw new Error("No phone-number JIDs were available for this group.");
  await send(
    jid,
    await prepareOutboundContent({
      text,
      content: { text, mentions: participants },
    }),
  );
}

export async function sendGroupMentions(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
  participantCount?: number,
  media?: GroupMediaPayload,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: mentions");
  const participants = await getGroupParticipants(workspaceId, sessionId, jid);
  const selected = participants.slice(
    0,
    Math.max(1, Math.min(participantCount ?? participants.length, 1000)),
  );
  // Keep the body plain and pass recipients only through hidden mention
  // metadata; the shared pipeline handles URL preview preparation.
  await send(
    jid,
    await prepareOutboundContent({
      text,
      content: { ...messagePayload(text, media), mentions: selected },
    }),
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
