import { randomUUID } from "node:crypto";
import type { WhatsAppSession } from "../types/domain.js";
import {
  getSession,
  getSessionJoinSettings,
  getWorkspaceDefaults,
  getWorkspaceSudo,
  updateSession,
  updateSessionJoinSettings,
  updateWorkspaceDefaults,
  updateWorkspaceSudo,
} from "../core/session-registry.js";
import {
  buildSessionMenu,
  effectiveSessionStatus,
  renderAsciiMenu,
} from "../menus/menu-model.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";
import { convertMediaToSticker, convertStickerToMedia, renderTextSticker } from "./sticker-media.js";
import { applyStickerPackMetadata, validateWhatsAppSticker } from "./sticker-exif.js";
import { inspectSticker } from "./sticker-info.js";
import { getStickerPackName, setStickerPackName } from "./sticker-settings.js";
import { firstVerifiedPhone, maskedPhoneLabel, phoneJidFromIdentity, verifiedTargetJid, verifiedTargetJids, verifiedTargetPhone } from "./identity-normalization.js";
import { buildModerationActionResponse, buildModerationJobResponse, buildModerationReviewResponse, formatModerationMessage, realMention } from "./moderation-response.js";
import { pappyHeader } from "./response-designs.js";
import {
  clearStickerCommandBinding,
  setStickerCommandBinding,
  stickerBindingCommandList,
} from "./sticker-command-bindings.js";
import { banUsageCard, commandUsageCard, pairingHelpCard, sessionCommandUsageCard, sessionPairingCard } from "./response-cards.js";
import type { GroupControlTable } from "./group-control-confirmation.js";
import { buildLyricsText, buildMusicPreviewMedia, buildPlayPreviewText, convertMediaToMp3, downloadPlay, fetchLyrics, playUsageText, resolvePlayMetadata, withMediaDownloadSlot, type PlayMetadata, type PlayMode } from "./play-media.js";
import { registerGroupControlConfirmation, consumeGroupControlConfirmation } from "./group-control-confirmation.js";
import {
  getPreviewDebugSnapshot,
  prepareCanonicalPreviewContent,
} from "./baileys-native-preview.js";
import { createSupportTicket } from "../persistence/mongo.js";
import { canonicalizeHttpUrl } from "../links/url-canonicalization.js";
import {
  applyModerationConfirmation,
  banList,
  banMember,
  blockAll,
  clearWarning,
  createPoll,
  deleteAllMember,
  filterCountry,
  filterOut,
  moderateParticipant,
  muteGroup,
  showWarnings,
  unbanMember,
  unblockMember,
  warnMember,
  deleteSingleMessage,
} from "./group-moderation-commands.js";
import {
  createWhatsAppGroup,
  getProfilePictureMedia,
  getProfilePictureMediaForJid,
  listGroups,
  removeProfilePicture,
  updateProfileBio,
  updateProfileName,
  updateProfilePicture,
  updateGroupProfilePicture,
  updateGroupDescription,
  getGroupInviteCode,
  getGroupModerationSnapshot,
  listGroupJoinRequests,
  deleteWhatsAppMessage,
} from "./transport-adapter.js";

export interface EnqueueJobResult {
  jobCode: string;
  totalGroups?: number;
  totalPosts?: number;
  delayMs?: number;
  expectedTimeMs?: number;
  inventoryPending?: boolean;
  inventoryDeferred?: boolean;
  workerLocal?: boolean;
}

export interface EnqueueJoinJobResult {
  jobCode: string;
  targetCount: number;
  delayMs: number;
  expectedTimeMs: number;
}

export interface EnqueueGroupControlResult {
  jobCode: string;
}

const MAX_GROUP_CONTROL_PARTICIPANTS = 1_000;
const MODERATION_COMMAND_NAMES = new Set([
  "kick", "promote", "demote", "dnkick", "block", "unblock", "ban", "unban", "banlist",
  "warn", "unwarn", "warns", "mute", "unmute", "filter", "filterout", "poll", "blockall",
  "dlt", "deleteall", "kickall", "kickamt", "kickcountry",
]);
const ANTI_CONTROL_NAMES = new Set([
  "spamlimit", "silentactions", "linkpermit", "rmlinkpermit", "botpermit", "rmbotpermit",
  "spampermit", "rmspampermit", "picpermit", "rmpicpermit", "vidpermit", "rmvidpermit",
  "audpermit", "rmaudpermit", "vnpermit", "rmvnpermit", "emojipermit", "rmemojipermit",
  "sticpermit", "rmsticpermit", "nsfwpermit", "rmnsfwpermit", "mentionpermit", "rmmentionpermit",
  "gmpermit", "rmgmpermit", "pollpermit", "rmpollpermit", "fwdpermit", "rmfwdpermit",
  "chanpermit", "rmchanpermit",
]);
const playSessionTails = new Map<string, Promise<void>>();

function isProtectedGroupCommand(name: string): boolean {
  return MODERATION_COMMAND_NAMES.has(name) || name.startsWith("anti") || ANTI_CONTROL_NAMES.has(name);
}

function protectedCommandFailure(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error ?? "")).replace(/[\r\n\t]+/g, " ").trim();
  if (detail && detail.length <= 420) return `Moderation could not be completed: ${detail}`;
  return "Moderation could not be completed because the WhatsApp permission or transport check failed. No further action was applied.";
}

async function withSessionPlaySlot<T>(ctx: CommandContext, task: () => Promise<T>): Promise<T> {
  const key = `${ctx.workspaceId}:${ctx.sessionId}`;
  const previous = playSessionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  playSessionTails.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (playSessionTails.get(key) === current) playSessionTails.delete(key);
  }
}

export interface WhatsAppCommandReply {
  text?: string;
  mentions?: string[];
  media?: WhatsAppMediaPayload;
  nativeFlow?: Array<{ text: string; copy?: string; id?: string; url?: string }>;
  nativeTable?: GroupControlTable;
}

export interface CommandContext {
  workspaceId: string;
  sessionId: string;
  /** Timestamp captured when the WhatsApp event entered the listener. */
  receivedAt?: number;
  isOwner: boolean;
  senderJid?: string;
  quotedSenderJid?: string;
  quotedText?: string;
  quotedMessageKey?: Record<string, unknown>;
  /** Redacted identity of a quoted sticker used only by setcmd. */
  quotedStickerFingerprint?: string;
  mentionedJids?: string[];
  chatJid?: string;
  media?: WhatsAppMediaPayload;
  /** Redacted identity of a directly received sticker used by setcmd/flushcmd routing. */
  stickerFingerprint?: string;
  args: string[];
  invokedName?: string;
  rawPayload?: string;
  pairSession?: (input: {
    label: string;
    phoneNumber: string;
  }) => Promise<{ sessionName: string; phoneNumber: string; code: string }>;
  enqueueJob?: (input: {
    kind: "gstatus" | "allstatus" | "allchat" | "tag";
    payload: Record<string, unknown>;
  }) => Promise<string | EnqueueJobResult>;
  enqueueJoinJob?: (input: {
    payload: Record<string, unknown>;
  }) => Promise<string | EnqueueJoinJobResult>;
  enqueueGroupControlJob?: (input: {
    groupJid: string;
    operation: "approve" | "reject" | "participant";
    participants: string[];
    participantAction?: "promote" | "demote" | "remove" | "block" | "demote-remove";
  }) => Promise<string | EnqueueGroupControlResult>;
  sendCurrentGroupStatus?: (input: {
    text: string;
    repeat: number;
  }) => Promise<void>;
  sendCurrentColorGroupStatus?: (input: {
    text: string;
    repeat: number;
  }) => Promise<void>;
  sendCurrentPersonalStatus?: (input: { text: string }) => Promise<void>;
  sendCurrentText?: (text: string) => Promise<void>;
  sendCurrentMedia?: (input: { media: WhatsAppMediaPayload; caption: string }) => Promise<void>;
  sendCurrentReaction?: (text: string) => Promise<void>;

  sendCurrentSticker?: (media: WhatsAppMediaPayload) => Promise<void>;
  enqueuePlayJob?: (input: { query: string; mode: PlayMode; sourceChatJid: string; metadata?: PlayMetadata }) => Promise<string>;

  sendCurrentGroupHidetag?: (input: {
    text: string;
    participantCount?: number;
  }) => Promise<void>;
  sendCurrentGroupPoll?: (input: { question: string; options: string[] }) => Promise<void>;
  cancelJobs?: (
    kind: "gstatus" | "allstatus" | "allchat" | "tag" | "join-manager",
  ) => Promise<number>;
}

export interface RegisteredCommand {
  name: string;
  aliases: string[];
  description: string;
  ownerOnly?: boolean;
  run: (ctx: CommandContext) => Promise<string | WhatsAppCommandReply>;
}

function session(ctx: CommandContext): WhatsAppSession {
  return getSession(ctx.workspaceId, ctx.sessionId);
}

function mediaCommandPayload(ctx: CommandContext): string {
  const inline = (ctx.rawPayload ?? ctx.args.join(" ")).trim();
  if (inline) return inline;
  const caption = ctx.media?.caption?.trim() ?? "";
  if (!caption) return "";
  const invokedName = ctx.invokedName?.trim() ?? "";
  const prefix = session(ctx).prefix;
  const commandToken = `${prefix}${invokedName}`.trim().toLowerCase();
  if (
    commandToken &&
    caption.toLowerCase().startsWith(commandToken) &&
    (!caption[commandToken.length] ||
      /\s/.test(caption[commandToken.length] ?? ""))
  )
    return caption.slice(commandToken.length).trim();
  return caption;
}

function groupJidForApproval(ctx: CommandContext): string {
  if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
    throw new Error("This command must be used inside a WhatsApp group.");
  return ctx.chatJid;
}

async function pendingApprovalRequests(ctx: CommandContext) {
  const groupJid = groupJidForApproval(ctx);
  const [snapshot, requests] = await Promise.all([
    getGroupModerationSnapshot(
      ctx.workspaceId,
      ctx.sessionId,
      groupJid,
      { fresh: true },
    ),
    listGroupJoinRequests(ctx.workspaceId, ctx.sessionId, groupJid),
  ]);
  if (!snapshot.isAdmin)
    throw new Error("This WhatsApp identity is not an administrator in this group.");
  return { groupJid, requests };
}

function approvalCountry(request: { jid: string; phoneNumber?: string }): string {
  const source = request.phoneNumber ?? (/@(s\.whatsapp\.net|c\.us)$/iu.test(request.jid) ? request.jid : "");
  return source.replace(/\D/g, "");
}

const COMMON_COUNTRY_CODES = ["234", "233", "254", "255", "256", "260", "27", "20", "1", "7", "33", "34", "39", "44", "49", "52", "55", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"];

function countryPrefixFromPhone(phone: string | undefined): string | undefined {
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (!digits) return undefined;
  return COMMON_COUNTRY_CODES.find((code) => digits.startsWith(code)) ?? digits.slice(0, 3);
}

function approvalCountrySummary(requests: Array<{ jid?: string; phoneNumber?: string }>): string {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const phone = firstVerifiedPhone(request.phoneNumber, request.jid);
    if (!phone) continue;
    const country = countryPrefixFromPhone(phone);
    if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([country, count]) => `+${country} × ${count}`)
    .join(" · ");
}

function approvalSummaryRows(requests: Array<{ jid?: string; phoneNumber?: string }>, selectionLabel: string): string[][] {
  const verified = requests.filter((request) => Boolean(firstVerifiedPhone(request.phoneNumber, request.jid))).length;
  return [
    ["Selected", String(requests.length)],
    ["Verified", String(verified)],
    ["Unresolved", String(Math.max(0, requests.length - verified))],
    ["Scope", selectionLabel],
    ["Countries", approvalCountrySummary(requests) || "none available"],
  ];
}

