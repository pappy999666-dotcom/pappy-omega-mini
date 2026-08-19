import { writeFile } from "node:fs/promises";
import {
  getPreviewDebugSnapshot,
  prepareCanonicalPreviewContent,
} from "../dist/src/whatsapp/baileys-native-preview.js";

const urls = [
  "https://example.com/",
  "https://t.me/pappygcs",
  "https://whatsapp.com/channel/0029VbCSVL9HLHQgReyVeE39",
  "https://chat.whatsapp.com/KbDjI6Amhs38wh2nRz4pkN",
];

const results = [];
for (const url of urls) {
  const scope = `acceptance-${Date.now()}-${url}`;
  const content = await prepareCanonicalPreviewContent({
    text: url,
    content: { text: url },
    cacheScope: scope,
  });
  const debug = getPreviewDebugSnapshot(scope);
  results.push({
    url,
    contentKeys: Object.keys(content),
    hasRichPreview: content.richPreview === true,
    hasGroupStatus: content.groupStatus === true,
    hasLinkPreview: Boolean(content.linkPreview),
    debug: debug
      ? {
          url: debug.url,
          canonicalUrl: debug.canonicalUrl,
          title: debug.title,
          description: debug.description,
          selectedImageUrl: debug.selectedImageUrl,
          sourceWidth: debug.sourceWidth,
          sourceHeight: debug.sourceHeight,
          sourceBytes: debug.sourceBytes,
          processing: debug.processing,
          crop: debug.crop,
          compression: debug.compression,
          nativeFlag: debug.nativeFlag,
          payload: debug.payload,
          cache: debug.cache,
          result: debug.result,
          reason: debug.reason,
        }
      : undefined,
  });
}

await writeFile(
  "PAPPY_NATIVE_PREVIEW_ACCEPTANCE_20260819.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
