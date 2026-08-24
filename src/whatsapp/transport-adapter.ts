import type { WASocket } from "@crysnovax/baileys";
import { getWhatsAppSocket } from "./session-manager.js";
import {
  firstHttpUrl,
  prepareCanonicalPreviewContent,
} from "./baileys-native-preview.js";
import { createGroupStatusDesign } from "./status-design.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import { isPanelAssignedSession } from "./workload-transport.js";

export type TransportCapability =
  | "profileName"
  | "profileBio"
  | "profilePicture"
  | "groupMetadata"
  | "groupInviteLink"
  | "groupStatus"
  | "personalStatus"
  | "mentions";

export interface GroupSummary {
  jid: string;
  subject: string;
  participantCount: number;
  inviteLink?: string;
  /** True only when the logged-in WhatsApp identity is an admin/owner in the group. */
  isAdmin?: boolean;
}

function socketFor(workspaceId: string, sessionId: string): WASocket {
  return getWhatsAppSocket(workspaceId, sessionId);
}
function ownJid(socket: WASocket): string {
  return (socket as WASocket & { user?: { id?: string } }).user?.id ?? "me";
}

function jidVariants(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  const normalized = value.trim().toLowerCase().replace(/:\\d+(?=@)/, "");
  if (!normalized) return new Set();
  const variants = new Set([normalized]);
  const [user, server] = normalized.split("@");
  const baseUser = user?.split(":")[0] ?? user;
  if (user && server) variants.add(`${user}@${server}`);
  if (baseUser && server) variants.add(`${baseUser}@${server}`);
  if (baseUser) variants.add(baseUser);
  return variants;
}

function socketIdentityVariants(socket: WASocket): Set<string> {
  const user = (socket as WASocket & {
    user?: { id?: string; jid?: string; lid?: string };
  }).user;
  return new Set(
    [user?.id, user?.jid, user?.lid]
      .flatMap((value) => [...jidVariants(value)])
      .filter(Boolean),
  );
}

function participantValues(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source instanceof Map) return [...source.values()];
  if (source && typeof source === "object") return Object.values(source);
  return [];
}

function participantIsAdmin(participant: unknown, identities: Set<string>): boolean {
  if (!participant || typeof participant !== "object") return false;
  const value = participant as Record<string, unknown>;
  const role = String(value.admin ?? value.role ?? "").toLowerCase();
  if (role !== "admin" && role !== "superadmin" && value.isAdmin !== true && value.isSuperAdmin !== true)
    return false;
  return [value.id, value.jid, value.phoneNumber, value.pn, value.lid]
    .flatMap((candidate) => [...jidVariants(candidate)])
    .some((candidate) => identities.has(candidate));
}

function metadataHasOwnAdminRole(metadata: GroupInventoryRecord, identities: Set<string>): boolean {
  return participantValues(metadata.participants).some((participant) => participantIsAdmin(participant, identities));
}

function statusContactValues(source: unknown): unknown[] {
  if (source instanceof Map) return [...source.values()];
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") return Object.values(source);
  return [];
}

