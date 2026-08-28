import type { WhatsAppSession } from "../../types/domain.js";
import { getSession, getWorkspaceSudo } from "../../core/session-registry.js";
import {
  allModuleKeys,
  getCustomMessage,
  incrementWarn,
  loadGroupAntiConfig,
  recordSpam,
  resetSpam,
  resetWarn,
  moduleCapability,
} from "./config.js";
import { extractSenderLinks, extractSenderText } from "./content-extractor.js";
import { firstVerifiedPhone, phoneJidFromIdentity } from "../identity-normalization.js";
import { isPhoneBanned } from "../group-moderation-state.js";
import { buildAntiSecurityResponse, buildAntiViolationResponse } from "./response-format.js";
import type {
  AntiDecision,
  AntiInboundMessage,
  AntiModuleConfig,
  AntiModuleKey,
  AntiGroupMetadata,
  GroupAntiConfig,
} from "./types.js";

interface GroupSnapshot {
  subject: string;
  description?: string;
  participantCount: number;
  participants: Array<{ id: string; admin?: string; phoneNumber?: string; jid?: string }>;
  isAdmin: boolean;
}

const seenMessages = new Map<string, number>();
const SEEN_TTL_MS = 5 * 60_000;
const MAX_ACTION_TEXT = 500;

function normalizeJid(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/:\d+(?=@)/, "");
}

function numberOf(value: string | undefined): string {
  return normalizeJid(value).split("@")[0]?.replace(/\D/g, "") ?? "";
}

function sameIdentity(left: string, right: string): boolean {
  const leftPhone = firstVerifiedPhone(left);
  const rightPhone = firstVerifiedPhone(right);
  if (leftPhone && rightPhone) return leftPhone === rightPhone;
  const a = normalizeJid(left);
  const b = normalizeJid(right);
  return Boolean(a && b && a === b && !/@(?:lid|hosted\.lid)$/iu.test(a));
}

function unwrap(value: Record<string, unknown> | undefined): Record<string, unknown> {
  let current = value ?? {};
  for (let i = 0; i < 8; i += 1) {
    let next: Record<string, unknown> | undefined;
    for (const key of [
      "ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV3",
      "documentWithCaptionMessage", "groupStatusMessage", "groupStatusMessageV2",
      "groupStatusMentionMessage", "statusMentionMessage", "statusMentionReply", "botForwardedMessage",
    ]) {
      const candidate = current[key];
      if (!candidate || typeof candidate !== "object") continue;
      const inner = (candidate as Record<string, unknown>).message;
      if (inner && typeof inner === "object") {
        next = inner as Record<string, unknown>;
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
}

function nestedValues(input: AntiInboundMessage, keys: string[]): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node as object)) return;
    seen.add(node as object);
    const record = node as Record<string, unknown>;
    for (const key of keys) if (key in record) values.push(record[key]);
    for (const key of ["associatedChildMessage", "botForwardedMessage", "documentWithCaptionMessage", "editedMessage", "ephemeralMessage", "groupStatusMessage", "groupStatusMessageV2", "groupStatusMentionMessage", "statusMentionMessage", "statusMentionReply", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"]) {
      const wrapper = record[key];
      if (wrapper && typeof wrapper === "object") walk((wrapper as Record<string, unknown>).message ?? wrapper, depth + 1);
    }
  };
  walk(input.message, 0);
  return values;
}

