import type { CommandContext, WhatsAppCommandReply } from "./command-registry.js";
import { getSession } from "../core/session-registry.js";
import { firstVerifiedPhone, maskedPhoneLabel, phoneJidFromIdentity, verifiedTargetPhone } from "./identity-normalization.js";
import { getGroupModerationSnapshot, setGroupChatMode, updateParticipantBlockStatus, updateGroupParticipantRole } from "./transport-adapter.js";
import { registerGroupControlConfirmation } from "./group-control-confirmation.js";
import { isPhoneBanned, listBannedPhones, setPhoneBanned, getManualWarning, incrementManualWarning, resetManualWarning } from "./group-moderation-state.js";
import { buildModerationActionResponse, buildModerationWarningResponse, formatModerationMessage, realMention, withMentions } from "./moderation-response.js";
import { banUsageCard, commandUsageCard } from "./response-cards.js";
import { listTrackedMessages, forgetTrackedMessage } from "./moderation-message-tracker.js";
import { deleteWhatsAppMessage } from "./transport-adapter.js";

interface Target {
  phone: string;
  jid: string;
  isAdmin: boolean;
  subject: string;
}

function groupOf(ctx: CommandContext): string | undefined {
  return ctx.chatJid && ctx.chatJid.endsWith("@g.us") ? ctx.chatJid : undefined;
}

async function freshGroup(ctx: CommandContext, label: string) {
  const groupJid = groupOf(ctx);
  if (!groupJid) throw new Error(`${label} can only be used inside a WhatsApp group.`);
  const snapshot = await getGroupModerationSnapshot(ctx.workspaceId, ctx.sessionId, groupJid, { fresh: true });
  if (!snapshot.isAdmin) throw new Error("The WhatsApp session is not an administrator in this group.");
  const requester = firstVerifiedPhone(ctx.senderJid);
  const requesterIsAdmin = ctx.isOwner || Boolean(requester && snapshot.participants.some((p) => firstVerifiedPhone(p.phoneNumber, p.jid, p.id) === requester && Boolean(p.admin)));
  if (!requesterIsAdmin) throw new Error("Only the group owner, session owner, or a verified group administrator may use this command.");
  return { groupJid, snapshot };
}

