import { generateWAMessage } from "../node_modules/@crysnovax/baileys/lib/index.js";
const url = "https://chat.whatsapp.com/EXAMPLE";
const message = await generateWAMessage(
  "12025550123-123@g.us",
  { text: `Haven festival\nGroup chat invite\n${url}`, linkPreview: {} },
  { getUrlInfo: async () => { throw new Error("preview fetch should not run"); } },
);
const serialized = JSON.stringify(message.message ?? {});
if (serialized.includes("jpegThumbnail") || serialized.includes("linkPreviewMetadata") || serialized.includes("thumbnailDirectPath")) {
  throw new Error("blank-prone link preview fields were serialized");
}
if (!serialized.includes("chat.whatsapp.com/EXAMPLE")) throw new Error("original allchat link missing");
console.log(JSON.stringify({ ok: true, hasText: serialized.includes("Haven festival"), hasLink: serialized.includes("chat.whatsapp.com/EXAMPLE"), bytes: serialized.length }));