function contextInfo(input: AntiInboundMessage): Record<string, unknown> {
  const root = unwrap(input.message);
  const candidates: unknown[] = [root.contextInfo];
  for (const key of ["extendedTextMessage", "imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    const value = root[key];
    if (value && typeof value === "object") candidates.push((value as Record<string, unknown>).contextInfo);
  }
  return candidates.find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object") ?? {};
}

function hasAnyKey(input: AntiInboundMessage, keys: string[]): boolean {
  const root = unwrap(input.message);
  return keys.some((key) => key in root && root[key] !== undefined && root[key] !== null);
}

function isLikelyBot(input: AntiInboundMessage): boolean {
  if (input.fromMe || !input.rawKey) return false;
  const messageId = String(input.rawKey.id ?? "");
  if (messageId.startsWith("3EB") && messageId.length > 10) return true;
  const raw = input.rawKey as Record<string, unknown>;
  const root = unwrap(input.message);
  const hints = [raw.verifiedBizName, raw.deviceName, root.verifiedBizName, root.deviceName]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  if (/(?:baileys|wa-automate|whatsapp-web|yowsjs|go-whatsapp|multidevice|wwebjs|automation)/u.test(hints)) return true;
  const participant = String(raw.participant ?? input.senderJid ?? "");
  const agent = /:(\d+)@/u.exec(participant)?.[1];
  if (agent && Number(agent) > 100) return true;
  return messageId.length > 0 && (messageId.length < 6 || messageId.length > 50);
}

function hasHttpLink(text: string): boolean {
  return /(?:https?|ftp):\/\/[^\s<>]+|www\.[^\s<>]+|(?<![\w@.-])(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9_-]{1,62}(?:[/?#][^\s<>]*)?/iu.test(text);
}

function containsEmoji(text: string): boolean {
  try {
    return /\p{Extended_Pictographic}/u.test(text);
  } catch {
    return /[\u{1F300}-\u{1FAFF}]/u.test(text);
  }
}

function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return Boolean(stripped) && containsEmoji(stripped) && !/[\p{L}\p{N}]/u.test(stripped);
}

function senderText(input: AntiInboundMessage): string {
  const extracted = extractSenderText(input.message);
  return extracted || input.text || "";
}

function isPlainText(input: AntiInboundMessage): boolean {
  const text = senderText(input);
  if (!text || input.mediaKind) return false;
  const root = unwrap(input.message);
  const extended = root.extendedTextMessage;
  if (extended && typeof extended === "object" && typeof (extended as Record<string, unknown>).canonicalUrl === "string") return false;
  if (hasAnyKey(input, ["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage", "pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3", "pollUpdateMessage", "reactionMessage", "contactMessage", "locationMessage", "liveLocationMessage", "groupStatusMentionMessage", "groupMentionedMessage", "interactiveMessage", "interactiveResponseMessage", "buttonsMessage", "listMessage", "templateMessage", "protocolMessage", "callLogMessage", "callLogMessageV2", "callLogMessageV3", "callLogMessageV4"])) return false;
  return true;
}

function isGroupStatusPost(input: AntiInboundMessage): boolean {
  return nestedValues(input, ["groupStatusMessage", "groupStatusMessageV2"]).some((value) => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const inner = record.message;
    return Boolean(inner && typeof inner === "object" && Object.keys(inner as Record<string, unknown>).length > 0);
  });
}

function isGroupStatusMention(input: AntiInboundMessage): boolean {
  return nestedValues(input, ["groupStatusMentionMessage"]).some((value) => {
    if (!value || typeof value !== "object") return false;
    const inner = (value as Record<string, unknown>).message;
    return Boolean(inner && typeof inner === "object" && Object.keys(inner as Record<string, unknown>).length > 0);
  });
}

function isGroupMention(input: AntiInboundMessage): boolean {
  const root = unwrap(input.message);
  const context = contextInfo(input);
  const mentions = context.groupMentions ?? root.groupMentions;
  if (Array.isArray(mentions) && mentions.some((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).groupJid === "string" && (entry as Record<string, unknown>).groupJid !== input.groupJid)) return true;
  const wrapper = root.groupMentionedMessage;
  return Boolean(wrapper && typeof wrapper === "object" && (wrapper as Record<string, unknown>).message && typeof (wrapper as Record<string, unknown>).message === "object" && Object.keys((wrapper as Record<string, unknown>).message as Record<string, unknown>).length > 0);
}

function isForwarded(input: AntiInboundMessage): boolean {
  const context = contextInfo(input);
  return context.isForwarded === true || Number(context.forwardingScore ?? 0) > 0;
}

function isChannel(input: AntiInboundMessage): boolean {
  const context = contextInfo(input);
  const newsletter = context.forwardedNewsletterMessageInfo ?? context.newsletterJid;
  return Boolean(newsletter) || normalizeJid(input.groupJid).endsWith("@newsletter");
}

function isPoll(input: AntiInboundMessage): boolean {
  return hasAnyKey(input, ["pollCreationMessage", "pollCreationMessageV2"]);
}

function rawSignalAvailable(input: AntiInboundMessage, key: AntiModuleKey): boolean {
  if (key === "antiforward") return Object.keys(contextInfo(input)).length > 0;
  if (key === "antichannel") return Object.keys(contextInfo(input)).length > 0;
  if (key === "antipoll") return Boolean(input.message && Object.keys(unwrap(input.message)).length);
  if (key === "antigroupmention") return Object.keys(contextInfo(input)).length > 0;
  if (key === "antigm" || key === "antigstatus") return Boolean(input.message && Object.keys(unwrap(input.message)).length);
  return true;
}

function matchesModule(input: AntiInboundMessage, config: GroupAntiConfig, key: AntiModuleKey): boolean {
  const root = unwrap(input.message);
  const context = contextInfo(input);
  switch (key) {
    case "antilink": return extractSenderLinks(input.message).length > 0 || hasHttpLink(senderText(input));
    case "antispam": {
      const mod = config.antispam;
      if (!mod) return false;
      return recordSpam(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.senderJid), mod.windowSeconds) >= mod.messageLimit;
    }
    case "antipic": return input.mediaKind === "image" || Boolean(root.imageMessage);
    case "antivid": return input.mediaKind === "video" || Boolean(root.videoMessage);
    case "antiaud": return input.mediaKind === "audio" || Boolean(root.audioMessage);
    case "antivn": {
      const audio = root.audioMessage;
      return Boolean(input.mediaKind === "audio" && input.mediaPtt) || Boolean(audio && typeof audio === "object" && (audio as Record<string, unknown>).ptt === true);
    }
    case "antitxt": {
      const prefix = input.prefix ?? "";
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
      const commandPattern = prefix ? new RegExp("^\\s*" + escapedPrefix + "\\S+", "u") : undefined;
      return isPlainText(input) && !(commandPattern?.test(senderText(input)) ?? false);
    }
    case "antiemoji": return containsEmoji(senderText(input));
    case "antisticker": return input.mediaKind === "sticker" || Boolean(root.stickerMessage);
    case "antigroupmention": return isGroupMention(input);
    case "antigm": return isGroupStatusMention(input);
    case "antiwords": {
      const words = config.antiwords?.words ?? [];
      const text = senderText(input).toLocaleLowerCase();
      return words.some((word) => word && text.includes(word));
    }
    case "antipoll": return hasAnyKey(input, ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"]);
    case "antiforward": return isForwarded(input);
    case "antichannel": return isChannel(input);
    case "antigstatus": return isGroupStatusPost(input);
    case "antigroupcall": return hasAnyKey(input, ["callLogMessage", "callLogMessageV2", "callLogMessageV3", "callLogMessageV4", "groupCallMessage", "callInviteMessage"]);
    case "antibot": return isLikelyBot(input);
    case "antinsfw":
    case "antipromote":
    case "antidemote":
      return false;
  }
}

function moduleConfig(config: GroupAntiConfig, key: AntiModuleKey): AntiModuleConfig | undefined {
  return config[key] as AntiModuleConfig | undefined;
}

function buildMetadata(snapshot: GroupSnapshot, session: WhatsAppSession, senderJid: string): AntiGroupMetadata {
  const admins = new Set(snapshot.participants.filter((p) => p.admin === "admin" || p.admin === "superadmin").map((p) => normalizeJid(p.phoneNumber ?? p.jid ?? p.id)));
  const botJids = new Set<string>();
  if (session.phoneNumber) botJids.add(`${session.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`);
  const protectedJids = new Set([...admins, ...botJids]);
  for (const identity of [...session.sudoList, ...getWorkspaceSudo(session.workspaceId)]) protectedJids.add(normalizeJid(identity));
  // Keep this parameter in the function signature to make the self-protection intent explicit.
  if (senderJid && botJids.has(normalizeJid(senderJid))) protectedJids.add(normalizeJid(senderJid));
  return { isBotAdmin: snapshot.isAdmin, admins, botJids, protectedJids };
}

function isProtected(metadata: AntiGroupMetadata, senderJid: string): boolean {
  return [...metadata.protectedJids].some((jid) => sameIdentity(jid, senderJid));
}

async function executeViolation(
  input: AntiInboundMessage,
  key: AntiModuleKey,
  config: AntiModuleConfig,
  snapshot: GroupSnapshot,
): Promise<AntiDecision> {
  const decision: AntiDecision = { module: key, detected: true, action: config.action };
  if (key === "antispam") resetSpam(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.senderJid));

  let action = config.action;
  let warningCount: number | undefined;
  if (action === "warn") {
    warningCount = incrementWarn(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.senderJid), key);
    decision.warningCount = warningCount;
    if (warningCount >= Math.max(1, config.warnThreshold)) {
      action = "kick";
      resetWarn(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.senderJid), key);
    }
  }

  try {
    const transport = await import("../transport-adapter.js");
    if (input.rawKey && (action === "delete" || action === "warn" || action === "kick"))
      await transport.deleteWhatsAppMessage(input.workspaceId, input.sessionId, input.groupJid, input.rawKey);
  } catch {
    // Delete failure does not stop a separately authorized kick/warn attempt.
  }

  const silent = loadGroupAntiConfig(input.workspaceId, input.sessionId, input.groupJid).silentActionMessages;
  if (!silent) {
    const transport = await import("../transport-adapter.js");
    const response = buildAntiViolationResponse({
      key,
      action,
      senderJid: input.senderJid,
      groupName: snapshot.subject,
      ...(warningCount !== undefined ? { warningCount } : {}),
      ...(config.warnThreshold !== undefined ? { warnThreshold: config.warnThreshold } : {}),
      ...(action === "kick" && warningCount !== undefined ? { note: `The warning threshold of ${config.warnThreshold ?? 3} was reached and the member was removed.` } : {}),
    });
    await Promise.resolve(transport.sendGroupText(input.workspaceId, input.sessionId, input.groupJid, response.text, undefined, response.mentions)).catch(() => undefined);
  }
  if (action === "kick") {
    const transport = await import("../transport-adapter.js");
    await transport.updateGroupParticipantBatch(input.workspaceId, input.sessionId, input.groupJid, [input.senderJid], "remove", false).catch(() => undefined);
  }
  return decision;
}

