import {
  deleteStickerCommandBinding,
  loadStickerCommandBindings,
  persistStickerCommandBinding,
  type StickerCommandBindingRecord,
} from "../persistence/sticker-bindings.js";

export interface StickerCommandBinding {
  fingerprint: string;
  command: string;
  payload: string;
  createdAt: number;
}

const MAX_PAYLOAD_LENGTH = 800;
const bindings = new Map<string, StickerCommandBinding>();

const COMMAND_ALIASES: Record<string, string> = {
  stag: "tag",
  gstatusd: "dgstatus",
  dgstatsus: "dgstatus",
};

/** Commands that are safe to invoke from an explicitly owner/sudo-bound sticker. */
const BINDABLE_COMMANDS = new Set([
  "tag",
  "gstatus",
  "dgstatus",
  "gstatusx",
  "pstatus",
  "ping",
  "profile",
  "health",
  "help",
  "menu",
  "pfp",
]);

function scopeKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function canonicalStickerCommand(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(normalized)) return undefined;
  const canonical = COMMAND_ALIASES[normalized] ?? normalized;
  return BINDABLE_COMMANDS.has(canonical) ? canonical : undefined;
}

export function stickerBindingCommandList(): string[] {
  return [...BINDABLE_COMMANDS].sort();
}

export async function hydrateStickerCommandBindings(): Promise<void> {
  try {
    const records = await loadStickerCommandBindings();
    for (const record of records) bindings.set(scopeKey(record.workspaceId, record.sessionId), {
      fingerprint: record.fingerprint,
      command: record.command,
      payload: record.payload,
      createdAt: record.createdAt,
    });
  } catch (error) {
    console.warn("[sticker-bindings] durable hydration deferred", error instanceof Error ? error.message : String(error));
  }
}

export function getStickerCommandBinding(
  workspaceId: string,
  sessionId: string,
): StickerCommandBinding | undefined {
  return bindings.get(scopeKey(workspaceId, sessionId));
}

export function setStickerCommandBinding(input: {
  workspaceId: string;
  sessionId: string;
  fingerprint: string;
  command: string;
  payload?: string;
}): StickerCommandBinding {
  const command = canonicalStickerCommand(input.command);
  if (!command) throw new Error("This command cannot be bound to a sticker. Use a safe command such as tag, gstatus, ping, profile, health, help, menu, or pfp.");
  const fingerprint = input.fingerprint.trim();
  if (!fingerprint || fingerprint.length > 200) throw new Error("The quoted sticker identity could not be verified.");
  const payload = (input.payload ?? "").trim().slice(0, MAX_PAYLOAD_LENGTH);
  const binding: StickerCommandBinding = {
    fingerprint,
    command,
    payload,
    createdAt: Date.now(),
  };
  bindings.set(scopeKey(input.workspaceId, input.sessionId), binding);
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    void persistStickerCommandBinding({ ...binding, workspaceId: input.workspaceId, sessionId: input.sessionId }).catch((error) => console.warn("[sticker-bindings] durable write deferred", error instanceof Error ? error.message : String(error)));
  }
  return binding;
}

export function clearStickerCommandBinding(
  workspaceId: string,
  sessionId: string,
): boolean {
  const deleted = bindings.delete(scopeKey(workspaceId, sessionId));
  if (deleted && process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") void deleteStickerCommandBinding(workspaceId, sessionId).catch((error) => console.warn("[sticker-bindings] durable delete deferred", error instanceof Error ? error.message : String(error)));
  return deleted;
}

export function clearAllStickerCommandBindingsForTests(): void {
  bindings.clear();
}

export function stickerBindingMatches(
  binding: StickerCommandBinding | undefined,
  fingerprint: string | undefined,
): boolean {
  return Boolean(binding && fingerprint && binding.fingerprint === fingerprint);
}

export function buildStickerCommandInput(
  binding: StickerCommandBinding,
  quotedText?: string,
  stickerCaption?: string,
): string {
  const dynamicPayload = binding.payload || quotedText?.trim() || stickerCaption?.trim() || "";
  return [binding.command, dynamicPayload].filter(Boolean).join(" ").trim();
}