async function approvalConfirmationReply(
  ctx: CommandContext,
  operation: "approve" | "reject",
  requests: Array<{ jid: string; phoneNumber?: string }>,
  selectionLabel: string,
): Promise<WhatsAppCommandReply> {
  const senderJid = ctx.senderJid ?? "";
  if (!senderJid) return { text: "Confirmation is unavailable because the requesting identity could not be verified." };
  const table: GroupControlTable = {
    title: `Join Requests · ${operation === "approve" ? "Approve" : "Reject"} Confirmation`,
    headers: ["Metric", "Value"],
    rows: approvalSummaryRows(requests, selectionLabel),
    buttons: [],
    footer: `${requests.length} request(s) selected · Verified identities are retained securely for the batch and are not displayed. Confirm within 90 seconds or the plan expires.`,
  };
  const pending = registerGroupControlConfirmation({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    groupJid: groupJidForApproval(ctx),
    senderJid,
    operation,
    participants: requests
      .map((request) => phoneJidFromIdentity(firstVerifiedPhone(request.phoneNumber, request.jid)))
      .filter((jid): jid is string => Boolean(jid)),
    table,
  });
  pending.table.buttons = [
    { text: `✅ Confirm ${operation === "approve" ? "Approve" : "Reject"}`, id: `group-control:confirm:${pending.token}` },
    { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
  ];
  return {
    text: formatModerationMessage(`JOIN ${operation.toUpperCase()} REVIEW`, [
      ["Selected", String(requests.length)],
      ["Verified", String(requests.filter((request) => Boolean(firstVerifiedPhone(request.phoneNumber, request.jid))).length)],
      ["Unresolved", String(Math.max(0, requests.length - requests.filter((request) => Boolean(firstVerifiedPhone(request.phoneNumber, request.jid))).length))],
      ["Scope", selectionLabel],
      ["Countries", approvalCountrySummary(requests) || "none available"],
      ["Safety", "No action queued · confirm or cancel below"],
    ]),
    nativeTable: pending.table,
    nativeFlow: pending.table.buttons,
  };
}

function memberPreviewLabel(participant: { phoneNumber?: string; id: string; jid?: string }, index: number): string {
  const phone = firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id);
  return phone ? realMention(phone) : `#${index + 1} Verified phone unavailable`;
}

async function memberConfirmationReply(
  ctx: CommandContext,
  groupJid: string,
  participantAction: "remove" | "demote" | "promote" | "block" | "demote-remove",
  participants: Array<{ id: string; phoneNumber?: string; jid?: string }>,
  selectionLabel: string,
): Promise<WhatsAppCommandReply> {
  const senderJid = ctx.senderJid ?? "";
  if (!senderJid) return { text: "Confirmation is unavailable because the requesting identity could not be verified." };
  const pending = registerGroupControlConfirmation({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    groupJid,
    senderJid,
    operation: "participant",
    participantAction,
    participants: participants.map((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id)).filter((phone): phone is string => Boolean(phone)).map((phone) => phoneJidFromIdentity(phone)).filter((jid): jid is string => Boolean(jid)),
    ...(ctx.quotedMessageKey ? { quotedMessageKey: ctx.quotedMessageKey } : {}),
    table: {
      title: `Member Control · ${participantAction.toUpperCase()} Confirmation`,
      headers: ["Member", "Selection"],
      rows: participants.slice(0, 40).map((participant, index) => [memberPreviewLabel(participant, index), selectionLabel]),
      buttons: [],
      footer: `${participants.length} member(s) selected · Confirm within 90 seconds or the plan expires.`,
    },
  });
  pending.table.buttons = [
    { text: `✅ Confirm ${participantAction.toUpperCase()}`, id: `group-control:confirm:${pending.token}` },
    { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
  ];
  const phones = participants.map((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id)).filter((phone): phone is string => Boolean(phone));
  const response = buildModerationReviewResponse({ action: participantAction, selected: participants.length, scope: selectionLabel, phones });
  return {
    ...response,
    nativeTable: pending.table,
    nativeFlow: pending.table.buttons,
  };
}

async function queueApprovalOperation(
  ctx: CommandContext,
  operation: "approve" | "reject",
  participants: string[],
): Promise<string> {
  if (!ctx.enqueueGroupControlJob)
    return "Join Approval is unavailable until the worker runtime is ready.";
  const groupJid = groupJidForApproval(ctx);
  const boundedParticipants = [...new Set(participants)].slice(0, MAX_GROUP_CONTROL_PARTICIPANTS);
  if (!boundedParticipants.length)
    return `There are no pending WhatsApp join requests to ${operation}.`;
  const queued = await ctx.enqueueGroupControlJob({
    groupJid,
    operation,
    participants: boundedParticipants,
  });
  const jobCode = typeof queued === "string" ? queued : queued.jobCode;
  return [
    "✦ PAPPY OMEGA MINI · JOIN APPROVAL",
    "─────────────────────",
    `Action        · ${operation === "approve" ? "APPROVE" : "REJECT"}`,
    `Selected      · ${boundedParticipants.length}`,
    `Job           · ${jobCode}`,
    "Progress      · Open Telegram Live Show for detailed results.",
  ].join("\n");
}

function participantDigits(participant: { id: string; jid?: string; phoneNumber?: string }): string {
  return [participant.phoneNumber, participant.id, participant.jid]
    .filter(Boolean)
    .join(" ")
    .replace(/\D/g, "");
}

async function eligibleMemberTargets(ctx: CommandContext) {
  const groupJid = groupJidForApproval(ctx);
  const snapshot = await getGroupModerationSnapshot(
    ctx.workspaceId,
    ctx.sessionId,
    groupJid,
  );
  if (!snapshot.isAdmin)
    throw new Error("This WhatsApp identity is not an administrator in this group.");
  const selfDigits = (session(ctx).phoneNumber ?? "").replace(/\D/g, "");
  const targets = snapshot.participants
    .filter((participant) => {
      const isSelf = selfDigits.length >= 7 && participantDigits(participant).includes(selfDigits);
      return !participant.admin && !isSelf && Boolean(firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id));
    })
    .slice(0, MAX_GROUP_CONTROL_PARTICIPANTS);
  return { groupJid, snapshot, targets };
}