function cleanupSeen(now: number): void {
  for (const [key, expiresAt] of seenMessages) if (expiresAt <= now) seenMessages.delete(key);
}

export async function runAntiChecks(input: AntiInboundMessage): Promise<AntiDecision[]> {
  if (input.fromMe || !input.groupJid.endsWith("@g.us") || !input.senderJid) return [];
  const dedupeKey = input.messageId ? `${input.workspaceId}:${input.sessionId}:${input.groupJid}:${input.messageId}` : "";
  const now = Date.now();
  cleanupSeen(now);
  if (dedupeKey && seenMessages.has(dedupeKey)) return [];
  if (dedupeKey) seenMessages.set(dedupeKey, now + SEEN_TTL_MS);

  const config = loadGroupAntiConfig(input.workspaceId, input.sessionId, input.groupJid);
  const hasEnabledMessageModule = allModuleKeys().some((key) => {
    if (key === "antipromote" || key === "antidemote") return false;
    const module = moduleConfig(config, key);
    return module?.enabled === true && module.capability !== "unavailable";
  });
  if (!hasEnabledMessageModule) return [];

  let snapshot: GroupSnapshot;
  try {
    const { getGroupModerationSnapshot } = await import("../transport-adapter.js");
    snapshot = await getGroupModerationSnapshot(input.workspaceId, input.sessionId, input.groupJid, { fresh: true });
  } catch {
    return [];
  }
  if (!snapshot.isAdmin) return [];
  const session = getSession(input.workspaceId, input.sessionId);
  const metadata = buildMetadata(snapshot, session, input.senderJid);
  if (isProtected(metadata, input.senderJid)) return [];

  const senderPhone = firstVerifiedPhone(input.senderJid);
  if (senderPhone && isPhoneBanned(input.workspaceId, input.sessionId, input.groupJid, senderPhone)) {
    if (input.rawKey) {
      try {
        const transport = await import("../transport-adapter.js");
        await transport.deleteWhatsAppMessage(input.workspaceId, input.sessionId, input.groupJid, input.rawKey);
      } catch {
        // Banned-member deletion is best-effort and isolated from normal routing.
      }
    }
    return [];
  }

  const decisions: AntiDecision[] = [];
  for (const key of allModuleKeys()) {
    if (key === "antipromote" || key === "antidemote") continue;
    const module = moduleConfig(config, key);
    if (!module?.enabled || module.capability === "unavailable" || !rawSignalAvailable(input, key)) continue;
    if (module.permitList?.some((permit) => sameIdentity(permit, input.senderJid))) continue;
    try {
      if (!matchesModule(input, config, key)) continue;
      decisions.push(await executeViolation(input, key, module, snapshot));
    } catch {
      // A module is isolated by design; one detector/action cannot block routing.
    }
  }
  return decisions;
}