async function resolvePersonalStatusAudience(socket: WASocket): Promise<string[]> {
  const audience = new Set<string>();
  const lidMapping = (
    socket as unknown as {
      signalRepository?: {
        lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> };
      };
    }
  ).signalRepository?.lidMapping;
  const add = async (value: unknown): Promise<void> => {
    if (typeof value !== "string") return;
    let jid = value.trim();
    if (!jid) return;
    if (jid.endsWith("@lid") || jid.endsWith("@hosted.lid"))
      jid = (await lidMapping?.getPNForLID?.(jid)) ?? "";
    else if (!jid.includes("@")) jid = `${jid}@s.whatsapp.net`;
    jid = jid.replace(/:\d+(?=@)/, "");
    if (jid.endsWith("@s.whatsapp.net")) audience.add(jid);
  };
  const remoteAudience = method(socket, "getStatusJidList");
  if (remoteAudience) {
    try {
      const resolved = await remoteAudience();
      if (Array.isArray(resolved)) {
        for (const value of resolved) await add(value);
      }
    } catch {
      // The self-recipient fallback below still gives Baileys a valid audience.
    }
  }
  const sources = [
    (socket as unknown as { store?: { contacts?: unknown } }).store?.contacts,
    (socket as unknown as { contactStore?: { contacts?: unknown } }).contactStore?.contacts,
    (socket as unknown as { contacts?: unknown }).contacts,
  ];
  for (const source of sources) {
    for (const contact of statusContactValues(source)) {
      if (typeof contact === "string") await add(contact);
      else if (contact && typeof contact === "object") {
        const item = contact as Record<string, unknown>;
        await add(item.phoneNumber ?? item.id ?? item.jid);
      }
    }
  }
  const self = ownJid(socket);
  if (self !== "me") await add(self);
  return [...audience];
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
    personalStatus: ["sendStatus", "sendMessage"],
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

export async function getGroupProfilePictureUrl(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
): Promise<string | undefined> {
  const socket = socketFor(workspaceId, sessionId);
  const get = method(socket, "profilePictureUrl");
  if (!get) throw new Error("Unsupported capability: groupProfilePicture");
  const result = await get(groupJid, "image");
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
  const panelAssigned = isPanelAssignedSession(workspaceId, sessionId);
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
  const selfParticipant = panelAssigned ? "me" : self;
  if (!normalizedParticipants.length && selfParticipant && self !== "me")
    normalizedParticipants.push(selfParticipant);
  else if (panelAssigned && self) {
    const selfVariants = socketIdentityVariants(socket);
    for (let index = 0; index < normalizedParticipants.length; index += 1) {
      if ([...jidVariants(normalizedParticipants[index])].some((candidate) => selfVariants.has(candidate))) normalizedParticipants[index] = "me";
    }
  }
  const cleanSubject = subject.trim();
  if (!cleanSubject) throw new Error("A non-empty WhatsApp group name is required.");
  if (cleanSubject.length > 100) throw new Error("The WhatsApp group name must be 100 characters or fewer.");
  let result: { id?: string; gid?: { user?: string; server?: string } | string };
  try {
    result = (await create(cleanSubject, normalizedParticipants)) as {
      id?: string;
      gid?: { user?: string; server?: string } | string;
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/bad.?request|400/i.test(raw)) {
      throw new Error("WhatsApp rejected group creation. Confirm the session is fully connected, keep the name within 100 characters, and provide at least one valid international participant number; then retry.");
    }
    throw new Error(`WhatsApp group creation failed: ${raw}`);
  }
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

const GROUP_INVENTORY_TIMEOUT_MS = 15_000;
// Group inventory is expensive on large accounts; mutation paths still fetch fresh group metadata.
const GROUP_INVENTORY_CACHE_MS = 60_000;
const GROUP_INVENTORY_INFLIGHT_TIMEOUT_MS = 20_000;
const GROUP_PARTICIPANT_CACHE_MS = 30_000;
type GroupInventoryRecord = { subject?: string; participants?: unknown[] };
const groupInventoryCache = new Map<
  string,
  { expiresAt: number; groups: GroupSummary[] }
>();
const groupInventoryLastKnown = new Map<string, GroupSummary[]>();
const groupInventoryInflight = new Map<string, Promise<GroupSummary[]>>();
const groupParticipantCache = new Map<
  string,
  { expiresAt: number; participants: string[] }
>();
const groupParticipantInflight = new Map<string, Promise<string[]>>();

function transientGroupInventoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate|over.?limit|429|timeout|tempor|network|closed|not connected/i.test(message);
}

