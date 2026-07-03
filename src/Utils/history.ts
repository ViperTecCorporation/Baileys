import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { createInflate, inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages-media'

const inflatePromise = promisify(inflate)
const historySyncDiagnosticsEnabled = () => process.env.BAILEYS_HISTORY_SYNC_DIAGNOSTICS === 'true'

const extractPnFromMessages = (messages: proto.IHistorySyncMsg[]): string | undefined => {
	for (const msgItem of messages) {
		const message = msgItem.message
		// Only extract from outgoing messages (fromMe: true) in 1:1 chats
		// because userReceipt.userJid is the recipient's JID
		if (!message?.key?.fromMe || !message.userReceipt?.length) {
			continue
		}

		const userJid = message.userReceipt[0]?.userJid
		if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) {
			return userJid
		}
	}

	return undefined
}

export const downloadHistory = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	const mediaKeyBytes = msg.mediaKey?.length || 0
	const fileSha256Bytes = msg.fileSha256?.length || 0
	const fileEncSha256Bytes = msg.fileEncSha256?.length || 0
	const directPathLength = msg.directPath?.length || 0
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	// Pipe decrypted stream directly through zlib inflate
	// This avoids allocating an intermediate buffer for the compressed data
	const inflater = createInflate()
	const chunks: Buffer[] = []
	inflater.on('data', (chunk: Buffer) => chunks.push(chunk))
	await pipeline(stream, inflater)

	const buffer = Buffer.concat(chunks)
	if (!buffer.length) {
		throw new Error(
			`empty inflated history sync payload mediaKeyBytes=${mediaKeyBytes} fileSha256Bytes=${fileSha256Bytes} fileEncSha256Bytes=${fileEncSha256Bytes} directPathLength=${directPathLength}`
		)
	}
	const syncData = proto.HistorySync.decode(buffer)
	return syncData
}

export const processHistoryMessage = (item: proto.IHistorySync, logger?: ILogger) => {
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []
	const lidPnMappings: LIDMapping[] = []
	const tcTokens: { jid: string; token?: Buffer; timestamp?: string; senderTimestamp?: number }[] = []

	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())

	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}

	for (const c of item.inlineContacts || []) {
		const id = c.lidJid || c.pnJid
		if (id) {
			contacts.push({
				id,
				name: c.fullName || c.firstName || c.username || undefined,
				username: c.username || undefined,
				lid: c.lidJid || undefined,
				phoneNumber: c.pnJid || undefined
			})
		}

		if (c.lidJid && c.pnJid) {
			lidPnMappings.push({ lid: c.lidJid, pn: c.pnJid })
		}
	}

	switch (item.syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
		case proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA:
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.displayName || chat.name || chat.username || undefined,
					username: chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const chatId = chat.id!
				if (chat.tcToken || chat.tcTokenTimestamp || chat.tcTokenSenderTimestamp) {
					tcTokens.push({
						jid: chat.lidJid || chat.accountLid || chat.id!,
						token: chat.tcToken ? Buffer.from(chat.tcToken) : undefined,
						timestamp: chat.tcTokenTimestamp ? String(toNumber(chat.tcTokenTimestamp)) : undefined,
						senderTimestamp: chat.tcTokenSenderTimestamp ? toNumber(chat.tcTokenSenderTimestamp) : undefined
					})
				}

				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				} else if (isLid && !chat.pnJid) {
					// Fallback: extract PN from userReceipt in messages when pnJid is missing
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) {
						lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
					}
				}

				const msgs = chat.messages || []
				delete chat.messages

				for (const item of msgs) {
					const message = item.message! as WAMessage
					messages.push(message)

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}

				chats.push(chat)
			}

			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	const nctSalt = item.nctSalt ? Buffer.from(item.nctSalt) : undefined
	if (historySyncDiagnosticsEnabled()) {
		logger?.info(
			{
				syncType: item.syncType,
				syncTypeName:
					typeof item.syncType === 'number'
						? proto.HistorySync.HistorySyncType[item.syncType] || `${item.syncType}`
						: `${item.syncType || 'unknown'}`,
				progress: item.progress,
				conversations: item.conversations?.length || 0,
				inlineContacts: item.inlineContacts?.length || 0,
				phoneNumberToLidMappings: item.phoneNumberToLidMappings?.length || 0,
				tcTokens: tcTokens.length,
				nctSaltBytes: nctSalt?.length || 0
			},
			'decoded history sync privacy diagnostics'
		)
	}

	return {
		chats,
		contacts,
		messages,
		lidPnMappings,
		tcTokens,
		nctSalt,
		pastParticipants: item.pastParticipants,
		syncType: item.syncType,
		progress: item.progress
	}
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit,
	logger?: ILogger
) => {
	let historyMsg: proto.HistorySync
	const syncTypeName =
		typeof msg.syncType === 'number'
			? proto.HistorySync.HistorySyncType[msg.syncType] || `${msg.syncType}`
			: `${msg.syncType || 'unknown'}`
	if (historySyncDiagnosticsEnabled()) {
		logger?.info(
			{
				syncType: msg.syncType,
				syncTypeName,
				chunkOrder: msg.chunkOrder,
				progress: msg.progress,
				inlinePayloadBytes: msg.initialHistBootstrapInlinePayload?.length || 0,
				mediaKeyBytes: msg.mediaKey?.length || 0,
				fileSha256Bytes: msg.fileSha256?.length || 0,
				fileEncSha256Bytes: msg.fileEncSha256?.length || 0,
				directPathLength: msg.directPath?.length || 0,
				fileLength: msg.fileLength ? String(toNumber(msg.fileLength)) : undefined
			},
			'history sync notification payload diagnostics'
		)
	}
	if (msg.initialHistBootstrapInlinePayload) {
		try {
			const inflated = await inflatePromise(msg.initialHistBootstrapInlinePayload)
			if (historySyncDiagnosticsEnabled()) {
				logger?.info(
					{ syncType: msg.syncType, syncTypeName, inlinePayloadBytes: msg.initialHistBootstrapInlinePayload.length, inflatedBytes: inflated.length },
					'inflated inline history sync payload'
				)
			}
			historyMsg = proto.HistorySync.decode(inflated)
		} catch (err) {
			logger?.warn({ err, syncType: msg.syncType, syncTypeName }, 'failed to inflate/decode inline history sync payload')
			throw err
		}
	} else {
		try {
			historyMsg = await downloadHistory(msg, options)
		} catch (err) {
			logger?.warn({ err, syncType: msg.syncType, syncTypeName }, 'failed to download/decode history sync payload')
			throw err
		}
	}

	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}
