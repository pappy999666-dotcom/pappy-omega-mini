import crypto from "node:crypto";
import mongoose, { type Model } from "mongoose";
import { env } from "../config/env.js";
import type { User, WhatsAppSession, Workspace } from "../types/domain.js";

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

interface ForceJoinTargetDocument
  extends ForceJoinTargetRecord, mongoose.Document {}
interface UserDocument extends User, mongoose.Document {}
interface WorkspaceDocument extends Workspace, mongoose.Document {}
interface SessionDocument extends WhatsAppSession, mongoose.Document {}

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
    autoJoinEnabled: { type: Boolean, required: true },
    connectedAt: Number,
    lastHealthyAt: Number,
    disconnectReason: String,
  },
  { collection: "whatsapp_sessions", versionKey: false },
);
sessionSchema.index({ workspaceId: 1, status: 1 });

let connectionPromise: Promise<typeof mongoose> | undefined;
let ForceJoinTarget: Model<ForceJoinTargetDocument> | undefined;
let UserModel: Model<UserDocument> | undefined;
let WorkspaceModel: Model<WorkspaceDocument> | undefined;
let SessionModel: Model<SessionDocument> | undefined;

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  connectionPromise ??= mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 10,
  });
  return connectionPromise;
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

export async function ensureMongoIndexes(): Promise<void> {
  await connectMongo();
  await Promise.all([
    targetModel().createIndexes(),
    userModel().createIndexes(),
    workspaceModel().createIndexes(),
    sessionModel().createIndexes(),
  ]);
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
