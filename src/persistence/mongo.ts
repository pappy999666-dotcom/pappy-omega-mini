import crypto from "node:crypto";
import mongoose, { type Model } from "mongoose";
import { env } from "../config/env.js";
import type { User, WhatsAppSession, Workspace } from "../types/domain.js";
import type { AuditEvent, EmergencyState } from "../types/v2.js";
import type { MenuMedia } from "../types/domain.js";
import type { AutoPromoteConfig, AutoPromoteRun } from "../autopromote/types.js";

export interface WhatsAppMessageTraceRecord {
  traceId: string;
  workspaceId: string;
  sessionId: string;
  messageId?: string;
  direction: "inbound" | "outbound";
  remoteJid?: string;
  senderJid?: string;
  normalizedText?: string;
  authorized?: boolean;
  handler?: string;
  outcome: "received" | "ignored" | "processed" | "replied" | "failed";
  failureReason?: string;
  timestamp: number;
}

export interface SupportTicketRecord {
  ticketId: string;
  workspaceId: string;
  requesterTelegramUserId?: string;
  sessionId?: string;
  senderJid?: string;
  message: string;
  status: "open" | "answered" | "closed";
  createdAt: number;
  updatedAt: number;
  lastReply?: string;
}

export interface ForceJoinTargetRecord {
  targetId: string;
  targetType: "channel" | "group";
  usernameOrLink: string;
  displayName: string;
  buttonText: string;
  enabled: boolean;
  required: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface WhatsAppMessageTraceDocument
  extends WhatsAppMessageTraceRecord, mongoose.Document {}
interface SupportTicketDocument
  extends SupportTicketRecord, mongoose.Document {}
interface ForceJoinTargetDocument
  extends ForceJoinTargetRecord, mongoose.Document {}
interface UserDocument extends User, mongoose.Document {}
interface WorkspaceDocument extends Workspace, mongoose.Document {}
interface SessionDocument extends WhatsAppSession, mongoose.Document {}
interface AuditDocument extends AuditEvent, mongoose.Document {}
interface MediaDocument extends MenuMedia, mongoose.Document {}
type AutoPromoteConfigDocument = mongoose.Document & AutoPromoteConfig;
type AutoPromoteRunDocument = mongoose.Document & AutoPromoteRun;
interface ScheduleDocument extends mongoose.Document {
  scheduleId: string;
  workspaceId: string;
  sessionId?: string;
  kind: "allstatus" | "allchat" | "tag" | "link-validation" | "join-manager";
  payload: Record<string, unknown>;
  timezone: string;
  nextRunAt: number;
  intervalMs?: number;
  enabled: boolean;
  lastRunAt?: number;
  updatedAt: number;
}
interface EmergencyDocument extends EmergencyState, mongoose.Document {}
export interface ModeratorGroupRecord {
  groupId: string;
  title?: string;
  enabled: boolean;
  antiLink: boolean;
  antiSpam: boolean;
  warnLimit: number;
  muteDefaultSeconds: number;
  rules?: string;
  rulesDraft?: string;
  rulesVersion?: number;
  rulesUpdatedAt?: number;
  welcomeEnabled: boolean;
  goodbyeEnabled: boolean;
  welcomeText?: string;
  goodbyeText?: string;
  filters: Array<{ trigger: string; response: string }>;
  whitelist: string[];
  staff: string[];
  trustedUsers?: string[];
  knownMembers?: string[];
  groupMuteUntil?: number;
  groupLockUntil?: number;
  groupLockReason?: string;
  raidEnabled?: boolean;
  raidJoinThreshold?: number;
  raidWindowSeconds?: number;
  updatedAt: number;
}
export interface ModeratorWarningRecord {
  warningId: string;
  groupId: string;
  userId: string;
  actorId: string;
  reason: string;
  count: number;
  createdAt: number;
}
export interface ModeratorEventRecord {
  eventId: string;
  groupId: string;
  actorId: string;
  targetId?: string;
  rule: string;
  action: string;
  reason?: string;
  messageId?: number;
  success: boolean;
  failureReason?: string;
  correlationId?: string;
  phase?: string;
  exemption?: string;
  timestamp: number;
}
interface ModeratorGroupDocument
  extends ModeratorGroupRecord, mongoose.Document {}
interface ModeratorWarningDocument
  extends ModeratorWarningRecord, mongoose.Document {}
interface ModeratorEventDocument
  extends ModeratorEventRecord, mongoose.Document {}
interface PairingRequestDocument extends mongoose.Document {
  telegramUserId: string;
  stage: "label" | "phone";
  chatId: number;
  messageId?: number;
  sessionId?: string;
  updatedAt: number;
}

const whatsappMessageTraceSchema =
  new mongoose.Schema<WhatsAppMessageTraceDocument>(
    {
      traceId: { type: String, required: true, unique: true },
      workspaceId: { type: String, required: true, index: true },
      sessionId: { type: String, required: true, index: true },
      messageId: String,
      direction: { type: String, required: true },
      remoteJid: String,
      senderJid: String,
      normalizedText: String,
      authorized: Boolean,
      handler: String,
      outcome: { type: String, required: true },
      failureReason: String,
      timestamp: { type: Number, required: true, index: true },
    },
    { collection: "whatsapp_message_traces", versionKey: false },
  );
whatsappMessageTraceSchema.index({
  workspaceId: 1,
  sessionId: 1,
  timestamp: -1,
});

const supportTicketSchema = new mongoose.Schema<SupportTicketDocument>(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    requesterTelegramUserId: String,
    sessionId: String,
    senderJid: String,
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "answered", "closed"],
      required: true,
      index: true,
    },
    createdAt: { type: Number, required: true, index: true },
    updatedAt: { type: Number, required: true },
    lastReply: String,
  },
  { collection: "support_tickets", versionKey: false },
);
supportTicketSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
const forceJoinSchema = new mongoose.Schema<ForceJoinTargetDocument>(
  {
    targetId: { type: String, required: true, unique: true, index: true },
    targetType: { type: String, enum: ["channel", "group"], required: true },
    usernameOrLink: { type: String, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    buttonText: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true, index: true },
    required: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, index: true },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "force_join_targets", versionKey: false },
);
forceJoinSchema.index({ enabled: 1, required: 1, sortOrder: 1 });