async function loadGroupInventory(
  fetchGroups: (...args: unknown[]) => Promise<unknown>,
  identities: Set<string>,
  timeoutMs = GROUP_INVENTORY_TIMEOUT_MS,
): Promise<GroupSummary[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = (await Promise.race([
        fetchGroups(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("WhatsApp group inventory timed out. Retry after the session is fully connected.")),
            timeoutMs,
          ),
        ),
      ])) as Record<string, GroupInventoryRecord>;
      return Object.entries(result).map(([jid, metadata]) => ({
        jid,
        subject: metadata.subject ?? jid,
        participantCount: participantValues(metadata.participants).length,
        isAdmin: metadataHasOwnAdminRole(metadata, identities),
      }));
    } catch (error) {
      lastError = error;
      if (!transientGroupInventoryError(error) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("WhatsApp group inventory failed.");
}

export async function listGroups(
  workspaceId: string,
  sessionId: string,
): Promise<GroupSummary[]> {
  const cacheKey = `${workspaceId}:${sessionId}`;
  const cached = groupInventoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.groups.map((group) => ({ ...group }));
  const inflight = groupInventoryInflight.get(cacheKey);
  if (inflight) {
    try {
      const groups = await Promise.race([
        inflight,
        new Promise<GroupSummary[]>((_, reject) =>
          setTimeout(
            () => reject(new Error("WhatsApp group inventory request remained in-flight too long.")),
            GROUP_INVENTORY_INFLIGHT_TIMEOUT_MS,
          ),
        ),
      ]);
      return groups.map((group) => ({ ...group }));
    } catch (error) {
      const stale = groupInventoryLastKnown.get(cacheKey);
      if (stale) return stale.map((group) => ({ ...group }));
      throw error;
    }
  }
  const socket = socketFor(workspaceId, sessionId);
  const fetchSummaries = method(socket, "listGroupSummaries");
  const fetchGroups = method(socket, "groupFetchAllParticipating");
  if (!fetchSummaries && !fetchGroups) throw new Error("Unsupported capability: groupMetadata");
  const identities = socketIdentityVariants(socket);
  const loadPanelSummaries = async (): Promise<GroupSummary[]> => {
    if (!fetchSummaries) return loadGroupInventory(fetchGroups as (...args: unknown[]) => Promise<unknown>, identities);
    try {
      const result = await Promise.race([
        fetchSummaries(ownJid(socket)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("WhatsApp group inventory timed out. Retry after the session is fully connected.")), GROUP_INVENTORY_TIMEOUT_MS),
        ),
      ]);
      if (!Array.isArray(result)) throw new Error("Panel returned an invalid group inventory.");
      const summaries = result.filter((item): item is GroupSummary => {
        if (!item || typeof item !== "object") return false;
        const value = item as Record<string, unknown>;
        return typeof value.jid === "string";
      }).map((item) => {
        const value = item as unknown as Record<string, unknown>;
        return {
          jid: value.jid as string,
          subject: typeof value.subject === "string" ? value.subject : String(value.jid),
          participantCount: typeof value.participantCount === "number" ? value.participantCount : 0,
          ...(typeof value.isAdmin === "boolean" ? { isAdmin: value.isAdmin } : {}),
        };
      });
      // Older workloads do not include role metadata. Recompute from full metadata
      // instead of showing a misleading empty Admin Groups screen until auto-update.
      if (fetchGroups && summaries.length > 0 && !summaries.some((group) => group.isAdmin === true)) {
        return loadGroupInventory(fetchGroups as (...args: unknown[]) => Promise<unknown>, identities, 60_000).catch(() => summaries);
      }
      return summaries;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (fetchGroups && /method is unavailable:\s*listGroupSummaries/i.test(reason))
        return loadGroupInventory(fetchGroups as (...args: unknown[]) => Promise<unknown>, identities);
      throw error;
    }
  };
  const request = loadPanelSummaries()
    .then((groups) => {
      groupInventoryLastKnown.set(cacheKey, groups);
      groupInventoryCache.set(cacheKey, {
        expiresAt: Date.now() + GROUP_INVENTORY_CACHE_MS,
        groups,
      });
      return groups;
    })
    .catch((error) => {
      const stale = groupInventoryLastKnown.get(cacheKey);
      if (stale) return stale;
      throw error;
    })
    .finally(() => {
      groupInventoryInflight.delete(cacheKey);
    });
  groupInventoryInflight.set(cacheKey, request);
  return (await request).map((group) => ({ ...group }));
}

