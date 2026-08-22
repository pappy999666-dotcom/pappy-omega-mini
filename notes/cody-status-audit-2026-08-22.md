# CODY / Baileys status audit findings

Sources:
- https://github.com/crysnovax/CODY/blob/main/src/Commands/Owner/poststory.js
- Local CODY clone: /home/ubuntu/CODY/src/Commands/Owner/poststory.js
- Installed Baileys fork: @crysnovax/baileys 2.7.10 in local node_modules; worker manifest targets 2.7.12.

CODY's `poststory` command explicitly builds `statusJidList` from `store.contacts` or `sock.store.contacts`, resolves LIDs through `sock.signalRepository.lidMapping.getPNForLID`, adds the account's own JID, and sends `{ status: true, text/media, statusJidList }` through `sock.sendStatus(content)`. It supports text and quoted image/video/audio media; audio includes mimetype and ptt.

The installed Baileys `sendStatus` implementation calls `resolveStatusRecipients(options.statusJidList || content.statusJidList)`. It falls back to config status recipients, `config.getStatusJidList`, or configured contacts. If no valid recipients exist, it throws `sendStatus requires a non-empty statusJidList or a configured contact source/provider`. The relay target is `status@broadcast` and the relay uses the recipient list to distribute the status.

This bot's previous all-status panel-worker path (`tools/worker-runtime-source.mjs`, `sendLocalBroadcast`) sent URL text using raw `runtime.socket.sendMessage(jid, { ...materialized, groupStatus: true })` and did not call the canonical `prepareCanonicalPreviewContent` pipeline. The control-plane `sendGroupStatus` path does call the canonical pipeline. This explains why all-status can work while losing native link previews on panel-local delivery.

The bot's previous personal-status path called `sendStatus` but did not explicitly pass a status audience. A subsequent fix added contact-store setup and explicit audience resolution. The current live test before this audit showed `status@broadcast` with a recipient list containing only the owner's own normalized JID. The user's screenshots show a bare text pill for `chat.whatsapp.com/...` without a thumbnail, indicating the status payload was text-only and no native preview media was attached.