const userSchema = new mongoose.Schema<UserDocument>(
  {
    telegramUserId: { type: String, required: true, unique: true, index: true },
    username: String,
    displayName: String,
    role: { type: String, enum: ["owner", "admin", "user"], required: true },
    status: {
      type: String,
      enum: ["active", "banned"],
      required: true,
      index: true,
    },
    workspaceId: { type: String, required: true, index: true },
    createdAt: { type: Number, required: true },
    lastSeenAt: { type: Number, required: true, index: true },
  },
  { collection: "users", versionKey: false },
);

const workspaceSchema = new mongoose.Schema<WorkspaceDocument>(
  {
    workspaceId: { type: String, required: true, unique: true, index: true },
    ownerTelegramUserId: { type: String, required: true, index: true },
    globalSudoList: { type: [String], default: [] },
    createdAt: { type: Number, required: true },
  },
  { collection: "workspaces", versionKey: false },
);

const sessionSchema = new mongoose.Schema<SessionDocument>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    sessionName: { type: String, required: true },
    phoneNumber: String,
    status: { type: String, required: true, index: true },
    prefix: { type: String, required: true },
    sudoList: { type: [String], default: [] },
    autoJoinEnabled: { type: Boolean, required: true, default: false },
    joinSettings: {
      targetCount: Number,
      delayMs: Number,
      minDelayMs: Number,
      maxDelayMs: Number,
      batchCycles: Number,
      maxConcurrency: Number,
      retryLimit: Number,
      retryBaseMs: Number,
      sessionCooldownMs: Number,
      restrictionThreshold: Number,
      mode: String,
    },
    autoCollectLinks: { type: Boolean, default: true },
    autoValidateLinks: { type: Boolean, default: true },
    createdAt: { type: Number, index: true },
    collectedLinkCount: { type: Number, default: 0 },
    validatedLinkCount: { type: Number, default: 0 },
    lastLinkCollectedAt: Number,
    lastLinkValidatedAt: Number,
    connectedAt: Number,
    lastHealthyAt: Number,
    lastMessageReceivedAt: Number,
    lastCommandProcessedAt: Number,
    lastOutboundMessageAt: Number,
    lastReconnectAt: Number,
    reconnectCount: Number,
    socketGeneration: Number,
    authHealth: String,
    workerNodeId: String,
    lastError: String,
    disconnectReason: String,
  },
  { collection: "whatsapp_sessions", versionKey: false },
);
sessionSchema.index({ workspaceId: 1, status: 1 });
const mediaSchema = new mongoose.Schema<MediaDocument>(
  {
    mediaId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    filePath: { type: String, required: true },
    bytes: { type: Number, required: true },
    enabled: { type: Boolean, required: true },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "menu_media", versionKey: false },
);
const scheduleSchema = new mongoose.Schema<ScheduleDocument>(
  {
    scheduleId: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    sessionId: String,
    kind: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    timezone: { type: String, required: true },
    nextRunAt: { type: Number, required: true, index: true },
    intervalMs: Number,
    enabled: { type: Boolean, required: true, index: true },
    lastRunAt: Number,
    updatedAt: { type: Number, required: true },
  },
  { collection: "schedules", versionKey: false },
);
const autoPromoteConfigSchema = new mongoose.Schema<AutoPromoteConfigDocument>(
  {
    id: { type: String, required: true, unique: true, index: true },
    scope: { type: String, enum: ["SESSION", "USER", "GLOBAL"], required: true, index: true },
    ownerTelegramUserId: { type: String, required: true, index: true },
    ownerWorkspaceId: String,
    sessionId: String,
    targetSessionIds: { type: [String], default: [] },
    command: { type: String, enum: ["allstatus", "allchat", "allstatusx"], required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    days: { type: Number, required: true },
    timesPerDay: { type: Number, required: true },
    allstatusxPostsPerGroup: Number,
    timezone: { type: String, required: true },
    slotTimes: { type: mongoose.Schema.Types.Mixed, required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    enabled: { type: Boolean, required: true, index: true },
    state: { type: String, required: true, index: true },
    cooldownMinutes: { type: Number, required: true },
    misfireGraceMinutes: { type: Number, required: true },
    createdAt: { type: Number, required: true, index: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "auto_promote_configs", versionKey: false },
);
autoPromoteConfigSchema.index({ ownerTelegramUserId: 1, enabled: 1, updatedAt: -1 });
autoPromoteConfigSchema.index({ scope: 1, sessionId: 1, enabled: 1 });
const autoPromoteRunSchema = new mongoose.Schema<AutoPromoteRunDocument>(
  {
    id: { type: String, required: true, unique: true, index: true },
    configId: { type: String, required: true, index: true },
    occurrenceId: { type: String, required: true, unique: true, index: true },
    scope: { type: String, required: true, index: true },
    ownerTelegramUserId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    scheduledAt: { type: Number, required: true, index: true },
    startedAt: Number,
    finishedAt: Number,
    status: { type: String, required: true, index: true },
    currentGroup: String,
    totalGroups: { type: Number, required: true },
    completedGroups: { type: Number, required: true },
    failedGroups: { type: Number, required: true },
    currentRepetition: { type: Number, required: true },
    totalRepetitions: { type: Number, required: true },
    retryCount: { type: Number, required: true },
    successCount: { type: Number, required: true },
    cooldownUntil: Number,
    error: String,
    jobId: String,
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "auto_promote_runs", versionKey: false },
);
autoPromoteRunSchema.index({ sessionId: 1, status: 1, scheduledAt: 1 });
autoPromoteRunSchema.index({ configId: 1, scheduledAt: 1 });
const auditSchema = new mongoose.Schema<AuditDocument>(
  {
    correlationId: { type: String, required: true, unique: true, index: true },
    actorTelegramUserId: { type: String, required: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    sessionId: String,
    action: { type: String, required: true, index: true },
    success: { type: Boolean, required: true },
    reason: String,
    metadata: { type: mongoose.Schema.Types.Mixed, required: true },
    timestamp: { type: Number, required: true, index: true },
  },
  { collection: "audit_events", versionKey: false },
);
const emergencySchema = new mongoose.Schema<EmergencyDocument>(
  {
    enabled: { type: Boolean, required: true },
    pauseMassSends: { type: Boolean, required: true },
    pauseJoins: { type: Boolean, required: true },
    pauseBroadcasts: { type: Boolean, required: true },
    pauseScheduler: { type: Boolean, required: true },
    disablePairing: { type: Boolean, required: true },
    updatedAt: { type: Number, required: true },
    updatedBy: { type: String, required: true },
  },
  { collection: "emergency_state", versionKey: false },
);
const moderatorGroupSchema = new mongoose.Schema<ModeratorGroupDocument>(
  {
    groupId: { type: String, required: true, unique: true, index: true },
    title: String,
    enabled: { type: Boolean, default: false },
    antiLink: { type: Boolean, default: false },
    antiSpam: { type: Boolean, default: false },
    warnLimit: { type: Number, default: 3 },
    muteDefaultSeconds: { type: Number, default: 600 },
    rules: String,
    rulesDraft: String,
    rulesVersion: { type: Number, default: 0 },
    rulesUpdatedAt: Number,
    welcomeEnabled: { type: Boolean, default: false },
    goodbyeEnabled: { type: Boolean, default: false },
    welcomeText: String,
    goodbyeText: String,
    filters: {
      type: [
        {
          trigger: { type: String, required: true },
          response: { type: String, required: true },
        },
      ],
      default: [],
    },
    whitelist: { type: [String], default: [] },
    staff: { type: [String], default: [] },
    trustedUsers: { type: [String], default: [] },
    knownMembers: { type: [String], default: [] },
    groupMuteUntil: Number,
    groupLockUntil: Number,
    groupLockReason: String,
    raidEnabled: { type: Boolean, default: false },
    raidJoinThreshold: { type: Number, default: 8 },
    raidWindowSeconds: { type: Number, default: 30 },
    updatedAt: { type: Number, required: true },
  },
  { collection: "moderator_groups", versionKey: false },
);
const moderatorWarningSchema = new mongoose.Schema<ModeratorWarningDocument>(
  {
    warningId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    reason: { type: String, required: true },
    count: { type: Number, required: true },
    createdAt: { type: Number, required: true, index: true },
  },
  { collection: "moderator_warnings", versionKey: false },
);
const moderatorEventSchema = new mongoose.Schema<ModeratorEventDocument>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    targetId: String,
    rule: { type: String, required: true },
    action: { type: String, required: true },
    reason: String,
    messageId: Number,
    success: { type: Boolean, required: true },
    failureReason: String,
    correlationId: String,
    phase: String,
    exemption: String,
    timestamp: { type: Number, required: true, index: true },
  },
  { collection: "moderator_events", versionKey: false },
);
const pairingRequestSchema = new mongoose.Schema<PairingRequestDocument>(
  {
    telegramUserId: { type: String, required: true, unique: true, index: true },
    stage: { type: String, enum: ["label", "phone"], required: true },
    chatId: { type: Number, required: true },
    messageId: Number,
    sessionId: String,
    updatedAt: { type: Number, required: true, index: true },
  },
  { collection: "pairing_requests", versionKey: false },
);

let connectionPromise: Promise<typeof mongoose> | undefined;
let SupportTicket: Model<SupportTicketDocument> | undefined;
let ForceJoinTarget: Model<ForceJoinTargetDocument> | undefined;
let UserModel: Model<UserDocument> | undefined;
let WorkspaceModel: Model<WorkspaceDocument> | undefined;
let SessionModel: Model<SessionDocument> | undefined;
let PairingRequestModel: Model<PairingRequestDocument> | undefined;
let AuditModel: Model<AuditDocument> | undefined;
let ScheduleModel: Model<ScheduleDocument> | undefined;
let MediaModel: Model<MediaDocument> | undefined;
let AutoPromoteConfigModel: Model<AutoPromoteConfigDocument> | undefined;
let AutoPromoteRunModel: Model<AutoPromoteRunDocument> | undefined;
let EmergencyModel: Model<EmergencyDocument> | undefined;
let ModeratorGroupModel: Model<ModeratorGroupDocument> | undefined;
let ModeratorWarningModel: Model<ModeratorWarningDocument> | undefined;
let ModeratorEventModel: Model<ModeratorEventDocument> | undefined;

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  connectionPromise ??= mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 10,
  });
  return connectionPromise;
}

