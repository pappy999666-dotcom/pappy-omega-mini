# Preview audit source notes

## Baileys text-message preview documentation
Source: https://whiskeysockets-baileys-94.mintlify.app/messaging/text-messages

The documentation states that Baileys can generate link previews by detecting a URL in message text, fetching page metadata, and generating a preview with title, description, and thumbnail. It also documents manual `linkPreview` data and the text-message payload path.

## Installed @crysnovax/baileys fork
Local source inspected under `node_modules/.pnpm/@crysnovax+baileys@2.7.12*/node_modules/@crysnovax/baileys/lib/Utils/messages.js`.

The fork checks `message.linkPreview`; when absent, it calls `generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)`. The generated values are serialized into the extended text message. The project’s preview resolver must therefore preserve the original URL in `message.text` and attach a correctly shaped `linkPreview` when custom metadata is available.

Audit finding: the project had been skipping live group metadata for assigned panel sockets and then using a generic invitation fallback. The corrected path passes the current group JID into preview resolution and queries live group metadata before falling back.