export function filterAdminGroupSummaries(groups: GroupSummary[]): GroupSummary[] {
  return groups
    .filter((group) => group.isAdmin === true)
    .map((group) => ({ ...group }));
}

export async function listAdminGroups(
  workspaceId: string,
  sessionId: string,
): Promise<GroupSummary[]> {
  return filterAdminGroupSummaries(await listGroups(workspaceId, sessionId));
}

export interface GroupParticipantSummary {
  id: string;
  admin?: string;
  phoneNumber?: string;
  jid?: string;
}

export interface GroupModerationSnapshot {
  jid: string;
  subject: string;
  description?: string;
  participantCount: number;
  participants: GroupParticipantSummary[];
  isAdmin: boolean;
  joinApprovalMode?: boolean;
  memberAddMode?: boolean;
}

const GROUP_METADATA_CACHE_MS = 30_000;
const groupMetadataCache = new Map<string, { expiresAt: number; snapshot: GroupModerationSnapshot }>();
const groupMetadataInflight = new Map<string, Promise<GroupModerationSnapshot>>();

export async function getGroupModerationSnapshot(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  options: { fresh?: boolean } = {},
): Promise<GroupModerationSnapshot> {
  const cacheKey = `${workspaceId}:${sessionId}:${groupJid}`;
  if (!options.fresh) {
    const cached = groupMetadataCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cloneGroupModerationSnapshot(cached.snapshot);
    const inflight = groupMetadataInflight.get(cacheKey);
    if (inflight) return cloneGroupModerationSnapshot(await inflight);
  }
  const socket = socketFor(workspaceId, sessionId);
  const metadata = method(socket, "groupMetadata");
  if (!metadata) throw new Error("Unsupported capability: groupMetadata");
  const request = (async () => {
    const raw = (await metadata(groupJid)) as Record<string, unknown>;
    const participants = participantValues(raw.participants).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const id = typeof value.id === "string" ? value.id : typeof value.jid === "string" ? value.jid : "";
        if (!id) return [];
        return [{
          id,
          ...(typeof value.admin === "string" ? { admin: value.admin } : {}),
          ...(typeof value.phoneNumber === "string" ? { phoneNumber: value.phoneNumber } : {}),
          ...(typeof value.jid === "string" ? { jid: value.jid } : {}),
        }];
      });
    const snapshot = {
      jid: groupJid,
      subject: typeof raw.subject === "string" ? raw.subject : groupJid,
      ...(typeof raw.desc === "string" ? { description: raw.desc } : {}),
      participantCount: participants.length,
      participants,
      isAdmin: metadataHasOwnAdminRole(raw as GroupInventoryRecord, socketIdentityVariants(socket)),
      ...(typeof raw.joinApprovalMode === "boolean" ? { joinApprovalMode: raw.joinApprovalMode } : {}),
      ...(typeof raw.memberAddMode === "boolean" ? { memberAddMode: raw.memberAddMode } : {}),
    } satisfies GroupModerationSnapshot;
    groupMetadataCache.set(cacheKey, { expiresAt: Date.now() + GROUP_METADATA_CACHE_MS, snapshot });
    return snapshot;
  })();
  if (options.fresh) return cloneGroupModerationSnapshot(await request);
  groupMetadataInflight.set(cacheKey, request);
  try {
    return cloneGroupModerationSnapshot(await request);
  } finally {
    if (groupMetadataInflight.get(cacheKey) === request) groupMetadataInflight.delete(cacheKey);
  }
}

