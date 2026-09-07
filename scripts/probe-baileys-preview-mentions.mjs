import {
  generateWAMessageContent,
} from "plogme";

const cases = [
  {
    name: "rich-preview",
    content: {
      richPreview: true,
      text: "https://example.com/article",
      previewTitle: "Example",
      previewDescription: "Description",
      mentions: ["2347000000000@s.whatsapp.net"],
    },
  },
  {
    name: "normal-link-preview",
    content: {
      text: "https://example.com/article",
      mentions: ["2347000000000@s.whatsapp.net"],
      linkPreview: {
        "matched-text": "https://example.com/article",
        title: "Example",
        description: "Description",
        previewType: 5,
      },
    },
  },
];

for (const item of cases) {
  const result = await generateWAMessageContent(item.content, {
    logger: undefined,
  });
  console.log(item.name, JSON.stringify(result));
}
