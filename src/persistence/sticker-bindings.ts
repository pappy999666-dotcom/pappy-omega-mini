import mongoose, { type Model } from "mongoose";
import { connectMongo } from "./mongo.js";
import type { WorkspaceStickerBinding } from "../types/domain.js";

export interface StickerCommandBindingRecord extends WorkspaceStickerBinding {
  workspaceId: string;
  sessionId: string;
}

interface StickerCommandBindingDocument
  extends StickerCommandBindingRecord,
    mongoose.Document {}

const schema = new mongoose.Schema<StickerCommandBindingDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    fingerprint: { type: String, required: true },
    command: { type: String, required: true },
    payload: { type: String, required: true, default: "" },
    createdAt: { type: Number, required: true },
  },
  { collection: "sticker_command_bindings", versionKey: false },
);
schema.index({ workspaceId: 1, sessionId: 1 }, { unique: true });

let model: Model<StickerCommandBindingDocument> | undefined;
function bindingModel(): Model<StickerCommandBindingDocument> {
  return (model ??= mongoose.models.StickerCommandBinding as Model<StickerCommandBindingDocument> ?? mongoose.model<StickerCommandBindingDocument>("StickerCommandBinding", schema));
}

export async function loadStickerCommandBindings(): Promise<StickerCommandBindingRecord[]> {
  await connectMongo();
  return bindingModel().find().lean<StickerCommandBindingRecord[]>().exec();
}

export async function persistStickerCommandBinding(
  record: StickerCommandBindingRecord,
): Promise<void> {
  await connectMongo();
  await bindingModel().findOneAndUpdate(
    { workspaceId: record.workspaceId, sessionId: record.sessionId },
    { $set: record },
    { upsert: true, setDefaultsOnInsert: true },
  ).exec();
}

export async function deleteStickerCommandBinding(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await connectMongo();
  await bindingModel().deleteOne({ workspaceId, sessionId }).exec();
}

export async function ensureStickerCommandBindingIndexes(): Promise<void> {
  await connectMongo();
  await bindingModel().createIndexes();
}

export function resetStickerBindingPersistenceForTests(): void {
  model = undefined;
}

export type { WorkspaceStickerBinding };
export default bindingModel;

void ensureStickerCommandBindingIndexes;
