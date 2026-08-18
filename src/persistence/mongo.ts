import crypto from "node:crypto";
import mongoose, { type Model } from "mongoose";
import { env } from "../config/env.js";

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

let connectionPromise: Promise<typeof mongoose> | undefined;
let ForceJoinTarget: Model<ForceJoinTargetDocument> | undefined;

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

export async function ensureMongoIndexes(): Promise<void> {
  await connectMongo();
  await targetModel().createIndexes();
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