function cloneGroupModerationSnapshot(snapshot: GroupModerationSnapshot): GroupModerationSnapshot {
  return {
    ...snapshot,
    participants: snapshot.participants.map((participant) => ({ ...participant })),
  };
}

export interface ParticipantOperationResult {
  attempted: number;
  succeeded: number;
  succeededJids: string[];
  failed: number;
  failures: Array<{ jid?: string; status: string }>;
}

function classifyParticipantOperationResult(
  result: unknown,
  attempted: number,
  expectedParticipants: string[] = [],
): ParticipantOperationResult {
  if (result == null)
    return { attempted, succeeded: attempted, succeededJids: [...expectedParticipants], failed: 0, failures: [] };
  const entries = Array.isArray(result) ? result : [result];
  const succeededJids: string[] = [];
  const failures: Array<{ jid?: string; status: string }> = [];
  const returnedJids = new Set<string>();
  entries.forEach((item, index) => {
    const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const status = String(value.status ?? value.error ?? "200");
    const echoedJid = typeof value.jid === "string" ? value.jid : undefined;
    const positionalJid = expectedParticipants[index];
    const jid = echoedJid ?? positionalJid;
    if (jid) returnedJids.add(jid);
    if (status === "200" || status === "0") {
      if (jid) succeededJids.push(jid);
    } else {
      failures.push({ ...(jid ? { jid } : {}), status });
    }
  });
  const missing = expectedParticipants.length
    ? expectedParticipants.filter((jid) => !returnedJids.has(jid) && !failures.some((failure) => failure.jid === jid))
    : Array.from({ length: Math.max(0, attempted - entries.length) }, () => undefined);
  const missingFailures = missing.map((jid) => ({
    ...(jid ? { jid } : {}),
    status: "not-returned",
  }));
  const allFailures = [...failures, ...missingFailures];
  const succeeded = Math.max(0, entries.length - failures.length);
  return {
    attempted,
    succeeded,
    succeededJids,
    failed: allFailures.length,
    failures: allFailures,
  };
}

export async function updateGroupParticipantBatch(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  participants: string[],
  action: "promote" | "demote" | "remove",
  throwOnFailure = true,
): Promise<ParticipantOperationResult> {
  const update = method(socketFor(workspaceId, sessionId), "groupParticipantsUpdate");
  if (!update) throw new Error("Unsupported capability: groupParticipantsUpdate");
  const uniqueParticipants = [...new Set(participants)].filter(Boolean);
  const result = classifyParticipantOperationResult(
    await update(groupJid, uniqueParticipants, action),
    uniqueParticipants.length,
    uniqueParticipants,
  );
  if (throwOnFailure && result.failed)
    throw new Error(`WhatsApp rejected ${result.failed} participant operation(s): ${result.failures.map((failure) => failure.status).join(", ")}`);
  return result;
}

export async function updateGroupParticipantRole(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  participantJid: string,
  action: "promote" | "demote" | "remove",
): Promise<ParticipantOperationResult> {
  return updateGroupParticipantBatch(
    workspaceId,
    sessionId,
    groupJid,
    [participantJid],
    action,
  );
}

export async function setGroupJoinApprovalMode(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  enabled: boolean,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "groupJoinApprovalMode");
  if (!update) throw new Error("Unsupported capability: groupJoinApprovalMode");
  await update(groupJid, enabled ? "on" : "off");
}

export async function setGroupMemberAddMode(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  allMembers: boolean,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "groupMemberAddMode");
  if (!update) throw new Error("Unsupported capability: groupMemberAddMode");
  await update(groupJid, allMembers ? "all_member_add" : "admin_add");
}

export async function setGroupChatMode(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  adminsOnly: boolean,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "groupSettingUpdate");
  if (!update) throw new Error("Unsupported capability: groupSettingUpdate");
  await update(groupJid, adminsOnly ? "announcement" : "not_announcement");
}