export function antiModuleCapability(key: AntiModuleKey): { capability: string; reason?: string } {
  return moduleCapability(key);
}

const seenParticipantEvents = new Map<string, number>();

function securityPlan(mode: string): { restore: boolean; warn: boolean; kick: boolean; demote: boolean; ban: boolean; warnLimit?: number } {
  if (mode.startsWith("restorewarn:")) return { restore: true, warn: true, kick: false, demote: false, ban: false, warnLimit: Math.max(1, Number(mode.slice(13)) || 3) };
  switch (mode) {
    case "restore": case "revert": return { restore: true, warn: false, kick: false, demote: false, ban: false };
    case "restorewarn": case "warn": case "wnp": case "p/p": return { restore: true, warn: true, kick: false, demote: false, ban: false };
    case "restoreban": case "ban": return { restore: true, warn: false, kick: true, demote: false, ban: true };
    case "restorekick": case "kick": case "p/k": return { restore: true, warn: false, kick: true, demote: false, ban: false };
    case "knp": case "kwp": return { restore: false, warn: mode === "kwp", kick: true, demote: false, ban: false };
    case "dnp": return { restore: true, warn: false, kick: false, demote: true, ban: false };
    case "dwp": case "d/d": return { restore: false, warn: false, kick: false, demote: true, ban: false };
    case "jw": return { restore: false, warn: true, kick: false, demote: false, ban: false };
    case "d/p": return { restore: true, warn: false, kick: false, demote: true, ban: false };
    default: return { restore: false, warn: false, kick: false, demote: false, ban: false };
  }
}