async function queueMemberOperation(
  ctx: CommandContext,
  groupJid: string,
  participantAction: "remove" | "demote" | "promote" | "block" | "demote-remove",
  participants: string[],
): Promise<string | WhatsAppCommandReply> {
  if (!ctx.enqueueGroupControlJob)
    return "Member batch control is unavailable until the worker runtime is ready.";
  const boundedParticipants = [...new Set(participants)].slice(0, MAX_GROUP_CONTROL_PARTICIPANTS);
  if (!boundedParticipants.length) return "No eligible non-admin members matched this action.";
  const queued = await ctx.enqueueGroupControlJob({
    groupJid,
    operation: "participant",
    participantAction,
    participants: boundedParticipants,
  });
  const jobCode = typeof queued === "string" ? queued : queued.jobCode;
    const mentionJids = boundedParticipants.map((participant) => phoneJidFromIdentity(firstVerifiedPhone(participant))).filter((jid): jid is string => Boolean(jid));
  const response = buildModerationJobResponse({
    action: participantAction,
    selected: boundedParticipants.length,
    jobId: jobCode,
    phones: boundedParticipants.map((participant) => firstVerifiedPhone(participant)).filter((phone): phone is string => Boolean(phone)),
  });
  return mentionJids.length ? { ...response, mentions: mentionJids } : response;
}
function formatSeconds(milliseconds: number): string {
  return `${Math.max(0, Math.round(milliseconds / 1000))}s`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function queuedJobAcknowledgement(
  kind: "allstatus" | "allchat",
  result: string | EnqueueJobResult,
): string {
  if (typeof result === "string")
    return `${kind === "allstatus" ? "All-status" : "All-chat"} job queued: ${result}`;
  if (result.workerLocal === true || result.inventoryDeferred === true)
    return [
      `✦ PAPPY OMEGA MINI · ${kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT"} STARTED`,
      "─────────────────────",
      `Delay         · ${Math.max(1, Math.round((result.delayMs ?? 10000) / 1000))}s`,
      `Live code     · ${result.jobCode}`,
      `Action        · ${kind === "allstatus" ? (result.workerLocal === true ? "Designed status delivery dispatched to the owning panel worker." : "Designed status delivery dispatched to the broadcast worker.") : (result.workerLocal === true ? "Hidden-member delivery dispatched to the owning panel worker." : "Hidden-member delivery dispatched to the broadcast worker.")}`,
      "Progress      · Open Telegram Live Show for live totals and completion.",
    ].join("\n");
  if (result.inventoryPending === true || result.totalGroups === undefined || result.totalPosts === undefined)
    return `⛔ ${kind === "allstatus" ? "All-status" : "All-chat"} was not started: WhatsApp group inventory was not resolved. No broadcast was dispatched. Retry after the session reports its groups online.`;
  const delay = Math.max(1, Math.round((result.delayMs ?? 10000) / 1000));
  const totalGroups = result.totalGroups;
  const totalPosts = result.totalPosts;
  const expectedTime =
    result.expectedTimeMs === undefined
      ? "0m 0s"
      : (() => {
          const expectedSeconds = Math.max(
            0,
            Math.ceil(result.expectedTimeMs / 1000),
          );
          const minutes = Math.floor(expectedSeconds / 60);
          const seconds = expectedSeconds % 60;
          return `${minutes}m ${seconds}s`;
        })();
  return [
    `✦ PAPPY OMEGA MINI · ${kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT"}`,
    "─────────────────────",
    `Total groups  · ${totalGroups}`,
    `Expected posts · ${totalPosts}`,
    `Delay         · ${delay}s`,
    `Expected time · ${expectedTime}`,
    `Live code     · ${result.jobCode}`,
    `Action        · ${kind === "allstatus" ? "Status delivery is now posting to every resolved group." : "Hidden-member mention delivery is now posting to every resolved group."}`,
  ].join("\n");
}

function repeatAndPayload(
  ctx: CommandContext,
  enabled: boolean,
): { repeat: number; text: string } {
  const raw = ctx.rawPayload ?? ctx.args.join(" ");
  if (!enabled) return { repeat: 1, text: mediaCommandPayload(ctx) };
  const match = /^(\d+)(?:[ \t]+|\n+)([\s\S]*)$/.exec(raw);
  if (!match) return { repeat: 1, text: mediaCommandPayload(ctx) };
  return {
    repeat: Math.max(1, Math.min(20, Number(match[1] ?? 1))),
    text: (match[2] ?? "").trim(),
  };
}

function lazyAntiCommands(): RegisteredCommand[] {
  const ANTI_CONFIG_COMMANDS = ["antilink", "antibot", "antispam", "antipic", "antivid", "antiaud", "antivn", "antitxt", "antiemoji", "antisticker", "antigroupcall", "antinsfw", "antigroupmention", "antigm", "antipoll", "antiforward", "antichannel", "antipromote", "antidemote", "antigstatus"] as const;
  const ANTI_MESSAGE_COMMANDS = ["antilink", "antispam", "antivn", "antitxt", "antiemoji", "antiwords", "antigroupmention", "antigm", "antipoll", "antiforward", "antichannel", "antigstatus"] as const;
  const ANTI_PERMIT_COMMANDS = [
    ["linkpermit", "rmlinkpermit", "antilink"], ["botpermit", "rmbotpermit", "antibot"], ["spampermit", "rmspampermit", "antispam"],
    ["picpermit", "rmpicpermit", "antipic"], ["vidpermit", "rmvidpermit", "antivid"], ["audpermit", "rmaudpermit", "antiaud"],
    ["vnpermit", "rmvnpermit", "antivn"], ["emojipermit", "rmemojipermit", "antiemoji"], ["sticpermit", "rmsticpermit", "antisticker"],
    ["nsfwpermit", "rmnsfwpermit", "antinsfw"], ["mentionpermit", "rmmentionpermit", "antigroupmention"], ["gmpermit", "rmgmpermit", "antigroupmention"],
    ["pollpermit", "rmpollpermit", "antipoll"], ["fwdpermit", "rmfwdpermit", "antiforward"], ["chanpermit", "rmchanpermit", "antichannel"],
  ] as const;
  const entries: RegisteredCommand[] = [
    { name: "antistatus", aliases: [], description: "Show all Anti System module status for this group.", run: async (ctx) => (await import("./anti-system/commands.js")).antiStatus(ctx) },
    { name: "spamlimit", aliases: [], description: "Set AntiSpam messages and seconds window.", run: async (ctx) => (await import("./anti-system/commands.js")).antiSpamLimit(ctx) },
    { name: "antiwords", aliases: [], description: "Configure AntiWords and its bracketed list.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWords(ctx) },
    { name: "antiaddword", aliases: [], description: "Add a blocked AntiWords phrase.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "add") },
    { name: "antirmword", aliases: [], description: "Remove a blocked AntiWords phrase.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "remove") },
    { name: "antiwordlist", aliases: [], description: "List blocked AntiWords phrases.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "list") },
    { name: "setantiwords", aliases: [], description: "Append comma-separated AntiWords phrases.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "set") },
    { name: "rmantiwords", aliases: [], description: "Remove comma-separated AntiWords phrases.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "rmset") },
    { name: "clearantiwords", aliases: [], description: "Clear all AntiWords phrases.", run: async (ctx) => (await import("./anti-system/commands.js")).antiWordManagement(ctx, "clear") },
    { name: "silentactions", aliases: [], description: "Hide or show Anti System notices.", run: async (ctx) => (await import("./anti-system/commands.js")).antiSilent(ctx) },
  ];
  for (const key of ANTI_CONFIG_COMMANDS) entries.push({ name: key, aliases: key === "antitxt" ? ["antitext"] : [], description: `Omega-V1 ${key} group control.`, run: async (ctx) => (await import("./anti-system/commands.js")).configureAnti(ctx, key) });
  for (const [addName, removeName, key] of ANTI_PERMIT_COMMANDS) {
    entries.push({ name: addName, aliases: [], description: `Permit a member for ${key}.`, run: async (ctx) => (await import("./anti-system/commands.js")).antiPermit(ctx, key, true) });
    entries.push({ name: removeName, aliases: [], description: `Remove a ${key} permit.`, run: async (ctx) => (await import("./anti-system/commands.js")).antiPermit(ctx, key, false) });
  }
  for (const key of ANTI_MESSAGE_COMMANDS) entries.push({ name: `${key}msg`, aliases: [], description: `Set a custom ${key} response.`, run: async (ctx) => (await import("./anti-system/commands.js")).antiMessage(ctx, key) });
  return entries;
}

export async function runPlayCommand(ctx: CommandContext, requestedMode?: PlayMode): Promise<string | WhatsAppCommandReply> {
  const requested = mediaCommandPayload(ctx);
  let mode = requestedMode ?? "audio";
  let query = requested;
  const [first, ...rest] = requested.split(/\s+/u);
  if (!requestedMode && (first?.toLowerCase() === "audio" || first?.toLowerCase() === "video")) {
    mode = first.toLowerCase() as PlayMode;
    query = rest.join(" ").trim();
  }
  if (!query) return playUsageText();
  if (!ctx.sendCurrentText && !ctx.sendCurrentMedia)
    return commandUsageCard({ title: "Play Unavailable", command: ".play", commandSyntax: ".play <song or video>", note: "The WhatsApp media transport is not ready for this session." });
  try {
    if (ctx.sendCurrentReaction)
      void ctx.sendCurrentReaction(mode === "audio" ? "🎵" : "🎬").catch(() => undefined);
    const metadata = await resolvePlayMetadata(query, mode);
    const previewCaption = buildPlayPreviewText(metadata, mode);
    if (ctx.sendCurrentMedia) {
      const previewMedia = await buildMusicPreviewMedia(metadata, mode);
      await ctx.sendCurrentMedia({ media: previewMedia, caption: previewCaption });
    } else if (ctx.sendCurrentText) {
      await ctx.sendCurrentText(previewCaption);
    }
    if (ctx.enqueuePlayJob && ctx.chatJid) {
      await ctx.enqueuePlayJob({ query, mode, sourceChatJid: ctx.chatJid, metadata });
      // The preview card already communicates extraction status. Do not add a
      // second text-only job card; the worker will deliver the clean media.
      return "";
    }
    const result = await withSessionPlaySlot(ctx, () => withMediaDownloadSlot(() => downloadPlay(query, mode, metadata)));
    return { text: `${mode === "audio" ? "🎵 Audio" : "🎬 Video"} ready · ${metadata.title}`, media: result.media };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The public source could not be resolved or downloaded within the safety limits.";
    return [
      ...pappyHeader(`${mode}:${query}`, `${mode === "audio" ? "MUSIC" : "VIDEO"} UNAVAILABLE`),
      `⎔ Command · ⇆ ${mode === "audio" ? ".play" : ".video"} <song or video>`,
      `⎔ Request · ⇆ ${query.slice(0, 160)}`,
      "─────────────",
      `» *Reason:* ${reason.slice(0, 420)}`,
      "» *Next:* Try a direct public URL or another public/authorized source.",
        ].join("\n");
  }
}
export async function runLyricsCommand(ctx: CommandContext): Promise<string> {
  const query = mediaCommandPayload(ctx);
  if (!query) return playUsageText();
  try {
    return buildLyricsText(await fetchLyrics(query));
  } catch {
    return commandUsageCard({ title: "Lyrics Unavailable", command: ".lyrics", commandSyntax: ".lyrics <song title or artist>", note: "No compliant lyrics record was available for that search. Full lyrics are not fabricated or scraped from private sources." });
  }
}

function formatDiagnosticTime(value?: number): string {
  return value ? new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC") : "—";
}

function buildPingResponse(current: WhatsAppSession, receivedAt?: number): string {
  const status = effectiveSessionStatus(current);
  const lastSync = current.lastHealthyAt ?? current.lastMessageReceivedAt ?? current.lastOutboundMessageAt ?? current.connectedAt;
  const state = status === "ACTIVE" ? "Socket stream is healthy." : "Re-establishing socket stream...";
  const latency = receivedAt ? Math.max(0, Date.now() - receivedAt) : undefined;
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ ⚡︎ ˎˊ˗  *PING & LATENCY*  ✦",
    "─────────────",
    `⎔ Session   · ⇆ ${current.sessionName}`,
    `⎔ Status    · ⇆ ${status}`,
    `⎔ Latency   · ⇆ ${latency === undefined ? "awaiting receipt timestamp" : `${latency}ms handler latency`}`,
    "⎔ Speed     · ⇆ queue-backed",
    `⎔ Last Sync · ⇆ ${formatDiagnosticTime(lastSync)}`,
    "─────────────",
    `» *State:* ${state}`,
  ].join("\n");
}

function buildProfileResponse(ctx: CommandContext): string {
  const current = session(ctx);
  const status = effectiveSessionStatus(current);
  const ownerPhone = firstVerifiedPhone(current.phoneNumber);
  const senderPhone = firstVerifiedPhone(ctx.senderJid);
  const role = ownerPhone && senderPhone === ownerPhone ? "Primary Owner" : "Sudo / Admin";
  const connectedAt = current.connectedAt;
  const uptime = connectedAt ? formatDuration(Math.max(0, Date.now() - connectedAt)) : "—";
  const memory = process.memoryUsage().rss / 1024 / 1024;
  const links = `${current.collectedLinkCount ?? 0} / ${current.validatedLinkCount ?? 0}`;
  return [
    "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
    "",
    "˗ˏˋ ⚙︎ ˎˊ˗  *LIVE DIAGNOSTICS*  ✦",
    "─────────────",
    "◈ *CORE IDENTITY*",
    `⎔ Session   · ⇆ ${current.sessionName}`,
    `⎔ Phone     · ⇆ ${current.phoneNumber ?? "pending"}`,
    `⎔ Role      · ⇆ ${role}`,
    "",
    "◈ *LIVE RUNTIME*",
    `⎔ Status    · ⇆ ${status}`,
    `⎔ Speed     · ⇆ ${current.lastHealthyAt ? `${Math.max(0, Date.now() - current.lastHealthyAt)}ms since health sync` : "awaiting health sync"}`,
    `⎔ Uptime    · ⇆ ${uptime}`,
    `⎔ RAM Load  · ⇆ ${memory.toFixed(1)} MB RSS`,
    "",
    "◈ *CONFIG & CHATS*",
    `⎔ Prefix    · ⇆ ${current.prefix || "none"}`,
    `⎔ AutoJoin  · ⇆ ${current.autoJoinEnabled ? "ON" : "OFF"}`,
    "⎔ Workflows · ⇆ Queue-backed",
    `⎔ Links     · ⇆ ${links}`,
    "─────────────",
  ].join("\n");
}

function buildSudoCompleteResponse(action: "add" | "remove", identityJid: string, scope: "Session" | "Global"): WhatsAppCommandReply {
  const identityDigits = firstVerifiedPhone(identityJid) ?? identityJid;
  const granted = action === "add";
  return {
    text: [
      "ㅤ   ⚫︎  𝗣𝗔𝗣𝗣𝗬 𝗢𝗠𝗘𝗚𝗔 𝗠𝗜𝗡𝗜  ⚫︎",
      "",
      `˗ˏˋ 𓋎 ˎˊ˗  *SUDO ${granted ? "ADD" : "REMOVE"} COMPLETE*  ✦`,
      "─────────────",
      `⎔ Scope     · ⇆ ${scope}`,
      `⎔ Target    · ⇆ @${identityDigits}`,
      `⎔ Privilege · ⇆ ${granted ? "Sudo / Admin" : "Revoked"}`,
      `⎔ Status    · ⇆ ${granted ? "Granted" : "Removed"}`,
      "─────────────",
      `» *${granted ? "Success" : "Complete"}:* User ${granted ? "added to" : "removed from"} the ${scope.toLowerCase()} sudo list.`,
    ].join("\n"),
    mentions: [identityJid],
  };
}

async function runSudoCommand(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const global = ctx.args[0]?.toLowerCase() === "global";
  const offset = global ? 1 : 0;
  const requestedAction = ctx.args[offset]?.toLowerCase();
  if (global && requestedAction === "list") {
    const identities = getWorkspaceSudo(ctx.workspaceId)
      .map((identity) => firstVerifiedPhone(identity))
      .filter((identity): identity is string => Boolean(identity));
    return identities.length
      ? `Global sudo phone identities:\n${identities.map((identity) => `+${identity}`).join("\n")}`
      : "No verified global sudo phone identities configured.";
  }
  if (!global && requestedAction === "list") {
    const identities = session(ctx).sudoList
      .map((identity) => firstVerifiedPhone(identity))
      .filter((identity): identity is string => Boolean(identity));
    return identities.length
      ? `Session sudo phone identities:\n${identities.map((identity) => `+${identity}`).join("\n")}`
      : "No verified session sudo phone identities configured.";
  }
  const explicitAction = requestedAction === "add" || requestedAction === "remove";
  const action = explicitAction ? requestedAction : ctx.invokedName === "rmsudo" ? "remove" : "add";
  const targetArgs = explicitAction ? ctx.args.slice(offset + 1) : ctx.args.slice(offset);
  const identityJid = verifiedTargetJid(targetArgs, ctx.mentionedJids, ctx.quotedSenderJid);
  const identityDigits = firstVerifiedPhone(identityJid);
  if (!identityJid || !identityDigits || !["add", "remove"].includes(action))
    return commandUsageCard({ title: ctx.invokedName === "rmsudo" ? "RMsudo Command" : "Setsudo Command", command: ctx.invokedName === "rmsudo" ? ".rmsudo" : ".setsudo", commandSyntax: ctx.invokedName === "rmsudo" ? ".rmsudo [global] <target>" : ".setsudo [global] <target>", acceptedTargets: ["Tag / Mention · Real WhatsApp mention", "Reply · Reply to a verified phone identity", "Phone · Explicit international number for global scope"], note: ctx.invokedName === "rmsudo" ? "Removes the verified target; no add/remove keyword is required." : "Adds the verified target; no add/remove keyword is required. LID-only identities are not accepted." });
  if (global) {
    updateWorkspaceSudo(ctx.workspaceId, action, identityJid);
    return buildSudoCompleteResponse(action, identityJid, "Global");
  }
  const current = session(ctx).sudoList;
  const next = action === "add"
    ? [...new Set([...current, identityJid])]
    : current.filter((item) => firstVerifiedPhone(item) !== identityDigits);
  updateSession(ctx.workspaceId, ctx.sessionId, { sudoList: next });
  return buildSudoCompleteResponse(action, identityJid, "Session");
}

export function createCommandRegistry(): RegisteredCommand[] {
  return [
    ...lazyAntiCommands(),
    {
      name: "kick",
      aliases: ["remove"],
      description: "Review removal of one verified group member.",
      run: async (ctx) => moderateParticipant(ctx, "remove"),
    },
    {
      name: "promote",
      aliases: [],
      description: "Review promotion of one verified group member.",
      run: async (ctx) => moderateParticipant(ctx, "promote"),
    },
    {
      name: "demote",
      aliases: [],
      description: "Review demotion of one verified group administrator.",
      run: async (ctx) => moderateParticipant(ctx, "demote"),
    },
    {
      name: "block",
      aliases: [],
      description: "Review removal and block of one verified group member.",
      run: async (ctx) => moderateParticipant(ctx, "block"),
    },
    {
      name: "unblock",
      aliases: [],
      description: "Remove WhatsApp block from a verified phone identity.",
      run: async (ctx) => unblockMember(ctx),
    },
    {
      name: "dnkick",
      aliases: [],
      description: "Review sequential demotion then removal of one administrator.",
      run: async (ctx) => moderateParticipant(ctx, "demote-remove"),
    },
    {
      name: "ban",
      aliases: [],
      description: "Locally restrict a verified member without removing them.",
      run: async (ctx) => banMember(ctx),
    },
    {
      name: "unban",
      aliases: [],
      description: "Remove a local restriction from one verified group member.",
      run: async (ctx) => unbanMember(ctx),
    },
    {
      name: "banlist",
      aliases: ["bans"],
      description: "Show the masked local ban list for this WhatsApp group.",
      run: async (ctx) => banList(ctx),
    },
    {
      name: "warn",
      aliases: [],
      description: "Issue one durable manual warning to a verified member.",
      run: async (ctx) => warnMember(ctx),
    },
    {
      name: "unwarn",
      aliases: ["resetwarn"],
      description: "Reset durable manual warnings for a verified member.",
      run: async (ctx) => clearWarning(ctx),
    },
    {
      name: "warns",
      aliases: [],
      description: "Show durable manual warning count for a verified member.",
      run: async (ctx) => showWarnings(ctx),
    },
    {
      name: "mute",
      aliases: [],
      description: "Review group-wide administrators-only chat mode.",
      run: async (ctx) => muteGroup(ctx, true),
    },
    {
      name: "unmute",
      aliases: [],
      description: "Review reopening group chat to all members.",
      run: async (ctx) => muteGroup(ctx, false),
    },
    {
      name: "filter",
      aliases: [],
      description: "Read-only verified country-prefix member count.",
      run: async (ctx) => filterCountry(ctx),
    },
    {
      name: "filterout",
      aliases: [],
      description: "Review bounded removal of verified members by country prefix.",
      run: async (ctx) => filterOut(ctx),
    },
    {
      name: "poll",
      aliases: [],
      description: "Create a native WhatsApp poll in the current group.",
      run: async (ctx) => createPoll(ctx),
    },
    {
      name: "blockall",
      aliases: [],
      description: "Bounded review of eligible participant blocking; no bulk action is queued automatically.",
      run: async (ctx) => blockAll(ctx),
    },
    {
      name: "dlt",
      aliases: ["del", "delete"],
      description: "Delete one quoted message from the current WhatsApp group.",
      run: async (ctx) => deleteSingleMessage(ctx),
    },
    {
      name: "deleteall",
      aliases: [],
      description: "Without a target, review deletion of all recent cached bot messages in this group; with a target, review that member’s tracked messages.",
      run: async (ctx) => deleteAllMember(ctx),
    },
    {
      name: "play",
      aliases: ["music", "audio"],
      description: "Resolve a public or authorized source, preview metadata, then deliver audio.",
      run: async (ctx) => runPlayCommand(ctx),
    },
    {
      name: "video",
      aliases: [],
      description: "Resolve a public or authorized source, preview metadata, then deliver video.",
      run: async (ctx) => runPlayCommand(ctx, "video"),
    },
    {
      name: "lyrics",
      aliases: ["lyric"],
      description: "Look up available lyrics from the configured compliant catalogue.",
      run: async (ctx) => runLyricsCommand(ctx),
    },
    {
      name: "support",
      aliases: ["helpdesk", "ticket"],
      description: "Create a support ticket for this WhatsApp sender.",
      run: async (ctx) => {
        const message = ctx.args.join(" ").trim();
        if (!message) return commandUsageCard({ title: "Support Command", command: ".support", commandSyntax: ".support <describe-your-issue>", note: "Describe the issue in one message so it can be routed to the support inbox." });
        const now = Date.now();
        const ticketId = randomUUID();
        await createSupportTicket({
          ticketId,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          ...(ctx.senderJid ? { senderJid: ctx.senderJid } : {}),
          message: message.slice(0, 4000),
          status: "open",
          createdAt: now,
          updatedAt: now,
        });
        return `Support ticket opened: ${ticketId}. An owner can review it from the Support Inbox.`;
      },
    },
    {
      name: "pair",
      aliases: [],
      description: "Create and pair a WhatsApp session from this owner chat.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.pairSession)
          return "WhatsApp pairing is unavailable from this transport.";
        const raw = mediaCommandPayload(ctx);
        const parts = raw.split(/\s+/).filter(Boolean);
        const label = parts[0] ?? "whatsapp-session";
        const phoneNumber = parts[1] ?? "";
        if (!/^\d{8,15}$/.test(phoneNumber.replace(/\D/g, "")))
          return `${pairingHelpCard(session(ctx).prefix)}\n\n» *Error:* Send a valid international phone number without the + symbol.`;
        try {
          const paired = await ctx.pairSession({ label, phoneNumber });
          return sessionPairingCard({ session: paired.sessionName, phone: paired.phoneNumber, code: paired.code });
        } catch (error) {
          return `${pairingHelpCard(session(ctx).prefix)}\n\n» *Error:* ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "setcmd",
      aliases: ["bindcmd"],
      description: "Bind one safe command to a quoted sticker for this session.",
      ownerOnly: true,
      run: async (ctx) => {
        const fingerprint = ctx.quotedStickerFingerprint;
        const rawPayload = (ctx.rawPayload ?? "").trim();
        const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rawPayload);
        if (!fingerprint || !match?.[1])
          return commandUsageCard({
            title: "Sticker Command Binding",
            command: `${session(ctx).prefix}setcmd`,
            commandSyntax: `${session(ctx).prefix}setcmd <command> [payload]` ,
            howToUse: ["Reply to a sticker with the command.", "A new binding replaces the previous sticker binding for this session."],
            examples: [`${session(ctx).prefix}setcmd tag`, `${session(ctx).prefix}setcmd tag hi`],
            note: "Only safe, owner-approved commands can be sticker triggers. Use flushcmd to clear the active binding.",
          });
        try {
          const binding = setStickerCommandBinding({
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            fingerprint,
            command: match[1],
            payload: match[2] ?? "",
          });
          return [
            ...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:setcmd`, "STICKER COMMAND BOUND"),
            `⎔ Command    · ⇆ ${session(ctx).prefix}${binding.command}${binding.payload ? ` ${binding.payload}` : ""}`,
            "⎔ Trigger    · ⇆ Quoted sticker",
            "⎔ Scope      · ⇆ Current WhatsApp session",
            "⎔ Override   · ⇆ Replaces the previous binding",
            "─────────────",
            "» *Use:* Send the same sticker as an owner or sudo. If no static payload was set, quoted text supplies the command payload.",
          ].join("\n");
        } catch (error) {
          return commandUsageCard({
            title: "Sticker Binding Rejected",
            command: `${session(ctx).prefix}setcmd`,
            commandSyntax: `${session(ctx).prefix}setcmd <command> [payload]`,
            note: `${error instanceof Error ? error.message : "The command could not be bound."} Allowed targets: ${stickerBindingCommandList().join(", ")}.`,
          });
        }
      },
    },
    {
      name: "flushcmd",
      aliases: ["unbindcmd"],
      description: "Clear the active sticker command binding for this session.",
      ownerOnly: true,
      run: async (ctx) => {
        const cleared = clearStickerCommandBinding(ctx.workspaceId, ctx.sessionId);
        return [
          ...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:flushcmd`, "STICKER COMMAND CLEARED"),
          `⎔ Status     · ⇆ ${cleared ? "Binding removed" : "No active binding"}`,
          "⎔ Scope      · ⇆ Current WhatsApp session",
          "⎔ Trigger    · ⇆ Previous sticker is inactive",
        ].join("\n");
      },
    },
    {
      name: "ping",
      aliases: [],
      description: "Fast session health check.",
      run: async (ctx) => buildPingResponse(session(ctx), ctx.receivedAt),
    },
    {
      name: "menu",
      aliases: ["help", "m"],
      description: "Open the polished RichMenu home.",
      run: async (ctx) =>
        renderAsciiMenu(buildSessionMenu(session(ctx), ctx.isOwner)),
    },
    {
      name: "menulist",
      aliases: [],
      description: "Choose the interactive rich menu or the classic text menu.",
      run: async (ctx) => `Use ${session(ctx).prefix}menulist rich for the interactive menu or ${session(ctx).prefix}menulist text for the classic list.`,
    },
    {
      name: "previewdebug",
      aliases: ["previewdiag"],
      description: "Inspect the canonical Baileys-native preview pipeline.",
      ownerOnly: true,
      run: async (ctx) => {
        const url = ctx.args.join(" ").trim();
        if (!url) return commandUsageCard({ title: "Preview Debug", command: ".previewdebug", commandSyntax: ".previewdebug <https://example.com/...>", note: "Provide one public URL to inspect its preview metadata." });
        const scope = `${ctx.workspaceId}:${ctx.sessionId}`;
        await prepareCanonicalPreviewContent({
          text: url,
          content: { text: url },
          cacheScope: scope,
        });
        const debug = getPreviewDebugSnapshot(scope);
        if (!debug) return "LINK PREVIEW DEBUG\nResult: FALLBACK\nReason: no snapshot.";
        return [
          "LINK PREVIEW DEBUG",
          `URL: ${debug.url}`,
          `Canonical: ${debug.canonicalUrl}`,
          `Title: ${debug.title ?? "—"}`,
          `Description: ${debug.description ?? "—"}`,
          `Selected Image: ${debug.selectedImageUrl ?? "—"}`,
          `Source Dimensions: ${debug.sourceWidth ?? "—"} × ${debug.sourceHeight ?? "—"}`,
          `Source Bytes: ${debug.sourceBytes ?? "—"}`,
          `Processing: ${debug.processing}`,
          `Crop: ${debug.crop}`,
          `Compression: ${debug.compression}`,
          `Baileys Preview Flag: ${debug.nativeFlag}`,
          `Baileys Payload: ${debug.payload}`,
          `Cache: ${debug.cache}`,
          `Result: ${debug.result}`,
          ...(debug.reason ? [`Reason: ${debug.reason}`] : []),
        ].join("\n");
      },
    },
    {
      name: "profile",
      aliases: ["me", "session"],
      description: "Show session identity and health.",
      run: async (ctx) => buildProfileResponse(ctx),
    },
    {
      name: "autojoin",
      aliases: ["aj"],
      description: "Toggle conservative invite-link auto-join handling.",
      run: async (ctx) => {
        const current = session(ctx);
        const requested = ctx.args[0]?.toLowerCase();
        const enabled =
          requested === "on"
            ? true
            : requested === "off"
              ? false
              : !current.autoJoinEnabled;
        const next = updateSession(ctx.workspaceId, ctx.sessionId, {
          autoJoinEnabled: enabled,
        });
        if (enabled && ctx.enqueueJoinJob) {
          const settings = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
          const started = await ctx.enqueueJoinJob({
            payload: {
              targetCount: settings.targetCount,
              delayMs: settings.delayMs,
              minDelayMs: settings.minDelayMs,
              maxDelayMs: settings.maxDelayMs,
              retryLimit: settings.retryLimit,
              retryBaseMs: settings.retryBaseMs,
              sessionCooldownMs: settings.sessionCooldownMs,
              restrictionThreshold: settings.restrictionThreshold,
              requestMode: settings.mode,
              sourceBucket: "active",
            },
          });
          if (typeof started === "string") return `${started}`;
          const expected = formatDuration(started.expectedTimeMs);
          return `Auto-join is ON for ${next.sessionName}.\nTarget       · ${started.targetCount} Active link(s)\nDelay        · ${formatSeconds(started.delayMs)}\nExpected time · ${expected}\nLive code    · ${started.jobCode}`;
        }
        return `Auto-join is now ${next.autoJoinEnabled ? "ON" : "OFF"} for ${next.sessionName}.\nUse ${next.prefix}autojoin on|off to set it explicitly.`;
      },
    },
    {
      name: "join",
      aliases: ["joinmanager", "joinstart"],
      description: "Start a real Active-bucket Join Manager worker.",
      run: async (ctx) => {
        if (!ctx.enqueueJoinJob) return "Join Manager is unavailable until the worker runtime is ready.";
        const current = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
        const started = await ctx.enqueueJoinJob({
          payload: {
            targetCount: current.targetCount,
            delayMs: current.delayMs,
            minDelayMs: current.minDelayMs,
            maxDelayMs: current.maxDelayMs,
            retryLimit: current.retryLimit,
            retryBaseMs: current.retryBaseMs,
            sessionCooldownMs: current.sessionCooldownMs,
            restrictionThreshold: current.restrictionThreshold,
            requestMode: current.mode,
            sourceBucket: "active",
          },
        });
        if (typeof started === "string") return started;
        return `Join Manager started.\nTarget       · ${started.targetCount} Active link(s)\nDelay        · ${formatSeconds(started.delayMs)}\nExpected time · ${formatDuration(started.expectedTimeMs)}\nLive code    · ${started.jobCode}`;
      },
    },
    {
      name: "stopjoin",
      aliases: ["stopjoinmanager", "joinstop"],
      description: "Cancel active Join Manager work for this session only.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.cancelJobs) return "Join Manager cancellation is unavailable until the worker runtime is ready.";
        const count = await ctx.cancelJobs("join-manager");
        return [
          "✦ PAPPY OMEGA MINI · JOIN MANAGER",
          "─────────────────────",
          "Action      · STOP JOIN",
          `Cancelled   · ${count} active job${count === 1 ? "" : "s"}`,
          "Scope       · Current WhatsApp session only",
          `Status      · ${count ? "Stopped" : "No active Join Manager job"}`,
        ].join("\n");
      },
    },
    {
      name: "targetgs",
      aliases: ["jointarget", "jointargets"],
      description: "Set or inspect the Active-bucket Join Manager target.",
      run: async (ctx) => {
        const current = getSessionJoinSettings(ctx.workspaceId, ctx.sessionId);
        const raw = mediaCommandPayload(ctx).trim();
        if (!raw)
          return commandUsageCard({ title: "Target Groups", command: `${session(ctx).prefix}targetgs`, commandSyntax: `${session(ctx).prefix}targetgs <1-10000>`, note: `Current target: ${current.targetCount} Active link(s).` });
        if (!/^\d+$/.test(raw))
          return commandUsageCard({ title: "Target Groups", command: `${session(ctx).prefix}targetgs`, commandSyntax: `${session(ctx).prefix}targetgs <1-10000>`, note: "Choose the maximum number of Active links for Join Manager." });
        const targetCount = Number(raw);
        if (targetCount < 1 || targetCount > 10000)
          return "Join target must be between 1 and 10000 links.";
        const next = updateSessionJoinSettings(ctx.workspaceId, ctx.sessionId, { targetCount });
        return `Join target updated: ${next.joinSettings?.targetCount ?? targetCount} Active link(s).`;
      },
    },
    {
      name: "iggc",
      aliases: ["ignoregc", "ignoregroup"],
      description: "Ignore or list WhatsApp groups excluded from broadcasts.",
      ownerOnly: true,
      run: async (ctx) => {
        const current = session(ctx);
        const raw = mediaCommandPayload(ctx).trim();
        if (!raw || raw.toLowerCase() === "list")
          return current.ignoredGroupLinks?.length
            ? `Ignored groups (${current.ignoredGroupLinks.length}):\n${current.ignoredGroupLinks.join("\n")}`
            : "No ignored WhatsApp groups configured.";
        if (raw.toLowerCase() === "clear") {
          updateSession(ctx.workspaceId, ctx.sessionId, { ignoredGroupLinks: [] });
          return "Ignored WhatsApp group list cleared.";
        }
        const canonical = canonicalizeHttpUrl(raw);
        if (!canonical.toLowerCase().startsWith("https://chat.whatsapp.com/") || !/[A-Za-z0-9_-]+$/.test(canonical))
          return commandUsageCard({ title: "Ignore Group", command: `${current.prefix}iggc`, commandSyntax: `${current.prefix}iggc <invite-link> | list | clear`, note: "Add, list, or clear ignored WhatsApp group invite links." });
        const ignored = [...new Set([...(current.ignoredGroupLinks ?? []), canonical])];
        updateSession(ctx.workspaceId, ctx.sessionId, { ignoredGroupLinks: ignored });
        return `Group ignored for this session's broadcasts:\n${canonical}`;
      },
    },
    {
      name: "setprefix",
      aliases: ["prefix"],
      description:
        "Set the session prefix; use none or null for prefixless mode.",
      run: async (ctx) => {
        const requested = ctx.args[0]?.toLowerCase();
        const value =
          requested === "none" || requested === "null"
            ? ""
            : (ctx.args[0] ?? ".").slice(0, 3);
        const next = updateSession(ctx.workspaceId, ctx.sessionId, {
          prefix: value,
        });
        return `Your prefix is now ${next.prefix || "none"}.`;
      },
    },
    {
      name: "pfp",
      aliases: ["setpfp", "getpfp", "removepfp"],
      description: "Get, change, or remove the session profile picture.",
      run: async (ctx) => {
        try {
          const action = (ctx.args[0] ?? "get").toLowerCase();
          if (action === "get") {
            const media = await getProfilePictureMedia(
              ctx.workspaceId,
              ctx.sessionId,
            );
            return media
              ? {
                  media,
                  caption: [
                    ...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}`, "PROFILE PICTURE"),
                    "⎔ Media      · ⇆ Current WhatsApp profile picture",
                    "⎔ Delivery   · ⇆ Image attachment",
                  ].join("\n"),
                }
              : "No profile picture is currently set.";
          }
          if (action === "remove" || action === "delete") {
            await removeProfilePicture(ctx.workspaceId, ctx.sessionId);
            return "Profile picture removed.";
          }
          if (action === "set" || action === "change") {
            if (ctx.media?.kind === "image") {
              await updateProfilePicture(
                ctx.workspaceId,
                ctx.sessionId,
                ctx.media.bytes,
              );
              return "Profile picture updated in HD from the original replied image; no bot-side crop was applied.";
            }
            return "Reply to an image with .pfp set, .setpfp, or .pfp change. A real uploaded image is required; URLs are not accepted.";
          }
          return commandUsageCard({ title: "Profile Picture", command: ".pfp", commandSyntax: ".pfp get | .pfp set | .pfp remove", howToUse: ["Reply to an image with .pfp set or .setpfp.", "Use .pfp get to retrieve the current picture.", "Use .pfp remove to clear it."], note: "The set operation requires a real replied image." });
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "mp3",
      aliases: ["toaudio", "extractaudio"],
      description: "Convert quoted audio or video media to MP3.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.media || (ctx.media.kind !== "audio" && ctx.media.kind !== "video"))
          return commandUsageCard({ title: "MP3 CONVERSION USAGE", command: `${session(ctx).prefix}mp3`, commandSyntax: `${session(ctx).prefix}mp3 (reply to audio or video)`, howToUse: ["Reply to a voice note or audio file with .mp3.", "Reply to a video with .mp3 to extract its audio track."], note: "The result is delivered as a clean MP3 attachment." });
        try {
          const media = await convertMediaToMp3(ctx.media);
          return {
            media,
            caption: [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:mp3`, "MP3 CONVERSION"), `⎔ Output     · ⇆ ${media.fileName ?? "pappy-audio.mp3"}`, "⎔ Source     · ⇆ Quoted audio or video media", "⎔ Status     · ⇆ Ready"].join("\n"),
          };
        } catch (error) {
          return commandUsageCard({ title: "MP3 CONVERSION FAILED", command: `${session(ctx).prefix}mp3`, commandSyntax: `${session(ctx).prefix}mp3 (reply to audio or video)`, note: error instanceof Error ? error.message : "The media could not be converted to MP3 safely." });
        }
      },
    },
    {
      name: "cs",
      aliases: ["convertsticker", "stickerconvert"],
      description: "Convert a quoted sticker back to image or video media.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.media || ctx.media.kind !== "sticker")
          return commandUsageCard({ title: "Convert Sticker", command: `${session(ctx).prefix}cs`, commandSyntax: `${session(ctx).prefix}cs (reply to a sticker)`, note: "Static stickers return as PNG media; animated stickers return as MP4 video." });
        try {
          const media = await convertStickerToMedia(ctx.media);
          return {
            media,
            caption: [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:cs`, "STICKER CONVERTED"), `⎔ Output     · ⇆ ${media.kind === "video" ? "MP4 video" : "PNG image"}`, "⎔ Source     · ⇆ Quoted WhatsApp sticker"].join("\n"),
          };
        } catch (error) {
          return commandUsageCard({ title: "Sticker Conversion Failed", command: `${session(ctx).prefix}cs`, commandSyntax: `${session(ctx).prefix}cs (reply to a sticker)`, note: error instanceof Error ? error.message : "The sticker could not be converted safely." });
        }
      },
    },
    {
      name: "stickerinfo",
      aliases: ["sinfo", "sticker-info"],
      description: "Show technical and embedded metadata for a quoted sticker.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.media || ctx.media.kind !== "sticker") return commandUsageCard({ title: "Sticker Information", command: `${session(ctx).prefix}stickerinfo`, commandSyntax: `${session(ctx).prefix}stickerinfo (reply to a sticker)`, note: "Reply to a sticker to inspect its media and pack metadata." });
        try {
          const info = await inspectSticker(ctx.media);
          return [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:sticker-info`, "STICKER INFORMATION"), `⎔ Format     · ⇆ ${info.format ?? "WebP"}`, `⎔ MIME       · ⇆ ${info.mimeType}`, `⎔ Size       · ⇆ ${info.bytes.toLocaleString()} bytes`, `⎔ Canvas     · ⇆ ${info.width ?? "?"} × ${info.height ?? "?"}`, `⎔ Animation  · ⇆ ${info.animated ? `Yes · ${info.frames ?? 0} frames` : "No · static"}`, `⎔ Alpha      · ⇆ ${info.hasAlpha === undefined ? "Unknown" : info.hasAlpha ? "Yes" : "No"}`, `⎔ Pack       · ⇆ ${info.packName ?? "Not embedded"}`, `⎔ Publisher  · ⇆ ${info.publisher ?? "Not embedded"}`, `⎔ Emojis     · ⇆ ${info.emojis.length ? info.emojis.join(" ") : "None embedded"}`].join("\n");
        } catch (error) {
          return commandUsageCard({ title: "Sticker Information Unavailable", command: `${session(ctx).prefix}stickerinfo`, commandSyntax: `${session(ctx).prefix}stickerinfo (reply to a sticker)`, note: error instanceof Error ? error.message : "The sticker metadata could not be read safely." });
        }
      },
    },
    {
      name: "sticker",
      aliases: ["s", "makesticker"],
      description: "Create a sticker from an image, GIF, video, text, or emoji.",
      ownerOnly: true,
      run: async (ctx) => {
        if (["info", "metadata", "details"].includes((ctx.args[0] ?? "").toLowerCase())) {
          if (!ctx.media || ctx.media.kind !== "sticker") return commandUsageCard({ title: "Sticker Information", command: `${session(ctx).prefix}sticker info`, commandSyntax: `${session(ctx).prefix}sticker info (reply to a sticker)`, note: "Reply to a sticker to inspect its media and pack metadata." });
          try {
            const info = await inspectSticker(ctx.media);
            return [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:sticker-info`, "STICKER INFORMATION"), `⎔ Format     · ⇆ ${info.format ?? "WebP"}`, `⎔ MIME       · ⇆ ${info.mimeType}`, `⎔ Size       · ⇆ ${info.bytes.toLocaleString()} bytes`, `⎔ Canvas     · ⇆ ${info.width ?? "?"} × ${info.height ?? "?"}`, `⎔ Animation  · ⇆ ${info.animated ? `Yes · ${info.frames ?? 0} frames` : "No · static"}`, `⎔ Pack       · ⇆ ${info.packName ?? "Not embedded"}`, `⎔ Publisher  · ⇆ ${info.publisher ?? "Not embedded"}`, `⎔ Emojis     · ⇆ ${info.emojis.length ? info.emojis.join(" ") : "None embedded"}`].join("\n");
          } catch (error) {
            return commandUsageCard({ title: "Sticker Information Unavailable", command: `${session(ctx).prefix}sticker info`, commandSyntax: `${session(ctx).prefix}sticker info (reply to a sticker)`, note: error instanceof Error ? error.message : "The sticker metadata could not be read safely." });
          }
        }
        try {
          if (ctx.media && ["image", "video"].includes(ctx.media.kind)) {
            const packName = getStickerPackName(ctx.workspaceId, ctx.sessionId);
            const media = await convertMediaToSticker(ctx.media);
            validateWhatsAppSticker(media.bytes);
            return {
              media: { ...media, bytes: applyStickerPackMetadata(media.bytes, { packName }), stickerPackName: packName },
              caption: [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:sticker`, "STICKER CREATED"), "⎔ Source     · ⇆ Image, GIF, or video media", `⎔ Pack       · ⇆ ${getStickerPackName(ctx.workspaceId, ctx.sessionId)}`].join("\n"),
            };
          }
          const text = mediaCommandPayload(ctx) || ctx.quotedText?.trim() || "";
          if (!text) return commandUsageCard({ title: "Create Sticker", command: `${session(ctx).prefix}sticker`, commandSyntax: `${session(ctx).prefix}sticker <text or emoji>`, howToUse: ["Send or reply to an image, GIF, or video.", "Or send text/emoji, or reply to a text/emoji message."], note: "Text stickers use a clean chat-bubble canvas and the quoted sender’s profile picture when available." });
          const avatarJid = ctx.quotedSenderJid ?? ctx.senderJid;
          const profilePicture = avatarJid
            ? await getProfilePictureMediaForJid(ctx.workspaceId, ctx.sessionId, avatarJid).then((value) => value?.bytes).catch(() => undefined)
            : undefined;
          const packName = getStickerPackName(ctx.workspaceId, ctx.sessionId);
          const media = await renderTextSticker({ text, senderName: "You", ...(profilePicture ? { profilePicture } : {}) });
          validateWhatsAppSticker(media.bytes);
          return {
            media: { ...media, bytes: applyStickerPackMetadata(media.bytes, { packName, emojis: Array.from(text).filter((character) => /\p{Extended_Pictographic}/u.test(character)).slice(0, 8) }), stickerPackName: packName },
            caption: [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:text-sticker`, "TEXT STICKER CREATED"), `⎔ Pack       · ⇆ ${getStickerPackName(ctx.workspaceId, ctx.sessionId)}`, "⎔ Style      · ⇆ Premium chat-bubble canvas", `⎔ Avatar     · ⇆ ${profilePicture ? "Quoted sender profile picture" : "Fallback avatar"}`].join("\n"),
          };
        } catch (error) {
          return commandUsageCard({ title: "Sticker Creation Failed", command: `${session(ctx).prefix}sticker`, commandSyntax: `${session(ctx).prefix}sticker <text or emoji>`, note: error instanceof Error ? error.message : "The media could not be converted safely." });
        }
      },
    },
    {
      name: "stickerpname",
      aliases: ["spn"],
      description: "Set the pack name attached to generated and resent stickers.",
      ownerOnly: true,
      run: async (ctx) => {
        const value = (ctx.rawPayload ?? ctx.args.join(" ")).trim();
        if (!value) return commandUsageCard({ title: "Sticker Pack Name", command: `${session(ctx).prefix}stickerpname`, commandSyntax: `${session(ctx).prefix}stickerpname <name>`, examples: [`${session(ctx).prefix}spn PAPPY OMEGA`], note: "The name is scoped to this WhatsApp session and is applied to future sticker sends." });
        try {
          const name = setStickerPackName(ctx.workspaceId, ctx.sessionId, value);
          return [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:spn`, "STICKER PACK NAME"), `⎔ Name       · ⇆ ${name}`, "⎔ Scope      · ⇆ Current WhatsApp session", "⎔ Applies    · ⇆ New, converted, and resent stickers"].join("\n");
        } catch (error) {
          return commandUsageCard({ title: "Sticker Pack Name Rejected", command: `${session(ctx).prefix}stickerpname`, commandSyntax: `${session(ctx).prefix}stickerpname <name>`, note: error instanceof Error ? error.message : "The pack name was not accepted." });
        }
      },
    },
    {
      name: "take",
      aliases: ["takesticker"],
      description: "Resend a quoted sticker with this session’s pack name.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.media || ctx.media.kind !== "sticker") return commandUsageCard({ title: "Take Sticker", command: `${session(ctx).prefix}take`, commandSyntax: `${session(ctx).prefix}take (reply to a sticker)`, note: "Reply to a sticker to resend it with the current pack name." });
        const packName = getStickerPackName(ctx.workspaceId, ctx.sessionId);
        validateWhatsAppSticker(ctx.media.bytes);
        return {
          media: { ...ctx.media, bytes: applyStickerPackMetadata(ctx.media.bytes, { packName }), stickerPackName: packName },
          caption: [...pappyHeader(`${ctx.workspaceId}:${ctx.sessionId}:take`, "STICKER RESENT"), `⎔ Pack       · ⇆ ${packName}`, "⎔ Source     · ⇆ Quoted sticker"].join("\n"),
        };
      },
    },
    {
      name: "setgpp",
      aliases: ["gpp"],
      description:
        "Change a WhatsApp group profile picture from an HTTPS image URL.",
      run: async (ctx) => {
        const jid =
          ctx.args[0] ||
          (ctx.chatJid?.endsWith("@g.us") ? ctx.chatJid : undefined);
        const url = ctx.args[1];
        if (!jid || (!ctx.media && (!url || !/^https:\/\//i.test(url))))
          return "Reply to an image inside the target group, or use .setgpp <groupJid> <https image URL>.";
        try {
          await updateGroupProfilePicture(
            ctx.workspaceId,
            ctx.sessionId,
            jid,
            ctx.media?.kind === "image" ? ctx.media.bytes : (url as string),
          );
          return `Group profile picture updated in HD for ${jid}; no bot-side crop was applied.`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "setname",
      aliases: ["name"],
      description: "Read or update the WhatsApp display name.",
      run: async (ctx) => {
        if (!ctx.args.length) return commandUsageCard({ title: "Set Name", command: ".setname", commandSyntax: ".setname <new-display-name>", note: "Provide the new WhatsApp display name." });
        try {
          await updateProfileName(
            ctx.workspaceId,
            ctx.sessionId,
            ctx.args.join(" "),
          );
          return `Display name updated to: ${ctx.args.join(" ")}`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "setbio",
      aliases: ["bio"],
      description: "Read or update the WhatsApp bio.",
      run: async (ctx) => {
        if (!ctx.args.length) return commandUsageCard({ title: "Set Bio", command: ".setbio", commandSyntax: ".setbio <new-bio>", note: "Provide the new WhatsApp profile biography." });
        try {
          await updateProfileBio(
            ctx.workspaceId,
            ctx.sessionId,
            ctx.args.join(" "),
          );
          return "Bio updated successfully.";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "creategroup",
      aliases: ["newgroup", "groupcreate"],
      description: "Create a WhatsApp group with optional participant JIDs.",
      run: async (ctx) => {
        const raw = ctx.args.join(" ").trim();
        if (!raw)
          return commandUsageCard({ title: "Create Group", command: ".creategroup", commandSyntax: ".creategroup <name> [| description] [| participant numbers / mentions / reply]", acceptedTargets: ["Tag / Mention · Real WhatsApp mention", "Reply · Reply to a verified phone identity", "Phone · Explicit international number"], note: "Participant entries are normalized to verified phone JIDs; LID-only identities are rejected." });
        const parts = raw.split("|").map((part) => part.trim());
        const subject = parts[0] ?? "";
        const description = parts[1] ?? "";
        const participantTokens = (parts[2] ?? "")
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        const participants = verifiedTargetJids(participantTokens, ctx.mentionedJids, ctx.quotedSenderJid);
        if (!subject)
          return commandUsageCard({ title: "Create Group", command: ".creategroup", commandSyntax: ".creategroup <name> [| description] [| participant numbers / mentions / reply]", acceptedTargets: ["Tag / Mention · Real WhatsApp mention", "Reply · Reply to a verified phone identity", "Phone · Explicit international number"], note: "Participant entries are normalized to verified phone JIDs; LID-only identities are rejected." });
        try {
          const jid = await createWhatsAppGroup(
            ctx.workspaceId,
            ctx.sessionId,
            subject,
            participants,
          );
          if (description)
            await updateGroupDescription(
              ctx.workspaceId,
              ctx.sessionId,
              jid,
              description,
            );
          if (ctx.media?.kind === "image")
            await updateGroupProfilePicture(
              ctx.workspaceId,
              ctx.sessionId,
              jid,
              ctx.media.bytes,
            );
          const invite = await getGroupInviteCode(
            ctx.workspaceId,
            ctx.sessionId,
            jid,
          ).catch(() => undefined);
          return `Group created: ${subject}\nJID: ${jid}${description ? "\nDescription initialized." : ""}${invite ? `\nInvite: https://chat.whatsapp.com/${invite}` : ""}`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "groups",
      aliases: ["mygroups"],
      description: "Browse groups with pagination.",
      run: async (ctx) => {
        try {
          const groups = await listGroups(ctx.workspaceId, ctx.sessionId);
          if (!groups.length) return "No WhatsApp groups were returned.";
          return groups
            .slice(0, 40)
            .map(
              (group, index) =>
                `${index + 1}. ${group.subject} · ${group.participantCount} members\n${group.jid}`,
            )
            .join("\n");
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: "broadcastdelay",
      aliases: ["setbroadcastdelay", "postdelay"],
      description: "Set the allchat/allstatus delay in seconds.",
      ownerOnly: true,
      run: async (ctx) => {
        const raw = mediaCommandPayload(ctx);
        if (!/^\d+$/.test(raw))
          return commandUsageCard({ title: "Broadcast Delay", command: ".broadcastdelay", commandSyntax: ".broadcastdelay <1-60>", note: `Current delay is ${Math.round(getWorkspaceDefaults(ctx.workspaceId).defaultBroadcastDelayMs / 1000)}s.` });
        const seconds = Number(raw);
        if (seconds < 1 || seconds > 60)
          return "Broadcast delay must be between 1 and 60 seconds.";
        const next = updateWorkspaceDefaults(ctx.workspaceId, {
          defaultBroadcastDelayMs: seconds * 1000,
        });
        return `Broadcast delay set to ${Math.round(next.defaultBroadcastDelayMs / 1000)}s for allchat/allstatus jobs.`;
      },
    },
    {
      name: "allstatus",
      aliases: [],
      description: "Queue bounded delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "allstatusx",
        );
        if (!text && !ctx.media)
          return commandUsageCard({ title: "All Status", command: ".allstatus", commandSyntax: ".allstatus [repeat] <text or media>", note: "Broadcasts to resolved groups through one bounded durable job." });
        const queued = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allstatus", queued);
      },
    },
    {
      name: "dallstatus",
      aliases: ["allstatusd"],
      description: "Broadcast randomized per-group color status designs to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, false);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "Designed All Status", command: ".dallstatus", commandSyntax: ".dallstatus <text or media>", note: "Posts designed status content to resolved groups." });
        const queued = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat, styled: true },
        });
        return queuedJobAcknowledgement("allstatus", queued);
      },
    },
    {
      name: "allstatusx",
      aliases: [],
      description: "Queue repeated status delivery to all eligible groups.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "All Status X", command: ".allstatusx", commandSyntax: ".allstatusx [repeat] <text or media>", note: "Runs the configured repeated group-status broadcast." });
        const queued = await ctx.enqueueJob({
          kind: "allstatus",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allstatus", queued);
      },
    },
    {
      name: "pendingjoin",
      aliases: ["joinrequests", "pendingrequests"],
      description: "List pending WhatsApp group join requests.",
      ownerOnly: true,
      run: async (ctx) => {
        const { requests } = await pendingApprovalRequests(ctx);
        if (!requests.length) return "No pending WhatsApp join requests in this group.";
        const verified = requests.filter((request) => Boolean(firstVerifiedPhone(request.phoneNumber, request.jid))).length;
        const table: GroupControlTable = {
          title: "Pending WhatsApp Join Requests",
          headers: ["Metric", "Value"],
          rows: [
            ["Pending", String(requests.length)],
            ["Verified", String(verified)],
            ["Unresolved", String(Math.max(0, requests.length - verified))],
            ["Countries", approvalCountrySummary(requests) || "none available"],
          ],
          buttons: [],
          footer: `${requests.length} pending request(s). Verified identities are retained securely for batch processing and are not displayed.`,
        };
        return {
          text: formatModerationMessage("PENDING JOIN REQUESTS", [
            ["Pending", String(requests.length)],
            ["Verified", String(verified)],
            ["Unresolved", String(Math.max(0, requests.length - verified))],
            ["Countries", approvalCountrySummary(requests) || "none available"],
            ["Access", "Use Approve/Reject batch actions to review and confirm"],
          ]),
          nativeTable: table,
        };
      },
    },
    {
      name: "approve",
      aliases: [],
      description: "Show the safe bulk-approval command; never queues an operation.",
      ownerOnly: true,
      run: async () => commandUsageCard({ title: "Approval Commands", command: ".approveall", commandSyntax: ".approveall | .approveamt <amount> | .approvecountry <country> <amount|all>", note: "Every bulk approval requires a native Confirm step." }),
    },
    {
      name: "reject",
      aliases: [],
      description: "Show the safe bulk-rejection command; never queues an operation.",
      ownerOnly: true,
      run: async () => commandUsageCard({ title: "Rejection Commands", command: ".rejectall", commandSyntax: ".rejectall | .rejectamt <amount> | .rejectcountry <country> <amount|all>", note: "Every bulk rejection requires a native Confirm step." }),
    },
    {
      name: "approveall",
      aliases: [],
      description: "Approve all pending WhatsApp group join requests.",
      ownerOnly: true,
      run: async (ctx) => {
        const { requests } = await pendingApprovalRequests(ctx);
        if (!requests.length) return "There are no pending WhatsApp join requests to approve.";
        return approvalConfirmationReply(ctx, "approve", requests, "all pending requests");
      },
    },
    {
      name: "rejectall",
      aliases: [],
      description: "Reject all pending WhatsApp group join requests.",
      ownerOnly: true,
      run: async (ctx) => {
        const { requests } = await pendingApprovalRequests(ctx);
        if (!requests.length) return "There are no pending WhatsApp join requests to reject.";
        return approvalConfirmationReply(ctx, "reject", requests, "all pending requests");
      },
    },
    {
      name: "approveamt",
      aliases: ["approveamount"],
      description: "Approve the first N pending join requests.",
      ownerOnly: true,
      run: async (ctx) => {
        const amount = Number(ctx.args[0]);
        if (!Number.isInteger(amount) || amount < 1) return commandUsageCard({ title: "Approve Amount", command: ".approveamt", commandSyntax: ".approveamt <positive-amount>", note: "A native Confirm step is required before approval." });
        const { requests } = await pendingApprovalRequests(ctx);
        const selected = requests.slice(0, Math.min(amount, MAX_GROUP_CONTROL_PARTICIPANTS));
        if (!selected.length) return "There are no pending WhatsApp join requests to approve.";
        return approvalConfirmationReply(ctx, "approve", selected, `first ${selected.length} pending requests`);
      },
    },
    {
      name: "rejectamt",
      aliases: ["rejectamount"],
      description: "Reject the first N pending join requests.",
      ownerOnly: true,
      run: async (ctx) => {
        const amount = Number(ctx.args[0]);
        if (!Number.isInteger(amount) || amount < 1) return commandUsageCard({ title: "Reject Amount", command: ".rejectamt", commandSyntax: ".rejectamt <positive-amount>", note: "A native Confirm step is required before rejection." });
        const { requests } = await pendingApprovalRequests(ctx);
        const selected = requests.slice(0, Math.min(amount, MAX_GROUP_CONTROL_PARTICIPANTS));
        if (!selected.length) return "There are no pending WhatsApp join requests to reject.";
        return approvalConfirmationReply(ctx, "reject", selected, `first ${selected.length} pending requests`);
      },
    },
    {
      name: "approvecountry",
      aliases: ["approvebycountry"],
      description: "Approve pending requests by phone country code.",
      ownerOnly: true,
      run: async (ctx) => {
        const country = (ctx.args[0] ?? "").replace(/\D/g, "");
        if (!country) return commandUsageCard({ title: "Approve Country", command: ".approvecountry", commandSyntax: ".approvecountry <country-code> <amount|all>", note: "A native Confirm step is required before approval." });
        const amountToken = (ctx.args[1] ?? "").toLowerCase();
        const amount = amountToken === "all" ? MAX_GROUP_CONTROL_PARTICIPANTS : Number(amountToken);
        if (!Number.isInteger(amount) || amount < 1) return commandUsageCard({ title: "Approve Country", command: ".approvecountry", commandSyntax: ".approvecountry <country-code> <amount|all>", note: "Use a positive amount or all. A native Confirm step is required." });
        const { requests } = await pendingApprovalRequests(ctx);
        const selected = requests.filter((request) => approvalCountry(request).startsWith(country)).slice(0, amount);
        if (!selected.length) return "No pending requests with that country code were found; unresolved LID-only requests are not guessed.";
        return approvalConfirmationReply(ctx, "approve", selected, `country +${country} · up to ${amountToken}`);
      },
    },
    {
      name: "rejectcountry",
      aliases: ["rejectbycountry"],
      description: "Reject pending requests by phone country code.",
      ownerOnly: true,
      run: async (ctx) => {
        const country = (ctx.args[0] ?? "").replace(/\D/g, "");
        if (!country) return commandUsageCard({ title: "Reject Country", command: ".rejectcountry", commandSyntax: ".rejectcountry <country-code> [amount|all]", note: "A native Confirm step is required before rejection." });
        const amountToken = (ctx.args[1] ?? "all").toLowerCase();
        const amount = amountToken === "all" ? MAX_GROUP_CONTROL_PARTICIPANTS : Number(amountToken);
        if (!Number.isInteger(amount) || amount < 1) return commandUsageCard({ title: "Reject Country", command: ".rejectcountry", commandSyntax: ".rejectcountry <country-code> [amount|all]", note: "Use a positive amount or all. A native Confirm step is required." });
        const { requests } = await pendingApprovalRequests(ctx);
        const selected = requests.filter((request) => approvalCountry(request).startsWith(country)).slice(0, amount);
        if (!selected.length) return "No pending requests with that country code were found; unresolved LID-only requests are not guessed.";
        return approvalConfirmationReply(ctx, "reject", selected, `country +${country} · up to ${amountToken}`);
      },
    },
    {
      name: "reqamt",
      aliases: ["joincount"],
      description: "Count pending join requests by phone country code.",
      ownerOnly: true,
      run: async (ctx) => {
        const country = (ctx.args[0] ?? "").replace(/\D/g, "");
        const { requests } = await pendingApprovalRequests(ctx);
        const verified = requests
          .map((request) => firstVerifiedPhone(request.phoneNumber, request.jid))
          .filter((phone): phone is string => Boolean(phone));
        const available = new Map<string, number>();
        for (const phone of verified) {
          const code = countryPrefixFromPhone(phone);
          if (code) available.set(code, (available.get(code) ?? 0) + 1);
        }
        const availableText = [...available.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => `+${code} (${count})`)
          .join(" · ");
        if (!country)
          return commandUsageCard({
            title: "Request Count",
            command: ".reqamt",
            commandSyntax: ".reqamt <country-code>",
            examples: [".reqamt 234"],
            howToUse: ["Provide a numeric country code to count matching pending requests.", "Only verified phone identities are counted; unresolved LIDs are excluded."],
            note: `Available countries: ${availableText || "none currently available"}.`,
          });
        const matched = verified.filter((phone) => phone.startsWith(country)).length;
        const total = verified.length;
        const otherCountryExcluded = Math.max(0, total - matched);
        return formatModerationMessage("REQUEST COUNT", [
          ["Country", `+${country}`],
          ["Matched total", String(matched)],
          ["Total verified", String(total)],
          ["Other excluded", String(otherCountryExcluded)],
        ]);
      },
    },
    {
      name: "kickall",
      aliases: ["kickbatch", "removeall"],
      description: "Queue one protected batch to remove all eligible non-admin members.",
      ownerOnly: true,
      run: async (ctx) => {
        const { groupJid, targets } = await eligibleMemberTargets(ctx);
        if (!targets.length) return "No eligible non-admin members matched this action.";
        return memberConfirmationReply(ctx, groupJid, "remove", targets, "all eligible non-admin members");
      },
    },
    {
      name: "kickamt",
      aliases: ["removeamt"],
      description: "Queue one protected batch to remove the first N eligible members.",
      ownerOnly: true,
      run: async (ctx) => {
        const amount = Number(ctx.args[0]);
        if (!Number.isInteger(amount) || amount < 1) return commandUsageCard({ title: "Kick Amount", command: ".kickamt", commandSyntax: ".kickamt <positive-amount> confirm", note: "This bulk removal requires native Confirm and a fresh admin check." });
        const { groupJid, targets } = await eligibleMemberTargets(ctx);
        const selected = targets.slice(0, Math.min(amount, MAX_GROUP_CONTROL_PARTICIPANTS));
        if (!selected.length) return "No eligible non-admin members matched this action.";
        return memberConfirmationReply(ctx, groupJid, "remove", selected, `first ${selected.length} eligible non-admin members`);
      },
    },
    {
      name: "kickcountry",
      aliases: ["removecountry"],
      description: "Queue one protected batch to remove eligible members by phone country code.",
      ownerOnly: true,
      run: async (ctx) => {
        const country = (ctx.args[0] ?? "").replace(/\D/g, "");
        const amountToken = (ctx.args[1] ?? "").toLowerCase();
        const amount = amountToken === "all" ? MAX_GROUP_CONTROL_PARTICIPANTS : Number(amountToken);
        if (!country || !Number.isInteger(amount) || amount < 1)
          return commandUsageCard({ title: "Kick Country", command: ".kickcountry", commandSyntax: ".kickcountry <country-code> <amount|all> confirm", note: "This bounded bulk removal excludes protected administrators and requires native Confirm." });
        const { groupJid, targets } = await eligibleMemberTargets(ctx);
        const selected = targets
          .filter((participant) => (participant.phoneNumber ?? "").replace(/\D/g, "").startsWith(country))
          .slice(0, Math.min(amount, MAX_GROUP_CONTROL_PARTICIPANTS));
        if (!selected.length) return "No eligible phone-number members matched that country code.";
        return memberConfirmationReply(ctx, groupJid, "remove", selected, `country +${country} · up to ${amountToken}`);
      },
    },
    {
      name: "pstatus",
      aliases: [],
      description: "Post one personal WhatsApp Status update.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.sendCurrentPersonalStatus)
          return "WhatsApp transport is unavailable.";
        const text = mediaCommandPayload(ctx);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "Personal Status", command: ".pstatus", commandSyntax: ".pstatus <text or media>", howToUse: ["Send text or attach media.", "You may reply to a message to use its payload."], note: "Personal status is separate from group status." });
        await ctx.sendCurrentPersonalStatus({ text });
        return "Personal status posted successfully.";
      },
    },
    {
      name: "dgstatus",
      aliases: ["gstatusd", "dgstatsus"],
      description: "Send a styled group status with a randomized color and group design.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentColorGroupStatus)
          return "WhatsApp transport is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, false);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "Designed Group Status", command: ".dgstatus", commandSyntax: ".dgstatus <text or media>", howToUse: ["Send text or attach media.", "You may reply to a message to use its payload."], note: "Designed group status applies a per-group visual treatment." });
        await ctx.sendCurrentColorGroupStatus({ text, repeat });
        return "";
      },
    },
    {
      name: "gstatus",
      aliases: [],
      description:
        "Send one status payload directly to the current WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupStatus)
          return "WhatsApp transport is unavailable.";
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "gstatusx",
        );
        if (!text && !ctx.media)
          return repeat > 1
            ? commandUsageCard({ title: "Group Status X", command: ".gstatusx", commandSyntax: ".gstatusx <count> <text or media>", note: "Send text/media or reply to a message." })
            : commandUsageCard({ title: "Group Status", command: ".gstatus", commandSyntax: ".gstatus <text or media>", note: "Send text/media or reply to a message." });
        await ctx.sendCurrentGroupStatus({ text, repeat });
        return "";
      },
    },
    {
      name: "gstatusx",
      aliases: [],
      description: "Repeat status payload in the current WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupStatus)
          return "WhatsApp transport is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "Group Status X", command: ".gstatusx", commandSyntax: ".gstatusx <count> <text or media>", note: "Send text/media or reply to a message." });
        await ctx.sendCurrentGroupStatus({ text, repeat });
        return "";
      },
    },
    {
      name: "stopstatus",
      aliases: [],
      description: "Cancel active all-status work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("allstatus")} all-status job(s).`
          : "Queue runtime is unavailable.",
    },
    {
      name: "allchat",
      aliases: [],
      description: "Queue bounded delivery to all eligible group chats.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(
          ctx,
          ctx.invokedName === "allchatx",
        );
        if (!text && !ctx.media)
          return commandUsageCard({ title: "All Chat", command: ".allchat", commandSyntax: ".allchat [repeat] <text or media>", note: "Broadcasts the payload through one bounded durable job." });
        const queued = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allchat", queued);
      },
    },
    {
      name: "allchatx",
      aliases: [],
      description: "Queue repeated delivery to all eligible group chats.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.enqueueJob) return "Queue runtime is unavailable.";
        const { repeat, text } = repeatAndPayload(ctx, true);
        if (!text && !ctx.media)
          return commandUsageCard({ title: "All Chat X", command: ".allchatx", commandSyntax: ".allchatx [repeat] <text or media>", note: "Runs the configured repeated group-chat broadcast." });
        const queued = await ctx.enqueueJob({
          kind: "allchat",
          payload: { text, count: repeat },
        });
        return queuedJobAcknowledgement("allchat", queued);
      },
    },
    {
      name: "stopchat",
      aliases: [],
      description: "Cancel active all-chat work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("allchat")} all-chat job(s).`
          : "Queue runtime is unavailable.",
    },
    {
      name: "tag",
      aliases: [],
      description: "Fast hidetag of every member in this WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupHidetag)
          return "WhatsApp transport is unavailable.";
        const numericCount =
          ctx.args.length === 1 && /^\d+$/.test(ctx.args[0] ?? "")
            ? Math.max(1, Math.min(1000, Number(ctx.args[0])))
            : undefined;
        const text = numericCount
          ? mediaCommandPayload({ ...ctx, args: [], rawPayload: "" })
          : mediaCommandPayload(ctx);
        if (!text && !ctx.media && numericCount === undefined)
          return commandUsageCard({ title: "Tag Command", command: ".tag", commandSyntax: ".tag <payload or media> | .tag <member-count>", note: "Use a payload/media or a bounded member count." });
        await ctx.sendCurrentGroupHidetag({
          text,
          ...(numericCount !== undefined
            ? { participantCount: numericCount }
            : {}),
        });
        return "";
      },
    },
    {
      name: "stag",
      aliases: [],
      description: "Immediate hidetag of every member in this WhatsApp group.",
      ownerOnly: true,
      run: async (ctx) => {
        if (!ctx.chatJid || !ctx.chatJid.endsWith("@g.us"))
          return "This command must be used inside a WhatsApp group.";
        if (!ctx.sendCurrentGroupHidetag)
          return "WhatsApp transport is unavailable.";
        const text = mediaCommandPayload(ctx);
        if (!text && !ctx.media) return commandUsageCard({ title: "Staged Tag", command: ".stag", commandSyntax: ".stag <payload or media>", note: "Provide text/media or reply to a payload." });
        await ctx.sendCurrentGroupHidetag({ text });
        return "";
      },
    },
    {
      name: "stopstag",
      aliases: ["stoptag"],
      description: "Cancel active STag work.",
      ownerOnly: true,
      run: async (ctx) =>
        ctx.cancelJobs
          ? `Cancelled ${await ctx.cancelJobs("tag")} STag job(s).`
          : "Queue runtime is unavailable.",
    },
    {
      name: "health",
      aliases: ["status"],
      description: "Show session health and runtime state.",
      run: async (ctx) => {
        const current = session(ctx);
        const inbound = current.lastMessageReceivedAt;
        const outbound = current.lastOutboundMessageAt;
        return `Health: ${effectiveSessionStatus(current)}\nAuth: ${current.authHealth ?? "UNKNOWN"}\nLast inbound: ${inbound ? new Date(inbound).toISOString() : "none"}\nLast outbound: ${outbound ? new Date(outbound).toISOString() : "none"}\nQueue policy: bounded\nReconnect policy: non-destructive`;
      },
    },
    {
      name: "setsudo",
      aliases: ["sudo"],
      description: "Add a verified session or global sudo phone identity.",
      ownerOnly: true,
      run: runSudoCommand,
    },
    {
      name: "rmsudo",
      aliases: ["removesudo"],
      description: "Remove a verified session or global sudo phone identity.",
      ownerOnly: true,
      run: runSudoCommand,
    },
  ];
}

