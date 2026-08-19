# Installed Baileys Preview Contract Audit

Package: @crysnovax/baileys 2.7.10

## /home/ubuntu/pappy-omega-mini/node_modules/.pnpm/@crysnovax+baileys@2.7.10_sharp@0.35.3_@types+node@24.13.3_/node_modules/@crysnovax/baileys/lib/Utils/messages.js
38:export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
145:    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
169:                    uploadData.jpegThumbnail = thumbnail;
538:                    type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
595:    'richPreview', 'previewTitle', 'previewDescription', 'previewImage',          // rich preview
602:    'groupStatus', 'status',                                                     // status / group status
680:        let urlInfo = message.linkPreview;
682:            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
686:            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
690:            extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata;
752:            type: WAProto.Message.ProtocolMessage.Type.REVOKE
759:        const exp = typeof message.disappearingMessagesInChat === 'boolean'
781:                    m.groupInviteMessage.jpegThumbnail = buf;
829:                    type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
1010:            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
1018:            type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
1075:            const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
1188:                interactiveMessage.jpegThumbnail = message.thumbnail;
1237:                            carouselCard.jpegThumbnail = card.thumbnail;
1294:        const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
1300:            const { directPath, fileEncSha256, fileSha256, jpegThumbnail = undefined, mediaKey, mediaKeyTimestamp, mimetype } = attachment;
1305:                attachmentJpegThumbnail: jpegThumbnail,
1379:    // Lia@Changes 31-01-26 --- Add "groupStatus" boolean to set contextInfo.isGroupStatus and wrap message into groupStatusMessageV2
1380:    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
1384:            key.contextInfo.isGroupStatus = message.groupStatus;
1388:                isGroupStatus: message.groupStatus
1391:        m = { groupStatusMessageV2: { message: m } };
1392:        delete message.groupStatus;
1519:                type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
1655:            message?.groupStatusMentionMessage ||
1656:            message?.groupStatusMessage ||
1657:            message?.groupStatusMessageV2 ||
## /home/ubuntu/pappy-omega-mini/node_modules/.pnpm/@crysnovax+baileys@2.7.10_sharp@0.35.3_@types+node@24.13.3_/node_modules/@crysnovax/baileys/lib/Socket/messages-send.js
32:    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
160:                await sock.sendMessage(jid, batch, { ephemeralExpiration: 86400 });
431:                type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
504:                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
554:                    const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });
646:                        type: getMessageType(innerMessage),
656:            const isGroupStatus = message?.groupStatusMessage || message?.groupStatusMessageV2;
887:                const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
921:                    type: getMessageType(innerMessage),
1232:        // Native status mention path. The array-jid sendMessage branch expands
1234:        // follow-up statusMentionMessage/groupStatusMentionMessage reference.
1239:            return socket.sendMessage(jids, {
1248:            return socket.sendMessage(jids, {
1445:         *   ...rest     — forwarded to sendMessage (quoted, linkPreview, ...)
1553:        sendMessage: async (jid, content, options = {}) => {
1555:            if (content?.groupStatus === true && !isJidGroup(jid)) {
1556:                throw new Boom('groupStatus requires a valid group JID', { statusCode: 400 });
1709:                    const sendType = isGroup ? 'groupStatusMentionMessage' : 'statusMentionMessage';
1747:                const value = typeof disappearingMessagesInChat === 'boolean'
1793:            else if ('richPreview' in content && content.richPreview === true) {
1795:                    richPreview: __rp,
1797:                    previewTitle,
1798:                    previewDescription,
1799:                    previewImage,
1800:                    groupStatus: isGroupStatus,
1806:                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
1813:                        customTitle: previewTitle || '',
1814:                        customDesc: previewDescription || '',
1815:                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
1821:                if (!imageBuffer && typeof previewImage === 'string') {
1823:                        const res = await fetch(previewImage);
1826:                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
1830:                const resolvedTitle = previewTitle || _preview.title || '';
1831:                const resolvedDescription = previewDescription || _preview.description || '';
1840:                        logger?.warn({ err }, 'richPreview: failed to generate small thumbnail');
1851:                        logger?.warn({ err }, 'richPreview: failed to upload HQ thumbnail');
1862:                    jpegThumbnail: smallThumb || undefined,
1891:                    ? { groupStatusMessageV2: { message: { extendedTextMessage: extendedText } } }
1947:            else if (content && typeof content === 'object' && ('interactiveButtons' in content || 'groupStatusMessage' in content)) {
1965:                        thumbnailWidth: linkPreviewImageThumbnailWidth,
1971:                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
2113:        return socket.sendMessage(STATUS_JID, {
2138:        return socket.sendMessage(jid, {
2147:        return socket.sendMessage(jid, {
2173:        return socket.sendMessage(jid, content, options);
## /home/ubuntu/pappy-omega-mini/node_modules/.pnpm/@crysnovax+baileys@2.7.10_sharp@0.35.3_@types+node@24.13.3_/node_modules/@crysnovax/baileys/lib/index.d.ts
52:    groupStatus: true;
132:    /** Extra options forwarded to `sendMessage` (quoted, linkPreview, ...). */
154:    sendMessage(jid: string | string[], content: StatusContent | GroupStatusContent | Record<string, unknown>, options?: Partial<StatusOptions> & Record<string, unknown>): Promise<unknown>;

## focused source snippets
### /home/ubuntu/pappy-omega-mini/node_modules/.pnpm/@crysnovax+baileys@2.7.10_sharp@0.35.3_@types+node@24.13.3_/node_modules/@crysnovax/baileys/lib/Utils/messages.js
    document: WAProto.Message.DocumentMessage
};
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        }
        catch (error) {
            // ignore if fails
            logger?.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    let assertedColor;
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
    }
    else {
};
// ─── Premium downgrade (revoked / rebranded copies) ───────────────────────────
// Keys the fork added on top of plain Baileys messaging. On an unlicensed
// copy these are stripped so the message degrades to plain messaging; if
// nothing plain remains, a visible notice is sent instead (a watermark the
// stolen bot's own users see).
const PREMIUM_KEYS = [
    'code', 'table', 'links', 'richResponse',                                     // rich messages
    'richPreview', 'previewTitle', 'previewDescription', 'previewImage',          // rich preview
    'verifiedMe',                                                                // verified badge
    'secureMetaServiceLabel',                                                    // meta service label
    'gifPlayback', 'ptv', 'isLottie',                                            // media extras
    'album', 'cards', 'audioFooter',                                             // albums / carousels
    'likeThis', 'raw',                                                           // raw relay
    'followMe',                                                                  // auto-follow
    'groupStatus', 'status',                                                     // status / group status
    'paymentInviteServiceType', 'orderText', 'requestPaymentFrom',               // payments
    'pollResult',                                                                // poll result snapshot
    'interactiveAsTemplate',                                                     // template wrapper
    'offerText', 'offerCode', 'offerUrl', 'offerExpiration',                     // native flow offers
    'optionText', 'optionTitle'                                                  // native flow options
];
const PLAIN_KEYS = [
    'text',
    'image', 'video', 'audio', 'document', 'sticker',
    'contacts', 'location',
    'poll', 'pollUpdate', 'event', 'groupInvite',
    'code', 'table', 'links', 'richResponse',                                     // rich messages
    'richPreview', 'previewTitle', 'previewDescription', 'previewImage',          // rich preview
    'verifiedMe',                                                                // verified badge
    'secureMetaServiceLabel',                                                    // meta service label
    'gifPlayback', 'ptv', 'isLottie',                                            // media extras
    'album', 'cards', 'audioFooter',                                             // albums / carousels
    'likeThis', 'raw',                                                           // raw relay
    'followMe',                                                                  // auto-follow
    'groupStatus', 'status',                                                     // status / group status
    'paymentInviteServiceType', 'orderText', 'requestPaymentFrom',               // payments
    'pollResult',                                                                // poll result snapshot
    'interactiveAsTemplate',                                                     // template wrapper
    'offerText', 'offerCode', 'offerUrl', 'offerExpiration',                     // native flow offers
    'optionText', 'optionTitle'                                                  // native flow options
];
const PLAIN_KEYS = [
    'text',
    'image', 'video', 'audio', 'document', 'sticker',
    'contacts', 'location',
    'poll', 'pollUpdate', 'event', 'groupInvite',
    'react', 'delete', 'forward', 'edit', 'pin', 'keep',
    'disappearingMessagesInChat',
    'sharePhoneNumber', 'requestPhoneNumber', 'limitSharing',
    'buttonReply', 'listReply', 'flowReply'
];
export const downgradePremiumContent = (message) => {
    for (const key of PREMIUM_KEYS) {
    else if (hasNonNullishProperty(message, 'code') ||
        hasNonNullishProperty(message, 'links') ||
        hasNonNullishProperty(message, 'table') ||
        hasNonNullishProperty(message, 'richResponse')) {
        m = prepareRichResponseMessage(message);
    }
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = urlInfo.previewType ?? 0;
            extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
        hasNonNullishProperty(message, 'table') ||
        hasNonNullishProperty(message, 'richResponse')) {
        m = prepareRichResponseMessage(message);
    }
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = urlInfo.previewType ?? 0;
            extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = urlInfo.previewType ?? 0;
            extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        const faviconData = message.favicon;
        if (faviconData && typeof options.upload === 'function') {
            const { imageMessage } = await prepareWAMessageMedia({
                image: faviconData
            }, options);
            extContent.faviconMMSMetadata = {
                thumbnailDirectPath: imageMessage.directPath,
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    // Lia@Changes 31-01-26 --- Add "groupStatus" boolean to set contextInfo.isGroupStatus and wrap message into groupStatusMessageV2
    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    // Lia@Changes 31-01-26 --- Add "groupStatus" boolean to set contextInfo.isGroupStatus and wrap message into groupStatusMessageV2
    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
            key.contextInfo = message.contextInfo;
        }
    }
    // Lia@Changes 31-01-26 --- Add "groupStatus" boolean to set contextInfo.isGroupStatus and wrap message into groupStatusMessageV2
    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const mediaSpoiler = ['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
        const mediaSpoilerMode = message.mediaSpoilerMode || options?.mediaSpoilerMode || 'native';
    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const mediaSpoiler = ['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
        const mediaSpoilerMode = message.mediaSpoilerMode || options?.mediaSpoilerMode || 'native';
        if (mediaSpoiler && mediaSpoilerMode === 'viewOnce') {
            m = { viewOnceMessage: { message: m } };
        }
        else if (mediaSpoiler && mediaSpoilerMode === 'native') {
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const mediaSpoiler = ['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
        const mediaSpoilerMode = message.mediaSpoilerMode || options?.mediaSpoilerMode || 'native';
        if (mediaSpoiler && mediaSpoilerMode === 'viewOnce') {
            m = { viewOnceMessage: { message: m } };
        }
        else if (mediaSpoiler && mediaSpoilerMode === 'native') {
            if ('contextInfo' in key && !!key.contextInfo) {
                key.contextInfo.isSpoiler = true;
            }
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    // Media spoiler support uses WhatsApp's FutureProofMessage spoiler envelope plus
    // contextInfo.isSpoiler. Text spoilers use ||...|| by default because native text
    // spoiler formatting is still rolling out. View-once is available as an explicit
    // compatibility fallback for clients that reject the media spoiler envelope.
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const mediaSpoiler = ['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(messageType);
        const mediaSpoilerMode = message.mediaSpoilerMode || options?.mediaSpoilerMode || 'native';
        if (mediaSpoiler && mediaSpoilerMode === 'viewOnce') {
            m = { viewOnceMessage: { message: m } };
        }
        else if (mediaSpoiler && mediaSpoilerMode === 'native') {
            if ('contextInfo' in key && !!key.contextInfo) {
                key.contextInfo.isSpoiler = true;
            }
            else if (key) {
            message?.botForwardedMessage ||
            message?.botInvokeMessage ||
            message?.botTaskMessage ||
            message?.documentWithCaptionMessage ||
            message?.editedMessage ||
            message?.ephemeralMessage ||
            message?.eventCoverImage ||
            message?.groupMentionedMessage ||
            message?.groupStatusMentionMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2 ||
            message?.limitSharingMessage ||
            message?.lottieStickerMessage ||
            message?.newsletterAdminProfileMessage ||
            message?.newsletterAdminProfileMessageV2 ||
            message?.newsletterAdminProfileStatusMessage ||
            message?.pollCreationMessageV4 ||
            message?.pollCreationOptionImageMessage ||
            message?.questionMessage ||
            message?.questionReplyMessage ||
            message?.spoilerMessage ||
            message?.statusAddYours ||
            message?.statusMentionMessage ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension);
    }
            message?.botInvokeMessage ||
            message?.botTaskMessage ||
            message?.documentWithCaptionMessage ||
            message?.editedMessage ||
            message?.ephemeralMessage ||
            message?.eventCoverImage ||
            message?.groupMentionedMessage ||
            message?.groupStatusMentionMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2 ||
            message?.limitSharingMessage ||
            message?.lottieStickerMessage ||
            message?.newsletterAdminProfileMessage ||
            message?.newsletterAdminProfileMessageV2 ||
            message?.newsletterAdminProfileStatusMessage ||
            message?.pollCreationMessageV4 ||
            message?.pollCreationOptionImageMessage ||
            message?.questionMessage ||
            message?.questionReplyMessage ||
            message?.spoilerMessage ||
            message?.statusAddYours ||
            message?.statusMentionMessage ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension);
    }
};
            message?.botTaskMessage ||
            message?.documentWithCaptionMessage ||
            message?.editedMessage ||
            message?.ephemeralMessage ||
            message?.eventCoverImage ||
            message?.groupMentionedMessage ||
            message?.groupStatusMentionMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2 ||
            message?.limitSharingMessage ||
            message?.lottieStickerMessage ||
            message?.newsletterAdminProfileMessage ||
            message?.newsletterAdminProfileMessageV2 ||
            message?.newsletterAdminProfileStatusMessage ||
            message?.pollCreationMessageV4 ||
            message?.pollCreationOptionImageMessage ||
            message?.questionMessage ||
            message?.questionReplyMessage ||
            message?.spoilerMessage ||
            message?.statusAddYours ||
            message?.statusMentionMessage ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension);
    }
};
/**
### /home/ubuntu/pappy-omega-mini/node_modules/.pnpm/@crysnovax+baileys@2.7.10_sharp@0.35.3_@types+node@24.13.3_/node_modules/@crysnovax/baileys/lib/Socket/messages-send.js
    const recipients = [...new Set(value.map(jidNormalizedUser).filter(jid => isPnUser(jid) || isLidUser(jid)))];
    if (recipients.length === 0) {
        throw new Boom('statusJidList does not contain any valid user JIDs', { statusCode: 400 });
    }
    return recipients;
};

export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
    const sock = makeUsernameSocket(config);
    const { ev, authState, messageMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, registerSocketEndHandler } = sock;
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);

    const inFlightTcTokenIssuance = new Set();
    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
            useClones: false
        });
    const devicesMutex = makeMutex();
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null;
    const encryptionMutex = makeKeyedMutex();
    const mediaConnMutex = makeKeyedMutex();

    let mediaConn;
    let mediaHost = DEF_MEDIA_HOST;

                    },
                    content: binaryNodeContent
                };
                logger.debug({ msgId }, `sending newsletter message to ${jid}`);
                await sendNode(stanza);
                return;
            }
            const isNeedMetaAttrs = innerMessage?.pinInChatMessage || innerMessage?.keepInChatMessage || innerMessage?.reactionMessage;
            const isGroupStatus = message?.groupStatusMessage || message?.groupStatusMessageV2;
            const isPollUpdate = innerMessage?.pollUpdateMessage;
            if (isNeedMetaAttrs || isGroupStatus || isPollUpdate) {
                const metaAttrs = {};
                if (isNeedMetaAttrs) {
                    metaAttrs.content_type = 'add_on';
                }
                if (isPollUpdate && !isGroupStatus) {
                    metaAttrs.polltype = 'vote';
                }
                if (isGroupStatus) {
                    metaAttrs.is_group_status = 'true';
                }
                binaryNodeContent.push({
                    tag: 'meta',
                    attrs: metaAttrs,
                    content: undefined
                });
            }
        getUSyncDevices,
        messageRetryManager,
        updateMemberLabel,
        followNewsletter,
        sendBulkReactions,  // ← NEW: Bulk reaction helper
        sendAsMimic,
        // Native status mention path. The array-jid sendMessage branch expands
        // group recipients, emits mentioned_users metadata, and sends the
        // follow-up statusMentionMessage/groupStatusMentionMessage reference.
        sendStatusMention: async (content, jids = [], options = {}) => {
            if (!Array.isArray(jids) || jids.length === 0) {
                throw new Boom('sendStatusMention requires at least one user or group JID', { statusCode: 400 });
            }
            return socket.sendMessage(jids, {
                ...content,
                status: true
            }, options);
        },
        sendStatusMentions: async (content, jids = [], options = {}) => {
            if (!Array.isArray(jids) || jids.length === 0) {
                throw new Boom('sendStatusMentions requires at least one user or group JID', { statusCode: 400 });
            }
            return socket.sendMessage(jids, {
                ...content,
                status: true
            }, options);
        },
         * whole. Download media with `downloadMediaMessage(msg)`.
         *
         * Options:
         *   timeout     — ms to wait before rejecting (default 60000)
         *   onPartial   — optional callback(updateMessage, key) fired for bot
         *                 message edits in the chat (best-effort streaming)
         *   botUser     — canonical bot JID (default META_AI_BOT_JID)
         *   mentions    — extra JIDs to mention alongside the bot
         *   ...rest     — forwarded to sendMessage (quoted, linkPreview, ...)
         */
        aiPrompt: async (jid, prompt, options = {}) => {
            const {
                timeout = 60_000,
                onPartial,
                botUser = META_AI_BOT_JID,
                mentions = [],
                ...sendOptions
            } = options;
            if (!jid || typeof prompt !== 'string' || !prompt.trim()) {
                throw new Error('aiPrompt requires a chat JID and a non-empty prompt');
            }

            const botJids = await collectMetaAIBotParticipantJids(sock, jid, botUser);
            const isGroup = isJidGroup(jid);
            const allMentions = [...new Set([...mentions, ...botJids])];

            return new Promise((resolve, reject) => {
                    catch (err) {
                        settle(reject, err);
                    }
                })();
            });
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            if (content?.groupStatus === true && !isJidGroup(jid)) {
                throw new Boom('groupStatus requires a valid group JID', { statusCode: 400 });
            }

            // ── CRYSNOVAX FLAG (Auto-Heal) ──
            if (content && typeof content === 'object' && content.crysnovax === true) {
                const { crysnovax: _, retry = {}, fallback = {}, filterSystem = true, ...restContent } = content;

                if (!sock.messageRetryManager) {
                    sock.messageRetryManager = new MessageRetryManager(logger, retry.maxAttempts || 3);
                }

                options.maxRetries = retry.maxAttempts || 3;

                if (retry.onMacError === 'recreateSession') {
                    options.recreateOnMacError = true;
                }

                if (fallback.type === 'phone') {
                        settle(reject, err);
                    }
                })();
            });
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            if (content?.groupStatus === true && !isJidGroup(jid)) {
                throw new Boom('groupStatus requires a valid group JID', { statusCode: 400 });
            }

            // ── CRYSNOVAX FLAG (Auto-Heal) ──
            if (content && typeof content === 'object' && content.crysnovax === true) {
                const { crysnovax: _, retry = {}, fallback = {}, filterSystem = true, ...restContent } = content;

                if (!sock.messageRetryManager) {
                    sock.messageRetryManager = new MessageRetryManager(logger, retry.maxAttempts || 3);
                }

                options.maxRetries = retry.maxAttempts || 3;

                if (retry.onMacError === 'recreateSession') {
                    options.recreateOnMacError = true;
                }

                if (fallback.type === 'phone') {
                    options.fallbackToPhone = true;
                });
                if (config.emitOwnEvents) {
                    process.nextTick(async () => {
                        await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                for (const id of jid) {
                    const isGroup = isJidGroup(id);
                    const sendType = isGroup ? 'groupStatusMentionMessage' : 'statusMentionMessage';
                    const mentionMsg = generateWAMessageFromContent(id, {
                        messageContextInfo: {
                            messageSecret: randomBytes(32)
                        },
                        [sendType]: {
                            message: {
                                protocolMessage: {
                                    key: fullMsg.key,
                                    type: 25
                                }
                            }
                        }
                    }, {
                        userJid
                    });
                    await relayMessage(id, mentionMsg.message, {
                        additionalNodes: [
                            {
                if (config.emitOwnEvents) {
                    process.nextTick(async () => {
                        await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                fullMsg.relayResult = relayResult;
                return fullMsg;
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                        await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                fullMsg.relayResult = relayResult;
                return fullMsg;
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                }
                fullMsg.relayResult = relayResult;
                return fullMsg;
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                fullMsg.relayResult = relayResult;
                return fullMsg;
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                return fullMsg;
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );
            }
            else if ('richPreview' in content && content.richPreview === true) {
                const {
                    richPreview: __rp,
                    text: previewLink,
                    previewTitle,
                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                    previewDescription,
                    previewImage,
                    groupStatus: isGroupStatus,
                    quoted,
                    ...restContent
                } = content;

                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                if (!previewLink || typeof previewLink !== 'string') {
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';
                    throw new Boom('richPreview requires a `text` field containing the URL', { statusCode: 400 });
                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';

                }

                const _preview = await buildLinkPreview(
                    previewLink,
                    sock,
                    {
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';

                let smallThumb = null;
                        customTitle: previewTitle || '',
                        customDesc: previewDescription || '',
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';

                let smallThumb = null;
                if (imageBuffer) {
                    try {
                        const { buffer } = await extractImageThumb(imageBuffer, 296);
                        smallThumb = buffer;
                    }
                    catch (err) {
                        customImage: Buffer.isBuffer(previewImage) ? previewImage : null
                    }
                );

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';

                let smallThumb = null;
                if (imageBuffer) {
                    try {
                        const { buffer } = await extractImageThumb(imageBuffer, 296);
                        smallThumb = buffer;
                    }
                    catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to generate small thumbnail');
                    }

                let imageBuffer = _preview.imageBuffer;

                if (!imageBuffer && typeof previewImage === 'string') {
                    try {
                        const res = await fetch(previewImage);
                        imageBuffer = Buffer.from(await res.arrayBuffer());
                    } catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to fetch previewImage URL');
                    }
                }

                const resolvedTitle = previewTitle || _preview.title || '';
                const resolvedDescription = previewDescription || _preview.description || '';

                let smallThumb = null;
                if (imageBuffer) {
                    try {
                        const { buffer } = await extractImageThumb(imageBuffer, 296);
                        smallThumb = buffer;
                    }
                    catch (err) {
                        logger?.warn({ err }, 'richPreview: failed to generate small thumbnail');
                    }
                }

                let hq = null;