export async function runAntiParticipantEvent(input: import("./types.js").AntiParticipantEvent): Promise<boolean> {
  if (!input.groupJid.endsWith("@g.us") || !input.participants.length) return false;
  const bucket = Math.floor(Date.now() / 10_000);
  const eventKey = `${input.workspaceId}:${input.sessionId}:${input.groupJid}:${input.action}:${input.author ?? "unknown"}:${input.participants.join(",")}:${bucket}`;
  if (seenParticipantEvents.has(eventKey)) return false;
  seenParticipantEvents.set(eventKey, Date.now() + SEEN_TTL_MS);
  for (const [key, expiresAt] of seenParticipantEvents) if (expiresAt <= Date.now()) seenParticipantEvents.delete(key);

  const config = loadGroupAntiConfig(input.workspaceId, input.sessionId, input.groupJid);
  const key = input.action === "promote" ? "antipromote" : "antidemote";
  const module = config[key] as (AntiModuleConfig & { mode?: string; targetMode?: string }) | undefined;
  if (!module?.enabled) return false;
  if (module.capability === "unavailable") return false;

  let snapshot: GroupSnapshot;
  try {
    const { getGroupModerationSnapshot } = await import("../transport-adapter.js");
    snapshot = await getGroupModerationSnapshot(input.workspaceId, input.sessionId, input.groupJid, { fresh: true });
  } catch { return false; }
  const session = getSession(input.workspaceId, input.sessionId);
  const botIds = session.phoneNumber ? [`${session.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`] : [];
  const targets = input.participants.filter((participant) => {
    const isBot = botIds.some((bot) => sameIdentity(bot, participant));
    if (isBot) return true;
    return module.targetMode === "admins";
  });
  if (!targets.length) return false;
  if (input.author && botIds.some((bot) => sameIdentity(bot, input.author ?? ""))) return false;
  if (input.author && module.permitList?.some((permit) => sameIdentity(permit, input.author ?? ""))) return false;

  const plan = securityPlan(module.mode ?? "restorekick");
  const restoreAction = input.action === "promote" ? "demote" : "promote";
  try {
    const transport = await import("../transport-adapter.js");
    if (plan.restore) await transport.updateGroupParticipantBatch(input.workspaceId, input.sessionId, input.groupJid, targets, restoreAction, false);
    if (!input.author) return true;
    let securityAction = plan.kick ? "kick" : "restore";
    let securityWarningCount: number | undefined;
    if (plan.warn) {
      const count = incrementWarn(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.author), key);
      securityWarningCount = count;
      if (plan.warnLimit && count >= plan.warnLimit) {
        resetWarn(input.workspaceId, input.sessionId, input.groupJid, numberOf(input.author), key);
        securityAction = "kick";
        await transport.updateGroupParticipantBatch(input.workspaceId, input.sessionId, input.groupJid, [input.author], "remove", false);
      }
    }
    if (plan.demote) await transport.updateGroupParticipantBatch(input.workspaceId, input.sessionId, input.groupJid, [input.author], "demote", false);
    if (plan.kick) await transport.updateGroupParticipantBatch(input.workspaceId, input.sessionId, input.groupJid, [input.author], "remove", false);
    if (plan.ban || securityAction === "kick") {
      try {
        if (typeof transport.updateParticipantBlockStatus === "function") await transport.updateParticipantBlockStatus(input.workspaceId, input.sessionId, input.author, true);
      } catch { /* blocking is best-effort after the kick; the enforcement result remains handled */ }
    }
    if (!config.silentActionMessages) {
      const response = buildAntiSecurityResponse({
        key,
        action: securityAction,
        actorJid: input.author,
        groupName: snapshot.subject,
        ...(securityWarningCount !== undefined ? { warningCount: securityWarningCount } : {}),
        ...(plan.warnLimit !== undefined ? { warnThreshold: plan.warnLimit } : {}),
        note: securityAction === "kick" && securityWarningCount !== undefined
          ? `The warning threshold of ${plan.warnLimit ?? 3} was reached and the member was removed.`
          : "The protected admin change was restored and isolated to this group.",
      });
      await Promise.resolve(transport.sendGroupText(input.workspaceId, input.sessionId, input.groupJid, response.text, undefined, response.mentions)).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

export function antiStatusRows(workspaceId: string, sessionId: string, groupJid: string) {
  const config = loadGroupAntiConfig(workspaceId, sessionId, groupJid);
  return allModuleKeys().map((key) => {
    const module = moduleConfig(config, key);
    const capability = module?.capability ? { capability: module.capability, reason: module.capabilityReason } : moduleCapability(key);
    return {
      key,
      enabled: module?.enabled === true,
      action: module?.action ?? (key === "antipromote" || key === "antidemote" ? "restorekick" : "delete"),
      capability: capability.capability,
      ...(capability.reason ? { reason: capability.reason } : {}),
      permitCount: module?.permitList?.length ?? 0,
    };
  });
}