function whatsappMessageTraceModel(): Model<WhatsAppMessageTraceDocument> {
  return (
    mongoose.models.WhatsAppMessageTrace ??
    mongoose.model<WhatsAppMessageTraceDocument>(
      "WhatsAppMessageTrace",
      whatsappMessageTraceSchema,
    )
  );
}

function supportTicketModel(): Model<SupportTicketDocument> {
  return (SupportTicket ??=
    mongoose.models.SupportTicket ??
    mongoose.model<SupportTicketDocument>(
      "SupportTicket",
      supportTicketSchema,
    ));
}
function targetModel(): Model<ForceJoinTargetDocument> {
  return (ForceJoinTarget ??=
    mongoose.models.ForceJoinTarget ??
    mongoose.model<ForceJoinTargetDocument>(
      "ForceJoinTarget",
      forceJoinSchema,
    ));
}

function userModel(): Model<UserDocument> {
  return (UserModel ??=
    mongoose.models.User ?? mongoose.model<UserDocument>("User", userSchema));
}
function workspaceModel(): Model<WorkspaceDocument> {
  return (WorkspaceModel ??=
    mongoose.models.Workspace ??
    mongoose.model<WorkspaceDocument>("Workspace", workspaceSchema));
}
function sessionModel(): Model<SessionDocument> {
  return (SessionModel ??=
    mongoose.models.WhatsAppSession ??
    mongoose.model<SessionDocument>("WhatsAppSession", sessionSchema));
}
function mediaModel(): Model<MediaDocument> {
  return (MediaModel ??=
    mongoose.models.MenuMedia ??
    mongoose.model<MediaDocument>("MenuMedia", mediaSchema));
}
function scheduleModel(): Model<ScheduleDocument> {
  return (ScheduleModel ??=
    mongoose.models.Schedule ??
    mongoose.model<ScheduleDocument>("Schedule", scheduleSchema));
}
function autoPromoteConfigModel(): Model<AutoPromoteConfigDocument> {
  return (AutoPromoteConfigModel ??=
    mongoose.models.AutoPromoteConfig ??
    mongoose.model<AutoPromoteConfigDocument>("AutoPromoteConfig", autoPromoteConfigSchema));
}
function autoPromoteRunModel(): Model<AutoPromoteRunDocument> {
  return (AutoPromoteRunModel ??=
    mongoose.models.AutoPromoteRun ??
    mongoose.model<AutoPromoteRunDocument>("AutoPromoteRun", autoPromoteRunSchema));
}
function auditModel(): Model<AuditDocument> {
  return (AuditModel ??=
    mongoose.models.AuditEvent ??
    mongoose.model<AuditDocument>("AuditEvent", auditSchema));
}
function emergencyModel(): Model<EmergencyDocument> {
  return (EmergencyModel ??=
    mongoose.models.EmergencyState ??
    mongoose.model<EmergencyDocument>("EmergencyState", emergencySchema));
}
function moderatorGroupModel(): Model<ModeratorGroupDocument> {
  return (ModeratorGroupModel ??=
    mongoose.models.ModeratorGroup ??
    mongoose.model<ModeratorGroupDocument>(
      "ModeratorGroup",
      moderatorGroupSchema,
    ));
}
function moderatorWarningModel(): Model<ModeratorWarningDocument> {
  return (ModeratorWarningModel ??=
    mongoose.models.ModeratorWarning ??
    mongoose.model<ModeratorWarningDocument>(
      "ModeratorWarning",
      moderatorWarningSchema,
    ));
}
function moderatorEventModel(): Model<ModeratorEventDocument> {
  return (ModeratorEventModel ??=
    mongoose.models.ModeratorEvent ??
    mongoose.model<ModeratorEventDocument>(
      "ModeratorEvent",
      moderatorEventSchema,
    ));
}
function pairingRequestModel(): Model<PairingRequestDocument> {
  return (PairingRequestModel ??=
    mongoose.models.PairingRequest ??
    mongoose.model<PairingRequestDocument>(
      "PairingRequest",
      pairingRequestSchema,
    ));
}