export async function handleGroupControlInteraction(
  interactionId: string,
  ctx: CommandContext,
): Promise<string | WhatsAppCommandReply | undefined> {
  const match = /^group-control:(confirm|cancel):([a-z0-9]+)$/iu.exec(interactionId.trim());
  if (!match || !ctx.chatJid?.endsWith("@g.us")) return undefined;
  const action = match[1]?.toLowerCase();
  const token = match[2] ?? "";
  const senderJid = ctx.senderJid ?? "";
  if (!senderJid) return "This confirmation could not verify the requesting identity.";
  const pending = consumeGroupControlConfirmation(ctx.workspaceId, ctx.sessionId, ctx.chatJid, senderJid, token);
  if (!pending) return "This confirmation expired, was cancelled, or belongs to another WhatsApp identity.";
  if (action === "cancel") return "✅ Group operation cancelled. No batch job was queued.";
  if (pending.operation === "moderation") {
    return applyModerationConfirmation(ctx, pending.moderationAction ?? "unmute", pending.participants[0], pending.quotedMessageKey);
  }
  if (pending.operation === "participant") {
    const freshGroup = await getGroupModerationSnapshot(ctx.workspaceId, ctx.sessionId, pending.groupJid, { fresh: true });
    if (!freshGroup.isAdmin) return "This WhatsApp identity is no longer an administrator in this group; the action was not queued.";
    const currentPhones = new Set(freshGroup.participants.map((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id)).filter((phone): phone is string => Boolean(phone)));
    const stillMembers = pending.participants.filter((participant) => {
      const phone = firstVerifiedPhone(participant);
      return Boolean(phone && currentPhones.has(phone));
    });
    if (!stillMembers.length) return "No confirmed verified-phone target remains in this group; the action was not queued.";
    if (pending.quotedMessageKey && ["remove", "block", "demote-remove"].includes(pending.participantAction ?? ""))
      await Promise.resolve(deleteWhatsAppMessage(ctx.workspaceId, ctx.sessionId, pending.groupJid, { ...pending.quotedMessageKey, remoteJid: pending.groupJid })).catch(() => undefined);
    return queueMemberOperation(ctx, pending.groupJid, pending.participantAction ?? "remove", stillMembers);
  }
  const fresh = await pendingApprovalRequests(ctx);
  const current = new Set(
    fresh.requests
      .map((request) => firstVerifiedPhone(request.phoneNumber, request.jid))
      .filter((phone): phone is string => Boolean(phone)),
  );
  const participants = pending.participants
    .filter((participant) => {
      const phone = firstVerifiedPhone(participant);
      return Boolean(phone && current.has(phone));
    })
    .map((participant) => phoneJidFromIdentity(firstVerifiedPhone(participant)))
    .filter((jid): jid is string => Boolean(jid));
  if (!participants.length) return `No selected pending requests remain; the ${pending.operation} action was not queued.`;
  return queueApprovalOperation(ctx, pending.operation, participants);
}