export async function setGroupInfoMode(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  adminsOnly: boolean,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "groupSettingUpdate");
  if (!update) throw new Error("Unsupported capability: groupSettingUpdate");
  await update(groupJid, adminsOnly ? "locked" : "unlocked");
}

export async function setGroupEphemeral(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  seconds: number,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "groupToggleEphemeral");
  if (!update) throw new Error("Unsupported capability: groupToggleEphemeral");
  if (![0, 86_400, 604_800, 7_776_000].includes(seconds)) throw new Error("Unsupported disappearing-message duration.");
  await update(groupJid, seconds);
}

export async function revokeGroupInvite(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
): Promise<void> {
  const revoke = method(socketFor(workspaceId, sessionId), "groupRevokeInvite");
  if (!revoke) throw new Error("Unsupported capability: groupRevokeInvite");
  await revoke(groupJid);
}

export async function updateParticipantBlockStatus(
  workspaceId: string,
  sessionId: string,
  participantJid: string,
  blocked: boolean,
): Promise<void> {
  const update = method(socketFor(workspaceId, sessionId), "updateBlockStatus");
  if (!update) throw new Error("Unsupported capability: updateBlockStatus");
  await update(participantJid, blocked ? "block" : "unblock");
}

/** Send a native WhatsApp poll to a group. */
export async function sendGroupPoll(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  question: string,
  options: string[],
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  await send(groupJid, { poll: { name: question, values: options, selectableCount: 1 } });
}

/** Delete one inbound WhatsApp message using its original Baileys key. */
export async function deleteWhatsAppMessage(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  messageKey: Record<string, unknown>,
): Promise<void> {
  const send = method(socketFor(workspaceId, sessionId), "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  await send(groupJid, { delete: messageKey });
}

export interface GroupJoinRequest {
  jid: string;
  phoneNumber?: string;
  addedBy?: string;
}

function digitsFromIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 ? digits : undefined;
}

async function verifiedRequestPhone(socket: WASocket, jid: string, provided?: string): Promise<string | undefined> {
  const direct = digitsFromIdentity(provided) ?? (jid.endsWith("@lid") || jid.endsWith("@hosted.lid") ? undefined : digitsFromIdentity(jid));
  if (direct) return direct;
  if (!jid.endsWith("@lid") && !jid.endsWith("@hosted.lid")) return undefined;
  const mapping = (socket as WASocket & { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } }).signalRepository?.lidMapping;
  try {
    const resolved = await mapping?.getPNForLID?.(jid);
    return digitsFromIdentity(resolved);
  } catch {
    return undefined;
  }
}

export async function listGroupJoinRequests(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
): Promise<GroupJoinRequest[]> {
  const socket = socketFor(workspaceId, sessionId);
  const list = method(socket, "groupRequestParticipantsList");
  if (!list) throw new Error("Unsupported capability: groupRequestParticipantsList");
  const result = await list(groupJid);
  if (!Array.isArray(result)) return [];
  const requests = await Promise.all(result.map(async (item) => {
    if (!item || typeof item !== "object") return undefined;
    const value = item as Record<string, unknown>;
    const jid = typeof value.jid === "string" ? value.jid : typeof value.id === "string" ? value.id : "";
    if (!jid) return undefined;
    const phoneNumber = await verifiedRequestPhone(socket, jid, typeof value.phoneNumber === "string" ? value.phoneNumber : undefined);
    return {
      jid,
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(typeof value.addedBy === "string" ? { addedBy: value.addedBy } : {}),
    } satisfies GroupJoinRequest;
  }));
  return requests.filter((request): request is GroupJoinRequest => Boolean(request));
}