export async function ensureMongoIndexes(): Promise<void> {
  await connectMongo();
  await Promise.all([
    supportTicketModel().createIndexes(),
    targetModel().createIndexes(),
    userModel().createIndexes(),
    workspaceModel().createIndexes(),
    sessionModel().createIndexes(),
    pairingRequestModel().createIndexes(),
    auditModel().createIndexes(),
    scheduleModel().createIndexes(),
    autoPromoteConfigModel().createIndexes(),
    autoPromoteRunModel().createIndexes(),
    mediaModel().createIndexes(),
    emergencyModel().createIndexes(),
    moderatorGroupModel().createIndexes(),
    moderatorWarningModel().createIndexes(),
    moderatorEventModel().createIndexes(),
  ]);
}

export async function createSupportTicket(
  ticket: SupportTicketRecord,
): Promise<void> {
  await connectMongo();
  await supportTicketModel().replaceOne({ ticketId: ticket.ticketId }, ticket, {
    upsert: true,
  });
}
export async function listSupportTickets(
  workspaceId: string,
  status?: SupportTicketRecord["status"],
): Promise<SupportTicketRecord[]> {
  await connectMongo();
  return supportTicketModel()
    .find({ workspaceId, ...(status ? { status } : {}) })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean<SupportTicketRecord[]>()
    .exec();
}
export async function updateSupportTicket(
  ticketId: string,
  patch: Partial<Pick<SupportTicketRecord, "status" | "lastReply">>,
): Promise<SupportTicketRecord | undefined> {
  await connectMongo();
  const updated = await supportTicketModel()
    .findOneAndUpdate(
      { ticketId },
      { $set: { ...patch, updatedAt: Date.now() } },
      { new: true },
    )
    .lean<SupportTicketRecord>()
    .exec();
  return updated ?? undefined;
}