export async function executeCommand(
  registry: RegisteredCommand[],
  raw: string,
  ctx: CommandContext,
): Promise<string | WhatsAppCommandReply> {
  const normalizedRaw = raw.trim();
  if (/^group-control:(?:confirm|cancel):[a-z0-9]+$/iu.test(normalizedRaw)) {
    try {
      return (await handleGroupControlInteraction(normalizedRaw, ctx)) ?? "This interaction is no longer available.";
    } catch (error) {
      return protectedCommandFailure(error);
    }
  }
  const commandMatch = /^(\S+)(?:\s+|$)/.exec(normalizedRaw);
  const name = commandMatch?.[1] ?? "";
  const payloadStart = commandMatch?.[0]?.length ?? normalizedRaw.length;
  const args = normalizedRaw
    .slice(payloadStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const rawPayload = normalizedRaw.slice(payloadStart);
  const invokedName = name.toLowerCase();
  const command = registry.find(
    (item) => item.name === invokedName || item.aliases.includes(invokedName),
  ) ?? (invokedName === "rmsudo" ? registry.find((item) => item.name === "setsudo") : undefined);
  if (!command) return `Unknown command. Use ${session(ctx).prefix}menu.`;
  if (command.ownerOnly && !ctx.isOwner)
    return "This command is restricted to the session owner.";
  const normalizedArgs =
    command.name === "pfp" && invokedName === "setpfp"
      ? ["set", ...args]
      : command.name === "pfp" && invokedName === "getpfp"
        ? ["get", ...args]
        : command.name === "pfp" && invokedName === "removepfp"
          ? ["remove", ...args]
          : args;
  try {
    return await command.run({
      ...ctx,
      invokedName,
      args: normalizedArgs,
      rawPayload,
    });
  } catch (error) {
    if (isProtectedGroupCommand(command.name)) return protectedCommandFailure(error);
    throw error;
  }
}