export async function updateGroupJoinRequests(
  workspaceId: string,
  sessionId: string,
  groupJid: string,
  participants: string[],
  action: "approve" | "reject",
  throwOnFailure = true,
): Promise<ParticipantOperationResult> {
  const update = method(socketFor(workspaceId, sessionId), "groupRequestParticipantsUpdate");
  if (!update) throw new Error("Unsupported capability: groupRequestParticipantsUpdate");
  const result = classifyParticipantOperationResult(
    await update(groupJid, participants, action),
    participants.length,
    participants,
  );
  if (throwOnFailure && result.failed)
    throw new Error(`WhatsApp rejected ${result.failed} join request operation(s): ${result.failures.map((failure) => failure.status).join(", ")}`);
  return result;
}

export async function sendDirectText(
  workspaceId: string,
  sessionId: string,
  jid: string,
  text: string,
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  await send(
    jid,
    await prepareCanonicalPreviewContent({
      text,
      content: { text },
      socket,
      cacheScope: `${workspaceId}:${sessionId}`,
    }),
  );
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
  mentions?: string[],
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: sendMessage");
  const content = {
    ...messagePayload(text, media),
    ...(mentions?.length ? { mentions } : {}),
  };
  await send(
    jid,
    await prepareCanonicalPreviewContent({
      text,
      content,
      socket,
      cacheScope: `${workspaceId}:${sessionId}`,
    }),
  );
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
  if (payload.media) {
    const mediaContent = messagePayload(text, payload.media);
    const preparedMedia = await prepareCanonicalPreviewContent({
      text,
      content: mediaContent,
      target: "group-status",
      socket,
      cacheScope: `${workspaceId}:${sessionId}`,
    });
    await send(jid, {
      groupStatusMessage: preparedMedia,
    });
    return;
  }
  const { media: _media, ...statusPayload } = payload;
  const content = {
    ...statusPayload,
    groupStatus: true,
  };
  const prepared = await prepareCanonicalPreviewContent({
    text,
    content,
    target: "group-status",
    socket,
    cacheScope: `${workspaceId}:${sessionId}`,
  });
  await send(jid, prepared);
}

export async function sendPersonalStatus(
  workspaceId: string,
  sessionId: string,
  payload: {
    text?: string;
    media?: GroupMediaPayload;
  },
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const send = method(socket, "sendStatus");
  if (!send) throw new Error("Unsupported capability: personalStatus");
  const text = payload.text ?? "";
  const content = payload.media
    ? messagePayload(text, payload.media)
    : { text };
  const statusJidList = await resolvePersonalStatusAudience(socket);
  const statusContent = {
    ...content,
    status: true,
    ...(statusJidList.length ? { statusJidList } : {}),
  };
  const prepared = await prepareCanonicalPreviewContent({
    text,
    content: statusContent,
    socket,
    cacheScope: `${workspaceId}:${sessionId}`,
  });
  await send(prepared);
}