export async function persistUser(user: User): Promise<void> {
  await connectMongo();
  await userModel().replaceOne({ telegramUserId: user.telegramUserId }, user, {
    upsert: true,
  });
}
export async function persistWorkspace(workspace: Workspace): Promise<void> {
  await connectMongo();
  await workspaceModel().replaceOne(
    { workspaceId: workspace.workspaceId },
    workspace,
    { upsert: true },
  );
}
export async function persistMenuMedia(media: MenuMedia): Promise<void> {
  await connectMongo();
  await mediaModel().replaceOne({ mediaId: media.mediaId }, media, {
    upsert: true,
  });
}
export async function loadMenuMedia(
  workspaceId?: string,
): Promise<MenuMedia[]> {
  await connectMongo();
  const filter = workspaceId ? { workspaceId } : {};
  return mediaModel()
    .find(filter)
    .sort({ updatedAt: -1 })
    .lean<MenuMedia[]>()
    .exec();
}

export interface ScheduleRecord {
  scheduleId: string;
  workspaceId: string;
  sessionId?: string;
  kind: "allstatus" | "allchat" | "tag" | "link-validation" | "join-manager";
  payload: Record<string, unknown>;
  timezone: string;
  nextRunAt: number;
  intervalMs?: number;
  enabled: boolean;
  lastRunAt?: number;
  updatedAt: number;
}
export async function listSchedules(
  workspaceId: string,
  limit = 50,
): Promise<ScheduleRecord[]> {
  await connectMongo();
  return scheduleModel()
    .find({ workspaceId })
    .sort({ nextRunAt: 1 })
    .limit(limit)
    .lean<ScheduleRecord[]>()
    .exec();
}
export async function disableSchedule(scheduleId: string): Promise<void> {
  await connectMongo();
  await scheduleModel()
    .updateOne(
      { scheduleId },
      { $set: { enabled: false, updatedAt: Date.now() } },
    )
    .exec();
}
export async function saveSchedule(schedule: ScheduleRecord): Promise<void> {
  await connectMongo();
  await scheduleModel().replaceOne(
    { scheduleId: schedule.scheduleId },
    schedule,
    { upsert: true },
  );
}
export async function listDueSchedules(
  now = Date.now(),
  limit = 25,
): Promise<ScheduleRecord[]> {
  await connectMongo();
  return scheduleModel()
    .find({ enabled: true, nextRunAt: { $lte: now } })
    .sort({ nextRunAt: 1 })
    .limit(limit)
    .lean<ScheduleRecord[]>()
    .exec();
}
export async function claimSchedule(
  scheduleId: string,
  now = Date.now(),
): Promise<ScheduleRecord | undefined> {
  await connectMongo();
  const current = await scheduleModel()
    .findOne({ scheduleId, enabled: true, nextRunAt: { $lte: now } })
    .lean<ScheduleRecord>()
    .exec();
  if (!current) return undefined;
  const nextRunAt = current.intervalMs ? now + current.intervalMs : now;
  const updated = await scheduleModel()
    .findOneAndUpdate(
      { scheduleId, enabled: true, nextRunAt: current.nextRunAt },
      {
        $set: {
          lastRunAt: now,
          nextRunAt,
          ...(current.intervalMs ? {} : { enabled: false }),
          updatedAt: now,
        },
      },
      { new: true },
    )
    .lean<ScheduleRecord>()
    .exec();
  return updated ?? undefined;
}