async function targetOf(ctx: CommandContext, label: string): Promise<{ groupJid: string; target: Target } | { error: string }> {
  try {
    const { groupJid, snapshot } = await freshGroup(ctx, label);
    const phone = verifiedTargetPhone(ctx.args, ctx.mentionedJids, ctx.quotedSenderJid);
    if (!phone) return { error: label.toLowerCase() === "ban" ? banUsageCard() : commandUsageCard({ title: `${label} Command`, command: `.${ctx.invokedName ?? label.toLowerCase()}`, commandSyntax: `.${ctx.invokedName ?? label.toLowerCase()} <target>`, acceptedTargets: ["Phone Number  · +2348012345678", "Tag / Mention · Real WhatsApp mention", "Reply         · Reply to user's message with the command"], note: "LID-only targets are rejected. Target must have a valid verified phone identity." }) };
    const participant = snapshot.participants.find((p) => firstVerifiedPhone(p.phoneNumber, p.jid, p.id) === phone);
    if (!participant) return { error: "That verified phone identity is not a current member of this group." };
    return { groupJid, target: { phone, jid: phoneJidFromIdentity(phone)!, isAdmin: Boolean(participant.admin), subject: snapshot.subject } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function moderationReply(ctx: CommandContext, action: "ban" | "unban" | "mute" | "unmute" | "deleteall" | "warn-kick", groupJid: string, target?: Target): WhatsAppCommandReply {
  const pending = registerGroupControlConfirmation({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    groupJid,
    senderJid: ctx.senderJid ?? "",
    operation: "moderation",
    moderationAction: action,
    participants: target ? [target.jid] : [],
    table: {
      title: `Moderation · ${action.toUpperCase()} Confirmation`,
      headers: ["Action", "Scope"],
      rows: [[action.toUpperCase(), target?.phone ? realMention(target.phone) : "Current group"]],
      buttons: [],
      footer: "No action is queued until Confirm is tapped. This preview expires in 90 seconds.",
    },
  });
  pending.table.buttons = [
    { text: `✅ Confirm ${action.toUpperCase()}`, id: `group-control:confirm:${pending.token}` },
    { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
  ];
  const preview = buildModerationActionResponse({ title: "MODERATION REVIEW", action: `${action.toUpperCase()} · No action queued`, groupName: target?.subject ?? "This group only", ...(target?.phone ? { targetPhone: target.phone } : {}), note: "No action is queued until Confirm is tapped. This preview expires in 90 seconds." });
  return { ...preview, nativeTable: pending.table, nativeFlow: pending.table.buttons };
}

function targetReply(ctx: CommandContext, action: "remove" | "promote" | "demote" | "block" | "demote-remove", target: Target, groupJid: string): WhatsAppCommandReply {
  const pending = registerGroupControlConfirmation({
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    groupJid,
    senderJid: ctx.senderJid ?? "",
    operation: "participant",
    participantAction: action,
    participants: [target.jid],
    table: {
      title: `Member Control · ${action.toUpperCase()} Confirmation`,
      headers: ["Member", "Action"],
      rows: [[realMention(target.phone), `${action.toUpperCase()} in ${target.subject}`]],
      buttons: [
        { text: `✅ Confirm ${action.toUpperCase()}`, id: "pending" },
        { text: "❌ Cancel", id: "pending" },
      ],
      footer: "No action is queued until Confirm is tapped. This preview expires in 90 seconds.",
    },
  });
  pending.table.buttons = [
    { text: `✅ Confirm ${action.toUpperCase()}`, id: `group-control:confirm:${pending.token}` },
    { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
  ];
  const preview = buildModerationActionResponse({ title: "MEMBER CONTROL REVIEW", action: `${action.toUpperCase()} · No action queued`, groupName: target.subject, targetPhone: target.phone, note: "No action is queued until Confirm is tapped. This preview expires in 90 seconds." });
  return {
    ...preview,
    nativeTable: pending.table,
    nativeFlow: pending.table.buttons,
  };
}

export async function moderateParticipant(ctx: CommandContext, action: "remove" | "promote" | "demote" | "block" | "demote-remove"): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, action);
  if ("error" in resolved) return resolved.error;
  const { groupJid, target } = resolved;
  if (["remove", "block"].includes(action) && target.isAdmin) return "That verified member is an administrator and is protected. Use .dnkick only after a deliberate admin-removal review.";
  if (action === "demote-remove" && !target.isAdmin) return "That verified member is not an administrator, so dnkick was not offered.";
  if (["promote", "demote"].includes(action) && action === "demote" && !target.isAdmin) return "That verified member is not an administrator, so demote was not offered.";
  if (["promote"].includes(action) && target.isAdmin) return "That verified member is already an administrator.";
  return targetReply(ctx, action, target, groupJid);
}

export async function banMember(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "Ban");
  if ("error" in resolved) return resolved.error;
  if (resolved.target.isAdmin) return "That verified member is an administrator and cannot be locally banned.";
  return moderationReply(ctx, "ban", resolved.groupJid, resolved.target);
}

export async function unblockMember(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  try {
    await freshGroup(ctx, "Unblock");
    const phone = verifiedTargetPhone(ctx.args, ctx.mentionedJids, ctx.quotedSenderJid);
    if (!phone) return commandUsageCard({ title: "Unblock Command", command: ".unblock", commandSyntax: ".unblock <target>", acceptedTargets: ["Phone Number  · +2348012345678", "Tag / Mention · Real WhatsApp mention", "Reply         · Reply to user's message with .unblock"], note: "LID-only targets are rejected. Target must have a valid verified phone identity." });
    await updateParticipantBlockStatus(ctx.workspaceId, ctx.sessionId, phoneJidFromIdentity(phone)!, false);
    return buildModerationActionResponse({ title: "MEMBER UNBLOCKED", action: "WhatsApp block removed", groupName: "This group only", targetPhone: phone, note: "Normal messaging access is restored." });
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function unbanMember(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "Unban");
  if ("error" in resolved) return resolved.error;
  return moderationReply(ctx, "unban", resolved.groupJid, resolved.target);
}

export async function banList(ctx: CommandContext): Promise<string> {
  try {
    const { groupJid } = await freshGroup(ctx, "Ban List");
    const phones = listBannedPhones(ctx.workspaceId, ctx.sessionId, groupJid);
    return buildModerationActionResponse({ title: "BAN LIST", action: phones.length ? `${phones.length} local restriction(s)` : "No local restrictions", groupName: "This group only", note: phones.length ? phones.map((phone, index) => `${index + 1}. ${maskedPhoneLabel(phone)}`).join(" · ") : "No locally banned members." }).text;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function warnMember(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "Warn");
  if ("error" in resolved) return resolved.error;
  if (resolved.target.isAdmin) return "That verified member is an administrator and cannot be warned by ordinary moderation.";
  const count = incrementManualWarning(ctx.workspaceId, ctx.sessionId, resolved.groupJid, resolved.target.phone);
  const threshold = 3;
  if (count >= threshold) return moderationReply(ctx, "warn-kick", resolved.groupJid, resolved.target);
  if (ctx.quotedMessageKey) await deleteWhatsAppMessage(ctx.workspaceId, ctx.sessionId, resolved.groupJid, ctx.quotedMessageKey).catch(() => undefined);
  return buildModerationWarningResponse({ targetPhone: resolved.target.phone, groupName: resolved.target.subject, warningCount: count, warningThreshold: threshold, action: "Violation Logged", note: `Reaching ${threshold} warnings will trigger an automatic kick.` });
}

export async function clearWarning(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "Unwarn");
  if ("error" in resolved) return resolved.error;
  resetManualWarning(ctx.workspaceId, ctx.sessionId, resolved.groupJid, resolved.target.phone);
  return buildModerationActionResponse({ title: "WARNING RESET", action: "Warnings cleared", groupName: resolved.target.subject, targetPhone: resolved.target.phone, note: "The manual warning count is now zero." });
}

export async function showWarnings(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "Warns");
  if ("error" in resolved) return resolved.error;
  const warningCount = getManualWarning(ctx.workspaceId, ctx.sessionId, resolved.groupJid, resolved.target.phone);
  return buildModerationWarningResponse({ title: "WARNING STATUS", targetPhone: resolved.target.phone, groupName: resolved.target.subject, warningCount, warningThreshold: 3, action: "Status Check", note: "Manual warning state is scoped to this group." });
}

export async function muteGroup(ctx: CommandContext, muted: boolean): Promise<string | WhatsAppCommandReply> {
  try {
    const { groupJid } = await freshGroup(ctx, muted ? "Mute" : "Unmute");
    return moderationReply(ctx, muted ? "mute" : "unmute", groupJid);
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function deleteAllMember(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  const resolved = await targetOf(ctx, "DeleteAll");
  if ("error" in resolved) return resolved.error;
  return moderationReply(ctx, "deleteall", resolved.groupJid, resolved.target);
}

export async function applyModerationConfirmation(ctx: CommandContext, action: "ban" | "unban" | "mute" | "unmute" | "deleteall" | "warn-kick", participant?: string): Promise<string | WhatsAppCommandReply> {
  const { groupJid, snapshot } = await freshGroup(ctx, action);
  if (action === "mute" || action === "unmute") {
    await setGroupChatMode(ctx.workspaceId, ctx.sessionId, groupJid, action === "mute");
    return buildModerationActionResponse({ title: action === "mute" ? "GROUP MUTED" : "GROUP UNMUTED", action: action === "mute" ? "Administrators only" : "All members may send", groupName: "This group only", note: "This is a group-wide WhatsApp announcement mode change." });
  }
  const phone = firstVerifiedPhone(participant);
  if (!phone) return "The confirmation did not retain a verified phone identity; no action was applied.";
  const current = snapshot.participants.find((item) => firstVerifiedPhone(item.phoneNumber, item.jid, item.id) === phone);
  if (action === "ban" && (!current || current.admin)) return "The confirmed target is no longer an eligible regular member; no local ban was applied.";
  if (action === "warn-kick") {
    if (!current || current.admin) return "The confirmed warning target is no longer an eligible regular member; no removal was applied.";
    if (ctx.quotedMessageKey) await deleteWhatsAppMessage(ctx.workspaceId, ctx.sessionId, groupJid, ctx.quotedMessageKey).catch(() => undefined);
    try {
      await updateGroupParticipantRole(ctx.workspaceId, ctx.sessionId, groupJid, phoneJidFromIdentity(phone)!, "remove");
    } catch {
      return "The warning threshold was reached, but WhatsApp rejected the removal. No further action was attempted.";
    }
    resetManualWarning(ctx.workspaceId, ctx.sessionId, groupJid, phone);
    return buildModerationWarningResponse({ title: "WARNING THRESHOLD ENFORCED", targetPhone: phone, groupName: snapshot.subject, warningCount: 3, warningThreshold: 3, action: "Member Removed", note: "The quoted message was deleted, the member was removed, and the warning count was reset." });
  }
  if (action === "deleteall") {
    if (!current || current.admin) return "The confirmed target is no longer an eligible regular member; no messages were deleted.";
    const messages = listTrackedMessages(ctx.workspaceId, ctx.sessionId, groupJid, phone).slice(0, 200);
    let deleted = 0;
    for (const key of messages) {
      try {
        await deleteWhatsAppMessage(ctx.workspaceId, ctx.sessionId, groupJid, key);
        forgetTrackedMessage(ctx.workspaceId, ctx.sessionId, groupJid, key);
        deleted += 1;
      } catch {
        // Continue through the bounded set; the response reports the confirmed count.
      }
    }
    return buildModerationActionResponse({ title: "DELETEALL COMPLETE", action: `${deleted} recent message(s) deleted`, groupName: snapshot.subject, targetPhone: phone, note: "Only recent tracked messages were eligible; maximum 200." });
  }
  setPhoneBanned(ctx.workspaceId, ctx.sessionId, groupJid, phone, action === "ban");
  return buildModerationActionResponse({ title: action === "ban" ? "BAN ENABLED" : "BAN REMOVED", action: action === "ban" ? "Incoming group messages deleted" : "Normal messaging restored", groupName: snapshot.subject, targetPhone: phone, note: action === "ban" ? "This local restriction affects only this group." : "The local restriction is removed for this group." });
}

export async function createPoll(ctx: CommandContext): Promise<string> {
  if (!ctx.chatJid?.endsWith("@g.us")) return commandUsageCard({ title: "Poll Command", command: ".poll", commandSyntax: ".poll Question | Option 1 | Option 2", note: "This command can only be used inside a WhatsApp group." });
  if (!ctx.sendCurrentGroupPoll) return "WhatsApp poll transport is unavailable.";
  const fullText = [ctx.rawPayload ?? ctx.args.join(" "), ctx.quotedText ?? ""].join(" ").trim();
  const parts = fullText.split("|").map((value) => value.trim()).filter(Boolean);
  if (parts.length < 3) return commandUsageCard({ title: "Poll Command", command: ".poll", commandSyntax: ".poll Question | Option 1 | Option 2", howToUse: ["Separate the question and options with |.", "Provide at least two options."], note: "Example: .poll Choose a day | Monday | Friday" });
  const question = parts[0]!.slice(0, 300);
  const options = parts.slice(1, 13).map((value) => value.slice(0, 100));
  await ctx.sendCurrentGroupPoll({ question, options });
  return formatModerationMessage("POLL CREATED", [["Question", question], ["Options", String(options.length)]]);
}

export async function filterCountry(ctx: CommandContext): Promise<string> {
  try {
    const { snapshot } = await freshGroup(ctx, "Filter");
    const country = (ctx.args[0] ?? "").replace(/\D/gu, "");
    if (!/^\d{1,3}$/u.test(country)) return commandUsageCard({ title: "Filter Command", command: ".filter", commandSyntax: ".filter <country-code>", examples: [".filter 234"], note: "This view is read-only and never changes members." });
    const matching = snapshot.participants.filter((p) => firstVerifiedPhone(p.phoneNumber, p.jid, p.id)?.startsWith(country));
    const protectedCount = matching.filter((p) => Boolean(p.admin)).length;
    return formatModerationMessage(`FILTER +${country}`, [["Matching", String(matching.length)], ["Protected admins", String(protectedCount)], ["Eligible regular members", String(Math.max(0, matching.length - protectedCount))], ["Action", "Read-only"]]);
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function filterOut(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  try {
    const { groupJid, snapshot } = await freshGroup(ctx, "Filter Out");
    const requested = Number(ctx.args[0] ?? 0);
    const country = (ctx.args[1] ?? "").replace(/\D/gu, "");
    if (!Number.isInteger(requested) || requested <= 0 || requested > 1000 || !/^\d{1,3}$/u.test(country)) return commandUsageCard({ title: "Filterout Command", command: ".filterout", commandSyntax: ".filterout <count 1-1000> <country-code>", examples: [".filterout 25 234"], note: "The preview is bounded and excludes administrators and unresolved identities. Confirm is required before removal." });
    const self = firstVerifiedPhone(getSession(ctx.workspaceId, ctx.sessionId).phoneNumber);
    const targets = snapshot.participants
      .map((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id))
      .filter((phone): phone is string => Boolean(phone && phone.startsWith(country) && phone !== self))
      .filter((phone) => !snapshot.participants.some((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id) === phone && Boolean(participant.admin)))
      .slice(0, requested);
    if (!targets.length) return `No eligible verified-phone members match +${country}.`;
    const pending = registerGroupControlConfirmation({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      groupJid,
      senderJid: ctx.senderJid ?? "",
      operation: "participant",
      participantAction: "remove",
      participants: targets.map((phone) => phoneJidFromIdentity(phone)!),
      table: { title: "Member Control · FILTEROUT Confirmation", headers: ["Selection", "Scope"], rows: [[`${targets.length} verified members`, `Country prefix +${country}`]], buttons: [], footer: "No action is queued until Confirm is tapped. This preview expires in 90 seconds." },
    });
    pending.table.buttons = [
      { text: "✅ Confirm FILTEROUT", id: `group-control:confirm:${pending.token}` },
      { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
    ];
    return { text: formatModerationMessage("FILTEROUT REVIEW", [["Selected", String(targets.length)], ["Country", `+${country}`], ["Safety", "No action queued"]]), nativeTable: pending.table, nativeFlow: pending.table.buttons };
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function blockAll(ctx: CommandContext): Promise<string | WhatsAppCommandReply> {
  try {
    const { groupJid, snapshot } = await freshGroup(ctx, "Block All");
    const self = firstVerifiedPhone(getSession(ctx.workspaceId, ctx.sessionId).phoneNumber);
    const targets = snapshot.participants
      .map((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id))
      .filter((phone): phone is string => Boolean(phone))
      .filter((phone) => phone !== self)
      .filter((phone) => !snapshot.participants.some((participant) => firstVerifiedPhone(participant.phoneNumber, participant.jid, participant.id) === phone && Boolean(participant.admin)))
      .slice(0, 1000);
    if (!targets.length) return "No eligible verified-phone members were found; administrators and unresolved identities are excluded.";
    const pending = registerGroupControlConfirmation({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      groupJid,
      senderJid: ctx.senderJid ?? "",
      operation: "participant",
      participantAction: "block",
      participants: targets.map((phone) => phoneJidFromIdentity(phone)!),
      table: {
        title: "Member Control · BLOCKALL Confirmation",
        headers: ["Selection", "Scope"],
        rows: [[`${targets.length} verified members`, "Non-admin participants only"]],
        buttons: [],
        footer: "Bounded at 1,000 targets · Confirm within 90 seconds or the plan expires.",
      },
    });
    pending.table.buttons = [
      { text: "✅ Confirm BLOCKALL", id: `group-control:confirm:${pending.token}` },
      { text: "❌ Cancel", id: `group-control:cancel:${pending.token}` },
    ];
    return { text: formatModerationMessage("BLOCKALL REVIEW", [["Selected", String(targets.length)], ["Scope", "Verified non-admin members"], ["Safety", "No action queued"]]), nativeTable: pending.table, nativeFlow: pending.table.buttons };
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