export async function sendGroupColorStatus(
  workspaceId: string,
  sessionId: string,
  jid: string,
  payload: { text?: string; media?: GroupMediaPayload },
): Promise<void> {
  const socket = socketFor(workspaceId, sessionId);
  const metadata = method(socket, "groupMetadata");
  if (!metadata) throw new Error("Unsupported capability: groupMetadata");
  const group = (await metadata(jid)) as { subject?: string };
  const sourceText = payload.text ?? "";
  const mediaCaption = payload.media?.caption?.trim() ?? "";
  const detectorText = sourceText || mediaCaption;
  // `d` means design only for a URL. Plain text must remain the ordinary
  // group-status path so `.dgstatus hello` never creates a colored canvas.
  if (!firstHttpUrl(detectorText)) {
    await sendGroupStatus(workspaceId, sessionId, jid, payload);
    return;
  }
  const groupName = String(group.subject ?? "WhatsApp Group").trim() || "WhatsApp Group";
  const sourceContent = payload.media
    ? messagePayload(detectorText, payload.media)
    : { text: detectorText };
  const sourcePrepared = await prepareCanonicalPreviewContent({
    text: detectorText,
    content: sourceContent,
    target: "group-status",
    socket,
    cacheScope: `${workspaceId}:${sessionId}`,
  });
  const sourcePreview = sourcePrepared.linkPreview as Record<string, unknown> | undefined;
  const previewTitle = typeof sourcePreview?.title === "string" ? sourcePreview.title.trim() : "";
  const design = createGroupStatusDesign({
    groupName,
    title: previewTitle || groupName,
    text: detectorText,
    seed: `${workspaceId}:${sessionId}:${jid}:${Date.now()}`,
  });
  const content = payload.media
    ? messagePayload(design.text, payload.media)
    : { text: design.text };
  const prepared = await prepareCanonicalPreviewContent({
    text: design.text,
    content: sourcePreview ? { ...content, linkPreview: sourcePreview } : content,
    target: "group-status",
    socket,
    cacheScope: `${workspaceId}:${sessionId}`,
  });
  const send = method(socket, "sendMessage");
  if (!send) throw new Error("Unsupported capability: groupStatus");
  const sendOptions = {
    backgroundColor: design.backgroundColor,
    font: design.font,
  };
  if (payload.media) {
    await send(jid, { groupStatusMessage: prepared }, sendOptions);
  } else {
    await send(jid, { ...prepared, groupStatus: true }, sendOptions);
  }
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
  const cacheKey = `${workspaceId}:${sessionId}:${jid}`;
  const cached = groupParticipantCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return [...cached.participants];
  const inflight = groupParticipantInflight.get(cacheKey);
  if (inflight) return [...(await inflight)];
  const request = (async (): Promise<string[]> => {
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
    const resolved = new Set<string>();
    for (const participant of result.participants ?? []) {
      const candidate =
        participant.phoneNumber ?? participant.pn ?? participant.id;
      if (!candidate) continue;
      let phoneJid = candidate;
      if (phoneJid.endsWith("@lid") || phoneJid.endsWith("@hosted.lid"))
        phoneJid = (await lidMapping?.getPNForLID?.(phoneJid)) ?? "";
      else if (!phoneJid.includes("@")) phoneJid = `${phoneJid}@s.whatsapp.net`;
      if (!phoneJid.endsWith("@s.whatsapp.net")) continue;
      resolved.add(phoneJid);
    }
    return [...resolved];
  })();
  groupParticipantInflight.set(cacheKey, request);
  try {
    const participants = await request;
    groupParticipantCache.set(cacheKey, {
      expiresAt: Date.now() + GROUP_PARTICIPANT_CACHE_MS,
      participants,
    });
    return [...participants];
  } finally {
    groupParticipantInflight.delete(cacheKey);
  }
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
    await prepareCanonicalPreviewContent({
      text,
      content: { text, mentions: participants },
      socket,
      cacheScope: `${workspaceId}:${sessionId}`,
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
    await prepareCanonicalPreviewContent({
      text,
      content: { ...messagePayload(text, media), mentions: selected },
      socket,
      cacheScope: `${workspaceId}:${sessionId}`,
    }),
  );
}

export async function validateInviteLink(
  workspaceId: string,
  sessionId: string,
  inviteCode: string,
 ): Promise<{ jid?: string; subject?: string; participantCount?: number }> {
  const inspect = method(
    socketFor(workspaceId, sessionId),
    "groupGetInviteInfo",
  );
  if (!inspect) throw new Error("Unsupported capability: inviteValidation");
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = (await inspect(inviteCode)) as {
        id?: string;
        subject?: string;
        size?: number;
        participantsCount?: number;
      };
      const jid = typeof result.id === "string" && /@g\.us$/.test(result.id)
        ? result.id
        : undefined;
      if (!jid) throw new Error("Invite validation returned incomplete group metadata.");
      return {
        jid,
        ...(result.subject ? { subject: result.subject } : {}),
        ...((result.participantsCount ?? result.size) !== undefined
          ? { participantCount: result.participantsCount ?? result.size }
          : {}),
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const retryable = /rate|429|timeout|tempor|network|connection|closed|unavailable|5\d\d/.test(message);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Invite validation failed."));
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
