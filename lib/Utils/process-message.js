import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { WAMessageStubType } from '../Types/index.js';
import { getContentType, normalizeMessageContent } from '../Utils/messages.js';
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidStatusBroadcast, isLidUser, jidDecode, jidEncode, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, hmacSign } from './crypto.js';
import { getKeyAuthor, toNumber } from './generics.js';
import { downloadAndProcessHistorySyncNotification } from './history.js';
import { storeNctSalt } from './tc-token-utils.js';
const REAL_MSG_STUB_TYPES = new Set([
    WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
    WAMessageStubType.CALL_MISSED_GROUP_VOICE,
    WAMessageStubType.CALL_MISSED_VIDEO,
    WAMessageStubType.CALL_MISSED_VOICE
]);
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD]);
const historySyncDiagnosticsEnabled = () => process.env.BAILEYS_HISTORY_SYNC_DIAGNOSTICS === 'true';
/** Cleans a received message to further processing */
export const cleanMessage = (message, meId, meLid) => {
    // ensure remoteJid and participant doesn't have device or agent in it
    if (isHostedPnUser(message.key.remoteJid) || isHostedLidUser(message.key.remoteJid)) {
        message.key.remoteJid = jidEncode(jidDecode(message.key?.remoteJid)?.user, isHostedPnUser(message.key.remoteJid) ? 's.whatsapp.net' : 'lid');
    }
    else {
        message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
    }
    if (isHostedPnUser(message.key.participant) || isHostedLidUser(message.key.participant)) {
        message.key.participant = jidEncode(jidDecode(message.key.participant)?.user, isHostedPnUser(message.key.participant) ? 's.whatsapp.net' : 'lid');
    }
    else {
        message.key.participant = jidNormalizedUser(message.key.participant);
    }
    const content = normalizeMessageContent(message.message);
    // if the message has a reaction, ensure fromMe & remoteJid are from our perspective
    if (content?.reactionMessage) {
        normaliseKey(content.reactionMessage.key);
    }
    if (content?.pollUpdateMessage) {
        normaliseKey(content.pollUpdateMessage.pollCreationMessageKey);
    }
    function normaliseKey(msgKey) {
        // if the reaction is from another user
        // we've to correctly map the key to this user's perspective
        if (!message.key.fromMe) {
            // if the sender believed the message being reacted to is not from them
            // we've to correct the key to be from them, or some other participant
            msgKey.fromMe = !msgKey.fromMe
                ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) ||
                    areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid)
                : // if the message being reacted to, was from them
                    // fromMe automatically becomes false
                    false;
            // set the remoteJid to being the same as the chat the message came from
            // TODO: investigate inconsistencies
            msgKey.remoteJid = message.key.remoteJid;
            // set participant of the message
            msgKey.participant = msgKey.participant || message.key.participant;
        }
    }
};
// TODO: target:audit AUDIT THIS FUNCTION AGAIN
export const isRealMessage = (message) => {
    const normalizedContent = normalizeMessageContent(message.message);
    const hasSomeContent = !!getContentType(normalizedContent);
    return ((!!normalizedContent ||
        REAL_MSG_STUB_TYPES.has(message.messageStubType) ||
        REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) &&
        hasSomeContent &&
        !normalizedContent?.protocolMessage &&
        !normalizedContent?.reactionMessage &&
        !normalizedContent?.pollUpdateMessage);
};
export const shouldIncrementChatUnread = (message) => !message.key.fromMe && !message.messageStubType;
/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
export const getChatId = ({ remoteJid, participant, fromMe }) => {
    if (!remoteJid) {
        throw new Boom('Cannot derive chat id: message key is missing remoteJid', {
            data: { remoteJid, participant, fromMe }
        });
    }
    if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
        if (!participant) {
            throw new Boom('Cannot derive chat id: broadcast message key is missing participant', {
                data: { remoteJid, fromMe }
            });
        }
        return participant;
    }
    return remoteJid;
};
/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
export function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
    const sign = Buffer.concat([
        toBinary(pollMsgId),
        toBinary(pollCreatorJid),
        toBinary(voterJid),
        toBinary('Poll Vote'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${pollMsgId}\u0000${voterJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    return proto.Message.PollVoteMessage.decode(decrypted);
    function toBinary(txt) {
        return Buffer.from(txt);
    }
}
/**
 * Decrypt a poll vote with automatic LID/PN JID fallback handling.
 *
 * WhatsApp can mix Phone Number (PN) and Local Identifier (LID) JIDs in the
 * same poll flow. This utility tries creator/voter JID combinations until one
 * matches the encryption context.
 */
export function decryptPollVoteWithLidFallback(encryptedVote, opts) {
    const { pollEncKey, pollCreationMsgKey, voteMsgKey, meId, meLid } = opts;
    const meIdNormalised = jidNormalizedUser(meId);
    const meLidNormalised = meLid ? jidNormalizedUser(meLid) : undefined;
    const creatorPnJid = getKeyAuthor(pollCreationMsgKey, meIdNormalised);
    const creatorLidJid = pollCreationMsgKey.fromMe && meLidNormalised
        ? meLidNormalised
        : pollCreationMsgKey.participant && isLidUser(pollCreationMsgKey.participant)
            ? jidNormalizedUser(pollCreationMsgKey.participant)
            : pollCreationMsgKey.participantAlt && isLidUser(pollCreationMsgKey.participantAlt)
                ? jidNormalizedUser(pollCreationMsgKey.participantAlt)
                : undefined;
    const creatorCandidates = [creatorPnJid];
    if (creatorLidJid && creatorLidJid !== creatorPnJid) {
        creatorCandidates.push(creatorLidJid);
    }
    const voterPnJid = getKeyAuthor(voteMsgKey, meIdNormalised);
    const voterLidJid = voteMsgKey.fromMe && meLidNormalised
        ? meLidNormalised
        : voteMsgKey.participant && isLidUser(voteMsgKey.participant)
            ? jidNormalizedUser(voteMsgKey.participant)
            : voteMsgKey.participantAlt && isLidUser(voteMsgKey.participantAlt)
                ? jidNormalizedUser(voteMsgKey.participantAlt)
                : undefined;
    const voterCandidates = [voterPnJid];
    if (voterLidJid && voterLidJid !== voterPnJid) {
        voterCandidates.push(voterLidJid);
    }
    for (const pollCreatorJid of creatorCandidates) {
        for (const voterJid of voterCandidates) {
            try {
                return decryptPollVote(encryptedVote, {
                    pollEncKey,
                    pollCreatorJid,
                    pollMsgId: pollCreationMsgKey.id,
                    voterJid
                });
            }
            catch {
                // Try the next PN/LID combination.
            }
        }
    }
    return undefined;
}
/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
export function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const sign = Buffer.concat([
        toBinary(eventMsgId),
        toBinary(eventCreatorJid),
        toBinary(responderJid),
        toBinary('Event Response'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(eventEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${eventMsgId}\u0000${responderJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    return proto.Message.EventResponseMessage.decode(decrypted);
    function toBinary(txt) {
        return Buffer.from(txt);
    }
}
const processMessage = async (message, { shouldProcessHistoryMsg, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }) => {
    const meId = creds.me.id;
    const { accountSettings } = creds;
    const chat = { id: jidNormalizedUser(getChatId(message.key)) };
    const isRealMsg = isRealMessage(message);
    if (isRealMsg) {
        chat.messages = [{ message }];
        chat.conversationTimestamp = toNumber(message.messageTimestamp);
        // only increment unread count if not CIPHERTEXT and from another person
        if (shouldIncrementChatUnread(message)) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
    }
    const content = normalizeMessageContent(message.message);
    // unarchive chat if it's a real message, or someone reacted to our message
    // and we've the unarchive chats setting on
    if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
        chat.archived = false;
        chat.readOnly = false;
    }
    const protocolMsg = content?.protocolMessage;
    if (protocolMsg) {
        const protocolTypeName = typeof protocolMsg.type === 'number'
            ? proto.Message.ProtocolMessage.Type[protocolMsg.type] || `${protocolMsg.type}`
            : `${protocolMsg.type || 'unknown'}`;
        if (historySyncDiagnosticsEnabled() && protocolMsg.type === proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION) {
            const histNotification = protocolMsg.historySyncNotification;
            logger?.info({
                msgId: message.key.id,
                fromMe: message.key.fromMe,
                remoteJid: message.key.remoteJid,
                participant: message.key.participant,
                protocolType: protocolMsg.type,
                protocolTypeName,
                hasHistorySyncNotification: !!histNotification,
                syncType: histNotification?.syncType,
                syncTypeName: typeof histNotification?.syncType === 'number'
                    ? proto.HistorySync.HistorySyncType[histNotification.syncType] || `${histNotification.syncType}`
                    : `${histNotification?.syncType || 'unknown'}`,
                chunkOrder: histNotification?.chunkOrder,
                progress: histNotification?.progress,
                inlinePayloadBytes: histNotification?.initialHistBootstrapInlinePayload?.length || 0,
                mediaKeyBytes: histNotification?.mediaKey?.length || 0,
                fileSha256Bytes: histNotification?.fileSha256?.length || 0,
                fileEncSha256Bytes: histNotification?.fileEncSha256?.length || 0,
                directPathLength: histNotification?.directPath?.length || 0,
                fileLength: histNotification?.fileLength ? String(toNumber(histNotification.fileLength)) : undefined,
                shouldProcessHistoryMsg,
                processedHistoryMessages: creds.processedHistoryMessages?.length || 0
            }, 'received history sync protocolMessage');
        }
        // Mirror whatsmeow's `handleProtocolMessage` guard, but applied only to
        // the protocol message types that originate from our own device — an
        // attacker could otherwise spoof any of these to manipulate local state.
        //
        // Self-only types (drop if `!fromMe`):
        //   - HISTORY_SYNC_NOTIFICATION                 (our phone driving history sync)
        //   - APP_STATE_SYNC_KEY_SHARE                  (key share between our devices)
        //   - LID_MIGRATION_MAPPING_SYNC                (server-initiated via our phone)
        //   - PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE (response from our phone to our PDO request)
        //
        // Cross-user types (must NOT be dropped — legitimately arrive from others):
        //   - REVOKE
        //   - MESSAGE_EDIT
        //   - EPHEMERAL_SETTING
        //   - GROUP_MEMBER_LABEL_CHANGE
        //
        // See https://github.com/tulir/whatsmeow/blob/8d3700152a/message.go#L842-L845
        // for the reference architecture — whatsmeow's `handleProtocolMessage`
        // only contains self-only types because edits are unwrapped from
        // `EditedMessage` BEFORE this dispatch and revokes aren't routed here.
        const SELF_ONLY_TYPES = new Set([
            proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
            proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
            proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
            proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
        ]);
        if (protocolMsg.type !== null &&
            protocolMsg.type !== undefined &&
            SELF_ONLY_TYPES.has(protocolMsg.type) &&
            !message.key.fromMe) {
            logger?.warn({ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid }, 'dropping spoofed self-only protocolMessage from non-self origin');
            return;
        }
        switch (protocolMsg.type) {
            case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
                const histNotification = protocolMsg.historySyncNotification;
                const process = shouldProcessHistoryMsg;
                const isLatest = !creds.processedHistoryMessages?.length;
                if (historySyncDiagnosticsEnabled()) {
                    logger?.info({
                        process,
                        id: message.key.id,
                        isLatest,
                        syncType: histNotification?.syncType,
                        progress: histNotification?.progress,
                        inlinePayloadBytes: histNotification?.initialHistBootstrapInlinePayload?.length || 0,
                        mediaKeyBytes: histNotification?.mediaKey?.length || 0,
                        directPathLength: histNotification?.directPath?.length || 0
                    }, 'got history notification');
                }
                if (process) {
                    // TODO: investigate
                    if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
                        ev.emit('creds.update', {
                            processedHistoryMessages: [
                                ...(creds.processedHistoryMessages || []),
                                { key: message.key, messageTimestamp: message.messageTimestamp }
                            ]
                        });
                    }
                    const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger);
                    if (historySyncDiagnosticsEnabled()) {
                        logger?.info({
                            syncType: data.syncType,
                            syncTypeName: typeof data.syncType === 'number'
                                ? proto.HistorySync.HistorySyncType[data.syncType] || `${data.syncType}`
                                : `${data.syncType || 'unknown'}`,
                            progress: data.progress,
                            tcTokens: data.tcTokens?.length || 0,
                            nctSaltBytes: data.nctSalt?.length || 0,
                            lidPnMappings: data.lidPnMappings?.length || 0
                        }, 'processed history sync privacy payloads');
                    }
                    if (data.lidPnMappings?.length) {
                        logger?.debug({ count: data.lidPnMappings.length }, 'processing LID-PN mappings from history sync');
                        await signalRepository.lidMapping
                            .storeLIDPNMappings(data.lidPnMappings)
                            .catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'));
                    }
                    if (data.tcTokens?.length) {
                        logger?.debug({ count: data.tcTokens.length }, 'processing tctokens from history sync');
                        try {
                            await keyStore.set({
                                tctoken: Object.fromEntries(await Promise.all(data.tcTokens.map(async (token) => {
                                    const jid = await signalRepository.lidMapping.getLIDForPN(token.jid).catch(() => null);
                                    return [
                                        jid || token.jid,
                                        {
                                            token: token.token || Buffer.alloc(0),
                                            timestamp: token.timestamp,
                                            senderTimestamp: token.senderTimestamp
                                        }
                                    ];
                                })))
                            });
                        }
                        catch (err) {
                            logger?.warn({ err }, 'failed to store tctokens from history sync');
                        }
                    }
                    if (data.nctSalt?.length) {
                        try {
                            await storeNctSalt(keyStore, data.nctSalt);
                            if (historySyncDiagnosticsEnabled()) {
                                logger?.info({ saltBytes: data.nctSalt.length }, 'stored nct salt from history sync');
                            }
                        }
                        catch (err) {
                            logger?.warn({ err }, 'failed to store nct salt from history sync');
                        }
                    }
                    else {
                        if (historySyncDiagnosticsEnabled()) {
                            logger?.debug({ syncType: data.syncType, progress: data.progress }, 'history sync without nct salt');
                        }
                    }
                    ev.emit('messaging-history.set', {
                        ...data,
                        isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
                        chunkOrder: histNotification.chunkOrder,
                        peerDataRequestSessionId: histNotification.peerDataRequestSessionId
                    });
                }
                else {
                    if (historySyncDiagnosticsEnabled()) {
                        logger?.warn({
                            id: message.key.id,
                            syncType: histNotification.syncType,
                            syncTypeName: typeof histNotification.syncType === 'number'
                                ? proto.HistorySync.HistorySyncType[histNotification.syncType] || `${histNotification.syncType}`
                                : `${histNotification.syncType || 'unknown'}`,
                            chunkOrder: histNotification.chunkOrder,
                            progress: histNotification.progress
                        }, 'skipped history sync notification before privacy payload processing');
                    }
                }
                break;
            case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
                const keys = protocolMsg.appStateSyncKeyShare.keys;
                if (keys?.length) {
                    let newAppStateSyncKeyId = '';
                    await keyStore.transaction(async () => {
                        const newKeys = [];
                        for (const { keyData, keyId } of keys) {
                            const strKeyId = Buffer.from(keyId.keyId).toString('base64');
                            newKeys.push(strKeyId);
                            await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
                            newAppStateSyncKeyId = strKeyId;
                        }
                        logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys');
                    }, meId);
                    ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId });
                }
                else {
                    logger?.info({ protocolMsg }, 'recv app state sync with 0 keys');
                }
                break;
            case proto.Message.ProtocolMessage.Type.REVOKE:
                ev.emit('messages.update', [
                    {
                        key: {
                            ...message.key,
                            id: protocolMsg.key.id
                        },
                        update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key }
                    }
                ]);
                break;
            case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
                Object.assign(chat, {
                    ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
                    ephemeralExpiration: protocolMsg.ephemeralExpiration || null
                });
                break;
            case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
                const response = protocolMsg.peerDataOperationRequestResponseMessage;
                if (response) {
                    // TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
                    const peerDataOperationResult = response.peerDataOperationResult || [];
                    for (const result of peerDataOperationResult) {
                        const retryResponse = result?.placeholderMessageResendResponse;
                        //eslint-disable-next-line max-depth
                        if (!retryResponse?.webMessageInfoBytes) {
                            continue;
                        }
                        //eslint-disable-next-line max-depth
                        try {
                            const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes);
                            const msgId = webMessageInfo.key?.id;
                            // Retrieve cached original message data (preserves LID details,
                            // timestamps, etc. that the phone may omit in its PDO response)
                            const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined;
                            //eslint-disable-next-line max-depth
                            if (msgId) {
                                await placeholderResendCache?.del(msgId);
                            }
                            let finalMsg;
                            //eslint-disable-next-line max-depth
                            if (cachedData && typeof cachedData === 'object') {
                                // Apply decoded message content onto cached metadata (preserves LID etc.)
                                cachedData.message = webMessageInfo.message;
                                //eslint-disable-next-line max-depth
                                if (webMessageInfo.messageTimestamp) {
                                    cachedData.messageTimestamp = webMessageInfo.messageTimestamp;
                                }
                                finalMsg = cachedData;
                            }
                            else {
                                finalMsg = webMessageInfo;
                            }
                            logger?.debug({ msgId, requestId: response.stanzaId }, 'received placeholder resend');
                            ev.emit('messages.upsert', {
                                messages: [finalMsg],
                                type: 'notify',
                                requestId: response.stanzaId
                            });
                        }
                        catch (err) {
                            logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response');
                        }
                    }
                }
                break;
            case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
                ev.emit('messages.update', [
                    {
                        // flip the sender / fromMe properties because they're in the perspective of the sender
                        key: { ...message.key, id: protocolMsg.key?.id },
                        update: {
                            message: {
                                editedMessage: {
                                    message: protocolMsg.editedMessage
                                }
                            },
                            messageTimestamp: protocolMsg.timestampMs
                                ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
                                : message.messageTimestamp
                        }
                    }
                ]);
                break;
            case proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE:
                const labelAssociationMsg = protocolMsg.memberLabel;
                if (labelAssociationMsg?.label) {
                    ev.emit('group.member-tag.update', {
                        groupId: chat.id,
                        label: labelAssociationMsg.label,
                        participant: message.key.participant,
                        participantAlt: message.key.participantAlt,
                        messageTimestamp: Number(message.messageTimestamp)
                    });
                }
                break;
            case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
                const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload;
                const { pnToLidMappings, chatDbMigrationTimestamp } = proto.LIDMigrationMappingSyncPayload.decode(encodedPayload);
                logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp');
                const pairs = [];
                for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
                    const lid = latestLid || assignedLid;
                    pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` });
                }
                await signalRepository.lidMapping.storeLIDPNMappings(pairs);
                if (pairs.length) {
                    for (const { pn, lid } of pairs) {
                        await signalRepository.migrateSession(pn, lid);
                    }
                }
        }
    }
    else if (content?.reactionMessage) {
        const reaction = {
            ...content.reactionMessage,
            key: message.key
        };
        ev.emit('messages.reaction', [
            {
                reaction,
                key: content.reactionMessage?.key
            }
        ]);
    }
    else if (content?.encEventResponseMessage) {
        const encEventResponse = content.encEventResponseMessage;
        const creationMsgKey = encEventResponse.eventCreationMessageKey;
        // we need to fetch the event creation message to get the event enc key
        const eventMsg = await getMessage(creationMsgKey);
        if (eventMsg) {
            try {
                const meIdNormalised = jidNormalizedUser(meId);
                // all jids need to be PN
                const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid;
                const eventCreatorPn = isLidUser(eventCreatorKey)
                    ? await signalRepository.lidMapping.getPNForLID(eventCreatorKey)
                    : eventCreatorKey;
                const eventCreatorJid = getKeyAuthor({ remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn }, meIdNormalised);
                const responderJid = getKeyAuthor(message.key, meIdNormalised);
                const eventEncKey = eventMsg?.messageContextInfo?.messageSecret;
                if (!eventEncKey) {
                    logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption');
                }
                else {
                    const responseMsg = decryptEventResponse(encEventResponse, {
                        eventEncKey,
                        eventCreatorJid,
                        eventMsgId: creationMsgKey.id,
                        responderJid
                    });
                    const eventResponse = {
                        eventResponseMessageKey: message.key,
                        senderTimestampMs: responseMsg.timestampMs,
                        response: responseMsg
                    };
                    ev.emit('messages.update', [
                        {
                            key: creationMsgKey,
                            update: {
                                eventResponses: [eventResponse]
                            }
                        }
                    ]);
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response');
            }
        }
        else {
            logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response');
        }
    }
    else if (message.messageStubType) {
        const jid = message.key?.remoteJid;
        //let actor = whatsappID (message.participant)
        let participants;
        const emitParticipantsUpdate = (action) => ev.emit('group-participants.update', {
            id: jid,
            author: message.key.participant,
            authorPn: message.key.participantAlt,
            authorUsername: message.key.participantUsername,
            participants,
            action
        });
        const emitGroupUpdate = (update) => {
            ev.emit('groups.update', [
                {
                    id: jid,
                    ...update,
                    author: message.key.participant ?? undefined,
                    authorPn: message.key.participantAlt,
                    authorUsername: message.key.participantUsername
                }
            ]);
        };
        const emitGroupRequestJoin = (participant, action, method) => {
            ev.emit('group.join-request', {
                id: jid,
                author: message.key.participant,
                authorPn: message.key.participantAlt,
                authorUsername: message.key.participantUsername,
                participant: participant.lid,
                participantPn: participant.pn,
                action,
                method: method
            });
        };
        const participantsIncludesMe = () => participants.find(jid => areJidsSameUser(meId, jid.phoneNumber)); // ADD SUPPORT FOR LID
        switch (message.messageStubType) {
            case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || [];
                emitParticipantsUpdate('modify');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
            case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || [];
                emitParticipantsUpdate('remove');
                // mark the chat read only if you left the group
                if (participantsIncludesMe()) {
                    chat.readOnly = true;
                }
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_ADD:
            case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
            case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || [];
                if (participantsIncludesMe()) {
                    chat.readOnly = false;
                }
                emitParticipantsUpdate('add');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || [];
                emitParticipantsUpdate('demote');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
                participants = message.messageStubParameters.map((a) => JSON.parse(a)) || [];
                emitParticipantsUpdate('promote');
                break;
            case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                const announceValue = message.messageStubParameters?.[0];
                emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' });
                break;
            case WAMessageStubType.GROUP_CHANGE_RESTRICT:
                const restrictValue = message.messageStubParameters?.[0];
                emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' });
                break;
            case WAMessageStubType.GROUP_CHANGE_SUBJECT:
                const name = message.messageStubParameters?.[0];
                chat.name = name;
                emitGroupUpdate({ subject: name });
                break;
            case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
                const description = message.messageStubParameters?.[0];
                chat.description = description;
                emitGroupUpdate({ desc: description });
                break;
            case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
                const code = message.messageStubParameters?.[0];
                emitGroupUpdate({ inviteCode: code });
                break;
            case WAMessageStubType.GROUP_MEMBER_ADD_MODE:
                const memberAddValue = message.messageStubParameters?.[0];
                emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' });
                break;
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
                const approvalMode = message.messageStubParameters?.[0];
                emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' });
                break;
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: // TODO: Add other events
                const participant = JSON.parse(message.messageStubParameters?.[0]);
                const action = message.messageStubParameters?.[1];
                const method = message.messageStubParameters?.[2];
                emitGroupRequestJoin(participant, action, method);
                break;
        }
    } /*  else if(content?.pollUpdateMessage) {
        const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey!
        // we need to fetch the poll creation message to get the poll enc key
        // TODO: make standalone, remove getMessage reference
        // TODO: Remove entirely
        const pollMsg = await getMessage(creationMsgKey)
        if(pollMsg) {
            const meIdNormalised = jidNormalizedUser(meId)
            const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised)
            const voterJid = getKeyAuthor(message.key, meIdNormalised)
            const pollEncKey = pollMsg.messageContextInfo?.messageSecret!

            try {
                const voteMsg = decryptPollVote(
                    content.pollUpdateMessage.vote!,
                    {
                        pollEncKey,
                        pollCreatorJid,
                        pollMsgId: creationMsgKey.id!,
                        voterJid,
                    }
                )
                ev.emit('messages.update', [
                    {
                        key: creationMsgKey,
                        update: {
                            pollUpdates: [
                                {
                                    pollUpdateMessageKey: message.key,
                                    vote: voteMsg,
                                    senderTimestampMs: (content.pollUpdateMessage.senderTimestampMs! as Long).toNumber(),
                                }
                            ]
                        }
                    }
                ])
            } catch(err) {
                logger?.warn(
                    { err, creationMsgKey },
                    'failed to decrypt poll vote'
                )
            }
        } else {
            logger?.warn(
                { creationMsgKey },
                'poll creation message not found, cannot decrypt update'
            )
        }
        } */
    if (Object.keys(chat).length > 1) {
        ev.emit('chats.update', [chat]);
    }
};
export default processMessage;
//# sourceMappingURL=process-message.js.map