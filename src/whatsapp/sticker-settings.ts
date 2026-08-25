const DEFAULT_STICKER_PACK_NAME = "PAPPY OMEGA MINI";
const MAX_PACK_NAME_LENGTH = 64;
const packNames = new Map<string, string>();

function scopeKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function getStickerPackName(workspaceId: string, sessionId: string): string {
  return packNames.get(scopeKey(workspaceId, sessionId)) ?? DEFAULT_STICKER_PACK_NAME;
}

export function setStickerPackName(
  workspaceId: string,
  sessionId: string,
  value: string,
): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_PACK_NAME_LENGTH);
  if (!normalized) throw new Error("Sticker pack name cannot be empty.");
  packNames.set(scopeKey(workspaceId, sessionId), normalized);
  return normalized;
}

export function clearStickerPackNameForTests(): void {
  packNames.clear();
}
