import crypto from "node:crypto";
import mongoose, { type Model } from "mongoose";
import { connectMongo } from "../persistence/mongo.js";

export const VALIDATOR_GLOBAL_SCOPE = "__admin_validator__";

export type DurableValidatorState =
  "MAIN" | "PROCESSING" | "ACTIVE" | "DEAD" | "ERROR";

export type DurableValidatorErrorClass =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SOCKET_ERROR"
  | "AUTH_ERROR"
  | "WHATSAPP_RESTRICTION"
  | "PERMISSION_ERROR"
  | "INVALID_LINK"
  | "NOT_FOUND"
  | "REQUEST_REQUIRED"
  | "ALREADY_JOINED"
  | "TEMPORARY_ERROR"
  | "INTERNAL_ERROR";

export interface DurableValidatorLinkRecord {
  linkId: string;
  normalizedUrl: string;
  originalUrl: string;
  state: DurableValidatorState;
  scopeId: string;
  workspaceId: string;
  ownerUserId: string;
  sourceSessionId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  validatedAt?: number;
  validationAttempts: number;
  lastError?: string;
  lastErrorClass?: DurableValidatorErrorClass;
  validatorJobId?: string;
  workerId?: string;
  sessionId?: string;
  lockOwner?: string;
  lockExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface DurableValidatorLinkDocument
  extends DurableValidatorLinkRecord, mongoose.Document {}

const durableValidatorLinkSchema =
  new mongoose.Schema<DurableValidatorLinkDocument>(
    {
      linkId: { type: String, required: true, unique: true, index: true },
      normalizedUrl: { type: String, required: true },
      originalUrl: { type: String, required: true },
      state: { type: String, required: true, index: true },
      scopeId: { type: String, required: true, index: true },
      workspaceId: { type: String, required: true, index: true },
      ownerUserId: { type: String, required: true, index: true },
      sourceSessionId: { type: String, index: true },
      firstSeenAt: { type: Number, required: true, index: true },
      lastSeenAt: { type: Number, required: true, index: true },
      validatedAt: Number,
      validationAttempts: { type: Number, required: true, default: 0 },
      lastError: String,
      lastErrorClass: String,
      validatorJobId: { type: String, index: true },
      workerId: { type: String, index: true },
      sessionId: { type: String, index: true },
      lockOwner: { type: String, index: true },
      lockExpiresAt: { type: Number, index: true },
      createdAt: { type: Number, required: true, index: true },
      updatedAt: { type: Number, required: true, index: true },
    },
    { collection: "validator_links", versionKey: false },
  );

durableValidatorLinkSchema.index(
  { scopeId: 1, normalizedUrl: 1 },
  { unique: true, name: "validator_scope_normalized_url_unique" },
);
durableValidatorLinkSchema.index({ scopeId: 1, state: 1, updatedAt: -1 });
durableValidatorLinkSchema.index({ state: 1, lockExpiresAt: 1 });

let model: Model<DurableValidatorLinkDocument> | undefined;

function validatorLinkModel(): Model<DurableValidatorLinkDocument> {
  return (model ??=
    mongoose.models.ValidatorLink ??
    mongoose.model<DurableValidatorLinkDocument>(
      "ValidatorLink",
      durableValidatorLinkSchema,
    ));
}

export async function ensureDurableValidatorIndexes(): Promise<void> {
  await connectMongo();
  await validatorLinkModel().createIndexes();
}

export async function upsertDurableValidatorLink(input: {
  normalizedUrl: string;
  originalUrl: string;
  scopeId?: string;
  workspaceId: string;
  ownerUserId: string;
  sourceSessionId?: string;
}): Promise<DurableValidatorLinkRecord> {
  await connectMongo();
  const now = Date.now();
  const scopeId = input.scopeId ?? VALIDATOR_GLOBAL_SCOPE;
  const record = await validatorLinkModel()
    .findOneAndUpdate(
      { scopeId, normalizedUrl: input.normalizedUrl },
      {
        $set: {
          originalUrl: input.originalUrl,
          lastSeenAt: now,
          updatedAt: now,
          ...(input.sourceSessionId
            ? { sourceSessionId: input.sourceSessionId }
            : {}),
        },
        $setOnInsert: {
          linkId: crypto.randomUUID(),
          normalizedUrl: input.normalizedUrl,
          state: "MAIN",
          scopeId,
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          firstSeenAt: now,
          validationAttempts: 0,
          createdAt: now,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    .lean<DurableValidatorLinkRecord>()
    .exec();
  if (!record)
    throw new Error("Durable validator link upsert returned no record.");
  return record;
}

export async function mirrorDurableValidatorLinkState(input: {
  normalizedUrl: string;
  originalUrl: string;
  workspaceId: string;
  ownerUserId: string;
  sourceSessionId?: string;
  state: DurableValidatorState;
  error?: string;
}): Promise<DurableValidatorLinkRecord> {
  await upsertDurableValidatorLink(input);
  await connectMongo();
  const updated = await validatorLinkModel()
    .findOneAndUpdate(
      {
        scopeId: VALIDATOR_GLOBAL_SCOPE,
        normalizedUrl: input.normalizedUrl,
      },
      {
        $set: {
          state: input.state,
          updatedAt: Date.now(),
          ...(input.error ? { lastError: input.error.slice(0, 500) } : {}),
        },
        ...(input.state === "MAIN" ||
        input.state === "ACTIVE" ||
        input.state === "DEAD" ||
        input.state === "ERROR"
          ? {
              $unset: {
                validatorJobId: 1,
                workerId: 1,
                sessionId: 1,
                lockOwner: 1,
                lockExpiresAt: 1,
              },
            }
          : {}),
      },
      { new: true },
    )
    .lean<DurableValidatorLinkRecord>()
    .exec();
  if (!updated)
    throw new Error("Durable validator state mirror returned no record.");
  return updated;
}

export async function claimDurableValidatorLink(input: {
  normalizedUrl: string;
  scopeId?: string;
  jobId: string;
  workerId: string;
  sessionId: string;
  leaseMs?: number;
}): Promise<DurableValidatorLinkRecord | undefined> {
  await connectMongo();
  const now = Date.now();
  const leaseMs = Math.max(
    15_000,
    Math.min(input.leaseMs ?? 120_000, 15 * 60_000),
  );
  const record = await validatorLinkModel()
    .findOneAndUpdate(
      {
        scopeId: input.scopeId ?? VALIDATOR_GLOBAL_SCOPE,
        normalizedUrl: input.normalizedUrl,
        state: "MAIN",
        $or: [
          { lockExpiresAt: { $exists: false } },
          { lockExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          state: "PROCESSING",
          validatorJobId: input.jobId,
          workerId: input.workerId,
          sessionId: input.sessionId,
          lockOwner: `${input.workerId}:${input.jobId}`,
          lockExpiresAt: now + leaseMs,
          updatedAt: now,
        },
        $inc: { validationAttempts: 1 },
      },
      { new: true },
    )
    .lean<DurableValidatorLinkRecord>()
    .exec();
  return record ?? undefined;
}

export async function completeDurableValidatorLink(input: {
  normalizedUrl: string;
  scopeId?: string;
  jobId: string;
  workerId: string;
  state: Exclude<DurableValidatorState, "MAIN" | "PROCESSING">;
  error?: string;
  errorClass?: DurableValidatorErrorClass;
}): Promise<DurableValidatorLinkRecord | undefined> {
  await connectMongo();
  const now = Date.now();
  const record = await validatorLinkModel()
    .findOneAndUpdate(
      {
        scopeId: input.scopeId ?? VALIDATOR_GLOBAL_SCOPE,
        normalizedUrl: input.normalizedUrl,
        state: "PROCESSING",
        validatorJobId: input.jobId,
        workerId: input.workerId,
      },
      {
        $set: {
          state: input.state,
          updatedAt: now,
          ...(input.state === "ACTIVE" ? { validatedAt: now } : {}),
          ...(input.error ? { lastError: input.error.slice(0, 500) } : {}),
          ...(input.errorClass ? { lastErrorClass: input.errorClass } : {}),
        },
        $unset: {
          validatorJobId: 1,
          workerId: 1,
          sessionId: 1,
          lockOwner: 1,
          lockExpiresAt: 1,
        },
      },
      { new: true },
    )
    .lean<DurableValidatorLinkRecord>()
    .exec();
  return record ?? undefined;
}

export async function recoverExpiredDurableValidatorLinks(
  scopeId = VALIDATOR_GLOBAL_SCOPE,
  limit = 500,
): Promise<number> {
  await connectMongo();
  const boundedLimit = Math.max(1, Math.min(limit, 2_000));
  const stale = await validatorLinkModel()
    .find({ scopeId, state: "PROCESSING", lockExpiresAt: { $lte: Date.now() } })
    .sort({ lockExpiresAt: 1 })
    .limit(boundedLimit)
    .select({ _id: 1 })
    .lean<{ _id: mongoose.Types.ObjectId }[]>()
    .exec();
  if (!stale.length) return 0;
  const result = await validatorLinkModel().updateMany(
    { _id: { $in: stale.map((item) => item._id) }, state: "PROCESSING" },
    {
      $set: {
        state: "MAIN",
        lastError: "Processing lease expired; returned to Main for retry.",
        updatedAt: Date.now(),
      },
      $unset: {
        validatorJobId: 1,
        workerId: 1,
        sessionId: 1,
        lockOwner: 1,
        lockExpiresAt: 1,
      },
    },
  );
  return result.modifiedCount;
}

export async function countDurableValidatorState(
  scopeId: string,
  state: DurableValidatorState,
): Promise<number> {
  await connectMongo();
  return validatorLinkModel().countDocuments({ scopeId, state }).exec();
}
