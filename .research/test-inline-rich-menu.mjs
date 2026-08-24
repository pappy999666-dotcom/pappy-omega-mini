import { buildRichMenuContent } from "/home/ubuntu/pappy-omega-final-dist/src/menus/rich-menu-runtime.js";
import { prepareRichMenuMessage } from "../node_modules/@crysnovax/baileys/lib/Utils/rich-message-utils.js";
const model = { actions: [{ command: "menu" }], statusLine: "ACTIVE" };
const content = buildRichMenuContent(model, "root", {
  url: "https://example.invalid/menu.jpg",
  mime_type: "image/jpeg",
  width: 1080,
  height: 620,
  inline: false,
});
const prepared = prepareRichMenuMessage(content);
function findBuffer(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Buffer.isBuffer(value)) return value;
  for (const child of Object.values(value)) {
    const found = findBuffer(child, seen);
    if (found) return found;
  }
  return undefined;
}
const encoded = findBuffer(prepared);
if (!encoded) throw new Error("unified RichMenu response buffer missing");
const serialized = encoded.toString("utf8");
if (!serialized.includes("https://example.invalid/menu.jpg")) throw new Error("image URL missing from encoded RichMenu");
if (!serialized.includes("GenAIImagePrimitive")) throw new Error("standard image primitive missing");
if (!serialized.includes("preview_image") || !serialized.includes("full_image")) throw new Error("image preview/full fields missing");
console.log(JSON.stringify({ok: true, encodedBytes: encoded.length, hasImageUrl: serialized.includes("https://example.invalid/menu.jpg"), hasImagePrimitive: serialized.includes("GenAIImagePrimitive")}));
