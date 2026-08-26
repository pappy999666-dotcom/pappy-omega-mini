import { applyStickerPackMetadata, validateWhatsAppSticker } from "./sticker-exif.js";
import { convertMediaToSticker } from "./sticker-media.js";
import type { WhatsAppMediaPayload } from "./media-payload.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const TELEGRAM_STICKER_PACK_LIMIT = 60;
const CONVERSION_WINDOW = 4;
const REQUEST_TIMEOUT_MS = 20_000;

type TelegramSticker = {
  file_id: string;
  type?: string;
};

type TelegramStickerSet = {
  title?: string;
  name: string;
  is_animated?: boolean;
  is_video?: boolean;
  stickers?: TelegramSticker[];
};

export type TelegramStickerRef = {
  packName: string;
  selection?: number;
};

export function parseTelegramStickerRef(raw: string): TelegramStickerRef | null {
  const value = raw.trim();
  if (!value) return null;
  const link = value.match(
    /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:addsticker|addstickers)\/([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/iu,
  );
  if (link) {
    return {
      packName: link[1]!,
      ...(link[2] ? { selection: Math.max(1, Number(link[2])) } : {}),
    };
  }
  const deep = value.match(/^tg:\/\/addstickers\?set=([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/iu);
  if (deep) {
    return {
      packName: deep[1]!,
      ...(deep[2] ? { selection: Math.max(1, Number(deep[2])) } : {}),
    };
  }
  const bare = value.match(/^([A-Za-z0-9_]{1,64})(?:\s+(\d{1,3}))?$/u);
  if (!bare) return null;
  return {
    packName: bare[1]!,
    ...(bare[2] ? { selection: Math.max(1, Number(bare[2])) } : {}),
  };
}

function telegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("Telegram sticker import is not configured.");
  return token;
}

async function telegramApi<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${telegramToken()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!response.ok || body.ok !== true || body.result === undefined)
      throw new Error(body.description ?? `Telegram API ${method} failed.`);
    return body.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("Telegram sticker request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadTelegramFile(filePath: string, knownSize?: number): Promise<Buffer> {
  if (knownSize !== undefined && knownSize > MAX_DOWNLOAD_BYTES)
    throw new Error("Telegram sticker exceeds the 25 MB safety limit.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${TELEGRAM_API}/file/bot${telegramToken()}/${filePath}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Telegram file download failed (HTTP ${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) throw new Error("Telegram sticker exceeds the 25 MB safety limit.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES)
      throw new Error("Telegram sticker exceeds the 25 MB safety limit.");
    return buffer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("Telegram sticker download timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isVideoSticker(filePath: string, set: TelegramStickerSet, sticker: TelegramSticker): boolean {
  return set.is_video === true || sticker.type === "video" || /\.(?:webm|mp4)$/iu.test(filePath);
}

async function convertTelegramSticker(
  set: TelegramStickerSet,
  sticker: TelegramSticker,
  packName: string,
): Promise<WhatsAppMediaPayload> {
  const file = await telegramApi<{ file_path: string; file_size?: number }>("getFile", { file_id: sticker.file_id });
  if (!file.file_path) throw new Error("Telegram did not return a sticker file path.");
  if (set.is_animated === true || /\.tgs$/iu.test(file.file_path))
    throw new Error("Animated Telegram TGS/Lottie stickers are not supported by the installed converter.");
  const bytes = await downloadTelegramFile(file.file_path, file.file_size);
  const media = await convertMediaToSticker({
    kind: isVideoSticker(file.file_path, set, sticker) ? "video" : "image",
    bytes,
    mimeType: isVideoSticker(file.file_path, set, sticker) ? "video/webm" : "image/webp",
    fileName: file.file_path,
  });
  const tagged = applyStickerPackMetadata(media.bytes, {
    packName,
    publisher: "PAPPY OMEGA MINI",
    emojis: ["✨"],
  });
  validateWhatsAppSticker(tagged, { requireMetadata: true });
  return { ...media, bytes: tagged, stickerPackName: packName };
}

export interface TelegramStickerCommandInput {
  rawInput: string;
  packName: string;
  sendText: (text: string) => Promise<void>;
  sendSticker: (media: WhatsAppMediaPayload) => Promise<void>;
  sendStickerPack?: (input: {
    stickers: Buffer[];
    packName: string;
    publisher: string;
    description: string;
  }) => Promise<boolean>;
}

export async function runTelegramStickerCommand(input: TelegramStickerCommandInput): Promise<string> {
  const reference = parseTelegramStickerRef(input.rawInput);
  if (!reference)
    return "⌬ ⤷ *TG STICKER USAGE* ⚙︎\n\n─────────────\n⎔ Command · ⇆ .tg <Telegram pack link> [number]\n─────────────\n» *Example:* .tg https://t.me/addstickers/PackName\n» *Note:* No number downloads the full pack; adding a number downloads one sticker.";

  const set = await telegramApi<TelegramStickerSet>("getStickerSet", { name: reference.packName });
  const stickers = set.stickers ?? [];
  if (!stickers.length) throw new Error("Telegram returned an empty or unavailable sticker pack.");
  if (set.is_animated === true)
    throw new Error("Animated Telegram TGS/Lottie packs are not supported by the installed converter.");

  if (reference.selection !== undefined) {
    const index = reference.selection - 1;
    const sticker = stickers[index];
    if (!sticker) throw new Error(`Sticker #${reference.selection} was not found; this pack has ${stickers.length} stickers.`);
    await input.sendText(`✦ PAPPY OMEGA MINI · TG STICKER\n─────────────────────\nPack        · ${set.title ?? reference.packName}\nSticker     · #${reference.selection}\nStatus      · Downloading and converting…`);
    await input.sendSticker(await convertTelegramSticker(set, sticker, input.packName));
    return `✦ PAPPY OMEGA MINI · TG STICKER\n─────────────────────\nSticker     · #${reference.selection}\nPack        · ${input.packName}\nStatus      · Downloaded and sent.`;
  }

  await input.sendText(`✦ PAPPY OMEGA MINI · TG STICKER\n─────────────────────\nPack        · ${set.title ?? reference.packName}\nTotal       · ${stickers.length}\nStatus      · Downloading and converting…`);
  let converted = 0;
  const failed: number[] = [];
  let pending: Buffer[] = [];
  let packIndex = 0;
  const totalPacks = Math.max(1, Math.ceil(stickers.length / TELEGRAM_STICKER_PACK_LIMIT));
  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    packIndex += 1;
    const packLabel = totalPacks > 1 ? `${input.packName} ${packIndex}/${totalPacks}` : input.packName;
    const sentAsPack = batch.length >= 2 && batch.length <= TELEGRAM_STICKER_PACK_LIMIT && input.sendStickerPack
      ? await input.sendStickerPack({ stickers: batch, packName: packLabel, publisher: "PAPPY OMEGA MINI", description: "Imported from Telegram by PAPPY OMEGA MINI" })
      : false;
    if (sentAsPack) {
      converted += batch.length;
      return;
    }
    for (const bytes of batch) {
      await input.sendSticker({ kind: "sticker", bytes, mimeType: "image/webp", fileName: "pappy-telegram-sticker.webp", stickerPackName: packLabel });
      converted += 1;
    }
  };

  for (let start = 0; start < stickers.length; start += CONVERSION_WINDOW) {
    const window = stickers.slice(start, start + CONVERSION_WINDOW);
    const results = await Promise.all(window.map(async (sticker, offset) => {
      const index = start + offset;
      try {
        return await convertTelegramSticker(set, sticker, input.packName);
      } catch {
        failed.push(index + 1);
        return undefined;
      }
    }));
    for (const media of results) {
      if (!media) continue;
      pending.push(media.bytes);
      if (pending.length >= TELEGRAM_STICKER_PACK_LIMIT) await flush();
    }
  }
  await flush();
  return `✦ PAPPY OMEGA MINI · TG STICKER\n─────────────────────\nPack        · ${set.title ?? reference.packName}\nSent        · ${converted} / ${stickers.length}\nPacks       · ${packIndex}\nStatus      · ${failed.length ? `Completed with ${failed.length} failed sticker(s).` : "All stickers downloaded and sent."}`;
}