export async function persistAuditEvent(event: AuditEvent): Promise<void> {
  await connectMongo();
  await auditModel().replaceOne({ correlationId: event.correlationId }, event, {
    upsert: true,
  });
}
export async function loadAuditEvents(
  workspaceId?: string,
  limit = 100,
): Promise<AuditEvent[]> {
  await connectMongo();
  const filter = workspaceId ? { workspaceId } : {};
  const query = auditModel().find(filter).sort({ timestamp: -1 });
  if (limit > 0) query.limit(limit);
  return query.lean<AuditEvent[]>().exec();
}
export async function loadModeratorGroup(
  groupId: string,
): Promise<ModeratorGroupRecord | undefined> {
  await connectMongo();
  return (
    (await moderatorGroupModel()
      .findOne({ groupId })
      .lean<ModeratorGroupRecord>()
      .exec()) ?? undefined
  );
}
export async function listModeratorGroups(): Promise<ModeratorGroupRecord[]> {
  await connectMongo();
  return moderatorGroupModel()
    .find({})
    .sort({ updatedAt: -1 })
    .lean<ModeratorGroupRecord[]>()
    .exec();
}
export async function listDueModeratorGroups(
  now = Date.now(),
): Promise<ModeratorGroupRecord[]> {
  await connectMongo();
  return moderatorGroupModel()
    .find({
      $or: [
        { groupMuteUntil: { $lte: now } },
        { groupLockUntil: { $lte: now } },
      ],
    })
    .lean<ModeratorGroupRecord[]>()
    .exec();
}
export async function saveModeratorGroup(
  group: ModeratorGroupRecord,
): Promise<void> {
  await connectMongo();
  await moderatorGroupModel().replaceOne({ groupId: group.groupId }, group, {
    upsert: true,
  });
}
export async function countModeratorWarnings(
  groupId: string,
  userId: string,
): Promise<number> {
  await connectMongo();
  return moderatorWarningModel().countDocuments({ groupId, userId }).exec();
}
export async function countModeratorWarningsForGroup(
  groupId: string,
): Promise<number> {
  await connectMongo();
  return moderatorWarningModel().countDocuments({ groupId }).exec();
}
export async function saveModeratorWarning(
  warning: ModeratorWarningRecord,
): Promise<void> {
  await connectMongo();
  await moderatorWarningModel().replaceOne(
    { warningId: warning.warningId },
    warning,
    { upsert: true },
  );
}
export async function deleteModeratorWarnings(
  groupId: string,
  userId: string,
): Promise<number> {
  await connectMongo();
  const result = await moderatorWarningModel()
    .deleteMany({ groupId, userId })
    .exec();
  return result.deletedCount ?? 0;
}
export async function listModeratorWarnings(
  groupId: string,
  userId?: string,
): Promise<ModeratorWarningRecord[]> {
  await connectMongo();
  return moderatorWarningModel()
    .find({ groupId, ...(userId ? { userId } : {}) })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<ModeratorWarningRecord[]>()
    .exec();
}
export async function saveWhatsAppMessageTrace(
  record: WhatsAppMessageTraceRecord,
): Promise<void> {
  await connectMongo();
  await whatsappMessageTraceModel().create(record);
}

export async function purgeWhatsAppSessionTraces(
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  await connectMongo();
  const result = await whatsappMessageTraceModel()
    .deleteMany({ workspaceId, sessionId })
    .exec();
  return result.deletedCount ?? 0;
}

export async function saveModeratorEvent(
  event: ModeratorEventRecord,
): Promise<void> {
  await connectMongo();
  await moderatorEventModel().replaceOne({ eventId: event.eventId }, event, {
    upsert: true,
  });
}
export async function listModeratorEvents(
  groupId: string,
  limit = 50,
): Promise<ModeratorEventRecord[]> {
  await connectMongo();
  return moderatorEventModel()
    .find({ groupId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean<ModeratorEventRecord[]>()
    .exec();
}

export async function persistEmergencyState(
  state: EmergencyState,
): Promise<void> {
  await connectMongo();
  const existing = await emergencyModel()
    .findOne({})
    .select({ _id: 1 })
    .lean<{ _id: unknown }>()
    .exec();
  await emergencyModel().replaceOne(
    existing ? { _id: existing._id } : {},
    state,
    { upsert: true },
  );
}
export async function loadEmergencyState(): Promise<
  EmergencyState | undefined
> {
  await connectMongo();
  return (
    (await emergencyModel().findOne({}).lean<EmergencyState>().exec()) ??
    undefined
  );
}

export interface PairingRequestRecord {
  telegramUserId: string;
  stage: "label" | "phone";
  chatId: number;
  messageId?: number;
  sessionId?: string;
  updatedAt: number;
}

export async function savePairingRequest(
  request: PairingRequestRecord,
): Promise<void> {
  await connectMongo();
  await pairingRequestModel().replaceOne(
    { telegramUserId: request.telegramUserId },
    request,
    { upsert: true },
  );
}
export async function getPairingRequest(
  telegramUserId: string,
): Promise<PairingRequestRecord | undefined> {
  await connectMongo();
  const record = await pairingRequestModel()
    .findOne({ telegramUserId })
    .lean<PairingRequestRecord>()
    .exec();
  return record ?? undefined;
}
export async function deletePairingRequest(
  telegramUserId: string,
): Promise<void> {
  await connectMongo();
  await pairingRequestModel().deleteOne({ telegramUserId });
}

export async function listExpiredPairingRequests(
  cutoffAt: number,
): Promise<PairingRequestRecord[]> {
  await connectMongo();
  return pairingRequestModel()
    .find({ updatedAt: { $lt: cutoffAt } })
    .lean<PairingRequestRecord[]>()
    .exec();
}

export async function deleteExpiredPairingRequests(
  cutoffAt: number,
): Promise<number> {
  await connectMongo();
  const result = await pairingRequestModel().deleteMany({
    updatedAt: { $lt: cutoffAt },
  });
  return result.deletedCount ?? 0;
}

export async function listUsers(limit = 50, skip = 0): Promise<User[]> {
  await connectMongo();
  return userModel()
    .find()
    .sort({ lastSeenAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean<User[]>()
    .exec();
}

export async function setUserStatus(
  telegramUserId: string,
  status: User["status"],
): Promise<boolean> {
  await connectMongo();
  const result = await userModel().updateOne(
    { telegramUserId },
    { $set: { status } },
  );
  return result.matchedCount > 0;
}

export async function deletePersistedSession(sessionId: string): Promise<void> {
  await connectMongo();
  await sessionModel().deleteOne({ sessionId }).exec();
}

export async function persistSession(session: WhatsAppSession): Promise<void> {
  await connectMongo();
  await sessionModel().replaceOne({ sessionId: session.sessionId }, session, {
    upsert: true,
  });
}
export async function hydrateRegistry(): Promise<{
  users: User[];
  workspaces: Workspace[];
  sessions: WhatsAppSession[];
}> {
  await connectMongo();
  const [users, workspaces, sessions] = await Promise.all([
    userModel().find().lean<User[]>().exec(),
    workspaceModel().find().lean<Workspace[]>().exec(),
    sessionModel().find().lean<WhatsAppSession[]>().exec(),
  ]);
  return { users, workspaces, sessions };
}

export async function listForceJoinTargets(
  enabledOnly = false,
): Promise<ForceJoinTargetRecord[]> {
  await connectMongo();
  const query = enabledOnly ? { enabled: true, required: true } : {};
  return targetModel()
    .find(query)
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean<ForceJoinTargetRecord[]>()
    .exec();
}

export async function upsertForceJoinTarget(input: {
  targetId?: string;
  targetType: "channel" | "group";
  usernameOrLink: string;
  displayName: string;
  buttonText?: string;
  enabled?: boolean;
  required?: boolean;
}): Promise<ForceJoinTargetRecord> {
  await connectMongo();
  const now = Date.now();
  const targetId = input.targetId ?? crypto.randomUUID();
  const existing = await targetModel().findOne({ targetId }).lean();
  const record = await targetModel().findOneAndUpdate(
    { targetId },
    {
      $set: {
        ...input,
        targetId,
        buttonText:
          input.buttonText ?? existing?.buttonText ?? input.displayName,
        enabled: input.enabled ?? existing?.enabled ?? true,
        required: input.required ?? existing?.required ?? true,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, sortOrder: existing?.sortOrder ?? now },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!record) throw new Error("Force-join target could not be saved.");
  return record.toObject() as ForceJoinTargetRecord;
}

export async function setForceJoinTargetEnabled(
  targetId: string,
  enabled: boolean,
): Promise<boolean> {
  await connectMongo();
  const result = await targetModel().updateOne(
    { targetId },
    { $set: { enabled, updatedAt: Date.now() } },
  );
  return result.matchedCount > 0;
}

export async function removeForceJoinTarget(
  targetId: string,
): Promise<boolean> {
  await connectMongo();
  const result = await targetModel().deleteOne({ targetId });
  return result.deletedCount > 0;
}

export async function closeMongo(): Promise<void> {
  connectionPromise = undefined;
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}


export async function saveAutoPromoteConfig(
  config: AutoPromoteConfig,
): Promise<void> {
  await connectMongo();
  await autoPromoteConfigModel().replaceOne(
    { id: config.id },
    config,
    { upsert: true },
  ).exec();
}

export async function getAutoPromoteConfig(
  id: string,
): Promise<AutoPromoteConfig | undefined> {
  await connectMongo();
  return (await autoPromoteConfigModel().findOne({ id }).lean<AutoPromoteConfig>().exec()) ?? undefined;
}

export async function listAutoPromoteConfigs(input: {
  ownerTelegramUserId?: string;
  scope?: AutoPromoteConfig["scope"];
  enabled?: boolean;
  limit?: number;
} = {}): Promise<AutoPromoteConfig[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (input.ownerTelegramUserId) filter.ownerTelegramUserId = input.ownerTelegramUserId;
  if (input.scope) filter.scope = input.scope;
  if (input.enabled !== undefined) filter.enabled = input.enabled;
  return autoPromoteConfigModel()
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(input.limit ?? 100)
    .lean<AutoPromoteConfig[]>()
    .exec();
}

export async function disableAutoPromoteConfig(id: string): Promise<void> {
  await connectMongo();
  await autoPromoteConfigModel()
    .updateOne(
      { id },
      { $set: { enabled: false, state: "CANCELLED", updatedAt: Date.now() } },
    )
    .exec();
}

export async function saveAutoPromoteRun(run: AutoPromoteRun): Promise<void> {
  await connectMongo();
  await autoPromoteRunModel().replaceOne(
    { id: run.id },
    run,
    { upsert: true },
  ).exec();
}

export async function getAutoPromoteRun(
  id: string,
): Promise<AutoPromoteRun | undefined> {
  await connectMongo();
  return (await autoPromoteRunModel().findOne({ id }).lean<AutoPromoteRun>().exec()) ?? undefined;
}

export async function getAutoPromoteRunByOccurrence(
  occurrenceId: string,
): Promise<AutoPromoteRun | undefined> {
  await connectMongo();
  return (await autoPromoteRunModel().findOne({ occurrenceId }).lean<AutoPromoteRun>().exec()) ?? undefined;
}

export async function listAutoPromoteRuns(input: {
  ownerTelegramUserId?: string;
  configId?: string;
  sessionId?: string;
  limit?: number;
} = {}): Promise<AutoPromoteRun[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (input.ownerTelegramUserId) filter.ownerTelegramUserId = input.ownerTelegramUserId;
  if (input.configId) filter.configId = input.configId;
  if (input.sessionId) filter.sessionId = input.sessionId;
  return autoPromoteRunModel()
    .find(filter)
    .sort({ scheduledAt: -1 })
    .limit(input.limit ?? 100)
    .lean<AutoPromoteRun[]>()
    .exec();
}

export async function listRecoverableAutoPromoteRuns(
  now = Date.now(),
): Promise<AutoPromoteRun[]> {
  await connectMongo();
  return autoPromoteRunModel()
    .find({
      status: { $in: ["SCHEDULED", "QUEUED", "WAITING_FOR_SESSION", "RUNNING", "COOLDOWN"] },
      scheduledAt: { $lte: now },
    })
    .sort({ scheduledAt: 1 })
    .limit(500)
    .lean<AutoPromoteRun[]>()
    .exec();
}

export async function claimAutoPromoteOccurrence(
  occurrenceId: string,
  run: AutoPromoteRun,
): Promise<AutoPromoteRun | undefined> {
  await connectMongo();
  const existing = await autoPromoteRunModel().findOne({ occurrenceId }).lean<AutoPromoteRun>().exec();
  if (existing) return existing;
  try {
    await autoPromoteRunModel().create(run);
    return run;
  } catch (error) {
    if (error instanceof Error && /duplicate|E11000/i.test(error.message))
      return (await autoPromoteRunModel().findOne({ occurrenceId }).lean<AutoPromoteRun>().exec()) ?? undefined;
    throw error;
  }
}


export async function setAutoPromoteConfigState(
  id: string,
  state: AutoPromoteConfig["state"],
  enabled: boolean,
): Promise<void> {
  await connectMongo();
  await autoPromoteConfigModel()
    .updateOne({ id }, { $set: { state, enabled, updatedAt: Date.now() } })
    .exec();
}
