import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import type {
	AnyMessageContent,
	MediaConnInfo,
	MessageReceiptType,
	MessageRelayOptions,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMessage,
	WAMessageKey
} from '../Types'
import {
	aggregateMessageKeysNotFromMe,
	assertMediaContent,
	assertMeId,
	bindWaitForEvent,
	decryptMediaRetryData,
	DEF_MEDIA_HOST,
	encodeNewsletterMessage,
	encodeSignedDeviceIdentity,
	encodeWAMessage,
	encryptMediaRetryRequest,
	extractDeviceJids,
	generateMessageIDV2,
	generateParticipantHashV2,
	generateWAMessage,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	MessageRetryManager,
	normalizeMessageContent,
	parseAndInjectE2ESessions,
	patchMessageForMdIfRequired,
	unixTimestampSeconds
} from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex'
import { getMessageReportingToken, shouldIncludeReportingToken } from '../Utils/reporting-utils'
import { isRetryableStaleConnectionError } from '../Utils/retryable-send'
import {
	buildCsTokenFromStoredSalt,
	isTcTokenExpired,
	resolveTcTokenJid,
	shouldSendNewTcToken,
	storeTcTokensFromIqResult
} from '../Utils/tc-token-utils'
import {
	areJidsSameUser,
	type BinaryNode,
	type BinaryNodeAttributes,
	type FullJid,
	getBizBinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isHostedLidUser,
	isHostedPnUser,
	isJidGroup,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	shouldIncludeBizBinaryNode,
	type JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeNewsletterSocket } from './newsletter'

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: httpRequestOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		enableRecentMessageCache,
		maxMsgRetryCount,
		privacyTokenQueryTimeoutMs
	} = config
	const preSendTcTokenTimeoutMs = Math.max(0, privacyTokenQueryTimeoutMs || 3000)
	const sock = makeNewsletterSocket(config)
	const {
		ev,
		authState,
		messageMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
		registerSocketEndHandler
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)

	const userDevicesCache =
		config.userDevicesCache ||
		new NodeCache<JidWithDevice[]>({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false
		})
	/** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
	const devicesMutex = makeMutex()

	// Initialize message retry manager if enabled
	const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null

	// Prevent race conditions in Signal session encryption by user
	const encryptionMutex = makeKeyedMutex()

	let mediaConn: Promise<MediaConnInfo> | undefined
	/** Per-socket media host; updated whenever media_conn is fetched. Defaults to the public WhatsApp host. */
	let mediaHost: string = DEF_MEDIA_HOST
	const refreshMediaConn = async (forceGet = false): Promise<MediaConnInfo> => {
		const media = await mediaConn
		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET
					},
					content: [{ tag: 'media_conn', attrs: {} }]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')!
				// TODO: explore full length of data that whatsapp provides
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname!,
						maxContentLengthBytes: +attrs.maxContentLengthBytes!
					})),
					auth: mediaConnNode.attrs.auth!,
					ttl: +mediaConnNode.attrs.ttl!,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				if (node.hosts[0]) {
					mediaHost = node.hosts[0].hostname
				}

				return node
			})()
		}

		return mediaConn!
	}

	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType
	) => {
		if (!messageIds || messageIds.length === 0) {
			throw new Boom('missing ids in receipt')
		}

		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0]!
			}
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if (isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if (participant) {
				node.attrs.participant = participant
			}
		}

		if (type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async (keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}

	/** Device info with wire JID */
	type DeviceWithJid = JidWithDevice & {
		jid: string
	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async (
		jids: string[],
		useCache: boolean,
		ignoreZeroDevices: boolean
	): Promise<DeviceWithJid[]> => {
		const deviceResults: DeviceWithJid[] = []

		if (!useCache) {
			logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []

		const jidsWithUser = jids
			.map(jid => {
				const decoded = jidDecode(jid)
				const user = decoded?.user
				const device = decoded?.device
				const isExplicitDevice = typeof device === 'number' && device >= 0

				if (isExplicitDevice && user) {
					deviceResults.push({
						user,
						device,
						jid
					})
					return null
				}

				jid = jidNormalizedUser(jid)
				return { jid, user }
			})
			.filter(jid => jid !== null)

		let mgetDevices: undefined | Record<string, FullJid[] | undefined>

		if (useCache && userDevicesCache.mget) {
			const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean) as string[]
			mgetDevices = await userDevicesCache.mget(usersToFetch)
		}

		for (const { jid, user } of jidsWithUser) {
			if (useCache) {
				const devices =
					mgetDevices?.[user!] ||
					(userDevicesCache.mget ? undefined : ((await userDevicesCache.get(user!)) as FullJid[]))
				if (devices) {
					const devicesWithJid = devices.map(d => ({
						...d,
						jid: jidEncode(d.user, d.server, d.device)
					}))
					deviceResults.push(...devicesWithJid)

					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if (!toFetch.length) {
			return deviceResults
		}

		const requestedLidUsers = new Set<string>()
		for (const jid of toFetch) {
			if (isLidUser(jid) || isHostedLidUser(jid)) {
				const user = jidDecode(jid)?.user
				if (user) requestedLidUsers.add(user)
			}
		}

		const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()

		for (const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
		}

		const result = await sock.executeUSyncQuery(query)

		if (result) {
			// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
			const lidResults = result.list.filter(a => !!a.lid)
			if (lidResults.length > 0) {
				logger.trace('Storing LID maps from device call')
				await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid as string, pn: a.id })))

				// Force-refresh sessions for newly mapped LIDs to align identity addressing
				try {
					const lids = lidResults.map(a => a.lid as string)
					if (lids.length) {
						await assertSessions(lids, true)
					}
				} catch (e) {
					logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
				}
			}

			const extracted = extractDeviceJids(
				result?.list,
				authState.creds.me!.id,
				authState.creds.me!.lid!,
				ignoreZeroDevices
			)
			const deviceMap: { [_: string]: FullJid[] } = {}

			for (const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user]?.push(item)
			}

			// Process each user's devices as a group for bulk LID migration
			for (const [user, userDevices] of Object.entries(deviceMap)) {
				const isLidUser = requestedLidUsers.has(user)

				// Process all devices for this user
				for (const item of userDevices) {
					const finalJid = isLidUser
						? jidEncode(user, item.server, item.device)
						: jidEncode(item.user, item.server, item.device)

					deviceResults.push({
						...item,
						jid: finalJid
					})

					logger.debug(
						{
							user: item.user,
							device: item.device,
							finalJid,
							usedLid: isLidUser
						},
						'Processed device with LID priority'
					)
				}
			}

			await devicesMutex.mutex(async () => {
				if (userDevicesCache.mset) {
					// if the cache supports mset, we can set all devices in one go
					await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
				} else {
					for (const key in deviceMap) {
						if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
					}
				}
			})

			const userDeviceUpdates: { [userId: string]: string[] } = {}
			for (const [userId, devices] of Object.entries(deviceMap)) {
				if (devices && devices.length > 0) {
					userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
				}
			}

			if (Object.keys(userDeviceUpdates).length > 0) {
				try {
					await authState.keys.set({ 'device-list': userDeviceUpdates })
					logger.debug(
						{ userCount: Object.keys(userDeviceUpdates).length },
						'stored user device lists for bulk migration'
					)
				} catch (error) {
					logger.warn({ error }, 'failed to store user device lists')
				}
			}
		}

		return deviceResults
	}

	/**
	 * Update Member Label
	 */
	const updateMemberLabel = (jid: string, memberLabel: string) => {
		return relayMessage(
			jid,
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: {
						label: memberLabel?.slice(0, 30),
						labelTimestamp: unixTimestampSeconds()
					}
				}
			},
			{
				additionalNodes: [
					{
						tag: 'meta',
						attrs: {
							tag_reason: 'user_update',
							appdata: 'member_tag'
						},
						content: undefined
					}
				]
			}
		)
	}

	const assertSessions = async (jids: string[], force?: boolean) => {
		let didFetchNewSession = false
		const uniqueJids = [...new Set(jids)]
		const jidsRequiringFetch: string[] = []

		logger.debug({ jids }, 'assertSessions call with jids')

		for (const jid of uniqueJids) {
			if (!force) {
				const sessionValidation = await signalRepository.validateSession(jid)
				if (sessionValidation.exists) {
					continue
				}
			}

			jidsRequiringFetch.push(jid)
		}

		if (jidsRequiringFetch.length) {
			// LID if mapped, otherwise original
			const wireJids = [
				...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
				...(
					(await signalRepository.lidMapping.getLIDsForPNs(
						jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid))
					)) || []
				).map(a => a.lid)
			]

			logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET
				},
				content: [
					{
						tag: 'key',
						attrs: {},
						content: wireJids.map(jid => {
							const attrs: { [key: string]: string } = { jid }
							if (force) attrs.reason = 'identity'
							return { tag: 'user', attrs }
						})
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)
			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	const sendPeerDataOperationMessage = async (
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',

				push_priority: 'high_force'
			},
			additionalNodes: [
				{
					tag: 'meta',
					attrs: { appdata: 'default' }
				}
			]
		})

		return msgId
	}

	const createParticipantNodes = async (
		recipientJids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
		dsmMessage?: proto.IMessage
	) => {
		if (!recipientJids.length) {
			return { nodes: [] as BinaryNode[], shouldIncludeDeviceIdentity: false }
		}

		const patched = await patchMessageBeforeSending(message, recipientJids)
		const patchedMessages = Array.isArray(patched)
			? patched
			: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

		let shouldIncludeDeviceIdentity = false
		const meId = authState.creds.me!.id
		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? jidDecode(meLid)?.user : null

		const encryptionPromises = (patchedMessages as any).map(
			async ({ recipientJid: jid, message: patchedMessage }: any) => {
				try {
					if (!jid) return null

					let msgToEncrypt = patchedMessage

					if (dsmMessage) {
						const { user: targetUser } = jidDecode(jid)!
						const { user: ownPnUser } = jidDecode(meId)!
						const ownLidUser = meLidUser

						const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)
						const isExactSenderDevice = jid === meId || (meLid && jid === meLid)

						if (isOwnUser && !isExactSenderDevice) {
							msgToEncrypt = dsmMessage
							logger.debug({ jid, targetUser }, 'Using DSM for own device')
						}
					}

					const bytes = encodeWAMessage(msgToEncrypt)
					const mutexKey = jid

					const node = await encryptionMutex.mutex(mutexKey, async () => {
						const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })

						if (type === 'pkmsg') {
							shouldIncludeDeviceIdentity = true
						}

						return {
							tag: 'to',
							attrs: { jid },
							content: [
								{
									tag: 'enc',
									attrs: { v: '2', type, ...(extraAttrs || {}) },
									content: ciphertext
								}
							]
						}
					})

					return node
				} catch (err) {
					logger.error({ jid, err }, 'Failed to encrypt for recipient')
					return null
				}
			}
		)

		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]

		if (recipientJids.length > 0 && nodes.length === 0) {
			throw new Boom('All encryptions failed', { statusCode: 500 })
		}

		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async (
		jid: string,
		message: proto.IMessage,
		options: MessageRelayOptions
	) => {
		let {
			messageId: msgId,
			participant,
			additionalAttributes,
			additionalNodes,
			useUserDevicesCache,
			useCachedGroupMetadata,
			statusJidList
		} = options
		const meId = assertMeId(authState.creds)
		const meLid = authState.creds.me?.lid
		const isRetryResend = Boolean(participant?.jid)
		let shouldIncludeDeviceIdentity = isRetryResend
		const statusJid = 'status@broadcast'

		const { user, server } = jidDecode(jid)!
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		const isNewsletter = server === 'newsletter'
		const isGroupOrStatus = isGroup || isStatus
		const finalJid = jid

		msgId = msgId || generateMessageIDV2(meId)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus
		const shouldForceCarouselDeviceIdentity = !!(
			message.interactiveMessage?.carouselMessage ||
			message.documentWithCaptionMessage?.message?.interactiveMessage?.carouselMessage
		)

		const participants: BinaryNode[] = []
		const destinationJid = !isStatus ? finalJid : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: DeviceWithJid[] = []
		let reportingMessage: proto.IMessage | undefined
		let reportingTokenAdded = false

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			},
			messageContextInfo: message.messageContextInfo
		}

		const extraAttrs: BinaryNodeAttributes = {}

		if (participant) {
			if (!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
			}

			const { user, device } = jidDecode(participant.jid)!
			devices.push({
				user,
				device,
				jid: participant.jid
			})
		}

		await authState.keys.transaction(async () => {
			const shouldUseBizTextEnvelope = shouldIncludeBizBinaryNode(message)
			const mediaType = getMediaType(message)
			if (mediaType && !shouldUseBizTextEnvelope) {
				extraAttrs['mediatype'] = mediaType
			}

			if (isNewsletter) {
				const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
				const bytes = encodeNewsletterMessage(patched as proto.IMessage)
				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: {},
					content: bytes
				})
				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						to: jid,
						id: msgId,
						type: getMessageType(message),
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				logger.debug({ msgId }, `sending newsletter message to ${jid}`)
				await sendNode(stanza)
				return
			}

			if (normalizeMessageContent(message)?.pinInChatMessage || normalizeMessageContent(message)?.reactionMessage) {
				extraAttrs['decrypt-fail'] = 'hide' // todo: expand for reactions and other types
			}

			if (isGroupOrStatus && !isRetryResend) {
				const [groupData, senderKeyMap] = await Promise.all([
					(async () => {
						let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
						if (groupData && Array.isArray(groupData?.participants)) {
							logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
						} else if (!isStatus) {
							groupData = await groupMetadata(jid) // TODO: start storing group participant list + addr mode in Signal & stop relying on this
						}

						return groupData
					})(),
					(async () => {
						if (!participant && !isStatus) {
							// what if sender memory is less accurate than the cached metadata
							// on participant change in group, we should do sender memory manipulation
							const result = await authState.keys.get('sender-key-memory', [jid]) // TODO: check out what if the sender key memory doesn't include the LID stuff now?
							return result[jid] || {}
						}

						return {}
					})()
				])

				const participantsList = groupData ? groupData.participants.map(p => p.id) : []

				if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
					additionalAttributes = {
						...additionalAttributes,
						expiration: groupData.ephemeralDuration.toString()
					}
				}

				if (isStatus && statusJidList) {
					participantsList.push(...statusJidList)
				}

				const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
				devices.push(...additionalDevices)

				if (isGroup) {
					additionalAttributes = {
						...additionalAttributes,
						addressing_mode: groupData?.addressingMode || 'lid'
					}
				}

				const patched = await patchMessageBeforeSending(message)
				if (Array.isArray(patched)) {
					throw new Boom('Per-jid patching is not supported in groups')
				}

				const bytes = encodeWAMessage(patched)
				reportingMessage = patched
				const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid'
				const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

				const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
					group: destinationJid,
					data: bytes,
					meId: groupSenderIdentity
				})

				const senderKeyRecipients: string[] = []
				for (const device of devices) {
					const deviceJid = device.jid
					const hasKey = !!senderKeyMap[deviceJid]
					if (
						(!hasKey || !!participant) &&
						!isHostedLidUser(deviceJid) &&
						!isHostedPnUser(deviceJid) &&
						device.device !== 99
					) {
						//todo: revamp all this logic
						// the goal is to follow with what I said above for each group, and instead of a true false map of ids, we can set an array full of those the app has already sent pkmsgs
						senderKeyRecipients.push(deviceJid)
						senderKeyMap[deviceJid] = true
					}
				}

				if (senderKeyRecipients.length) {
					logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key')

					const senderKeyMsg: proto.IMessage = {
						senderKeyDistributionMessage: {
							axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
							groupId: destinationJid
						}
					}

					const senderKeySessionTargets = senderKeyRecipients
					await assertSessions(senderKeySessionTargets)

					const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

					participants.push(...result.nodes)
				}

				binaryNodeContent.push({
					tag: 'enc',
					attrs: { v: '2', type: 'skmsg', ...extraAttrs },
					content: ciphertext
				})

				await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
			} else {
				// ADDRESSING CONSISTENCY: Match own identity to conversation context
				// TODO: investigate if this is true
				let ownId = meId
				if (isLid && meLid) {
					ownId = meLid
					logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
				} else {
					logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
				}

				const { user: ownUser } = jidDecode(ownId)!
				if (!participant) {
					const patchedForReporting = await patchMessageBeforeSending(message, [jid])
					reportingMessage = Array.isArray(patchedForReporting)
						? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
						: patchedForReporting
				}

				if (!isRetryResend) {
					const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
					devices.push({
						user,
						device: 0,
						jid: jidEncode(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
					})

					if (user !== ownUser) {
						const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
						const ownUserForAddressing = isLid && meLid ? jidDecode(meLid)!.user : jidDecode(meId)!.user

						devices.push({
							user: ownUserForAddressing,
							device: 0,
							jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
						})
					}

					if (additionalAttributes?.['category'] !== 'peer') {
						// Clear placeholders and enumerate actual devices
						devices.length = 0

						// Use conversation-appropriate sender identity
						const senderIdentity =
							isLid && meLid
								? jidEncode(jidDecode(meLid)?.user!, 'lid', undefined)
								: jidEncode(jidDecode(meId)?.user!, 's.whatsapp.net', undefined)

						// Enumerate devices for sender and target with consistent addressing
						const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
						devices.push(...sessionDevices)

						logger.debug(
							{
								deviceCount: devices.length,
								devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
							},
							'Device enumeration complete with unified addressing'
						)
					}
				}

				const allRecipients: string[] = []
				const meRecipients: string[] = []
				const otherRecipients: string[] = []
				const { user: mePnUser } = jidDecode(meId)!
				const { user: meLidUser } = meLid ? jidDecode(meLid)! : { user: null }

				for (const { user, jid } of devices) {
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isExactSenderDevice) {
						logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
						continue
					}

					// Check if this is our device (could match either PN or LID user)
					const isMe = user === mePnUser || user === meLidUser

					if (isMe) {
						meRecipients.push(jid)
					} else {
						otherRecipients.push(jid)
					}

					allRecipients.push(jid)
				}

				// Detect actual view-once media by inspecting the inner message's viewOnce flag.
				// viewOnceMessage* wrappers are also used for interactive messages (buttons, lists, etc.)
				// which do NOT carry viewOnce=true on the inner media — those must not be filtered.
				const viewOnceInner =
					message.viewOnceMessageV2?.message ||
					message.viewOnceMessage?.message ||
					message.viewOnceMessageV2Extension?.message
				const isViewOnceMsg = !!(
					viewOnceInner?.imageMessage?.viewOnce ||
					viewOnceInner?.videoMessage?.viewOnce ||
					viewOnceInner?.audioMessage?.viewOnce
				)

				// For view-once: send DSM only to primary phone (device=0).
				// Companion devices (device>0) are omitted — the WA server generates
				// <unavailable type="view_once"/> for them automatically.
				// Sending an explicit <unavailable> from a companion is rejected by the server.
				const viewOnceMeRecipients = isViewOnceMsg
					? meRecipients.filter(jid => !jidDecode(jid)?.device)
					: meRecipients

				// Assert sessions only for recipients we actually encrypt for.
				// For view-once, companions are omitted — asserting their sessions is wasteful
				// and could block the send if a companion session is corrupted.
				await assertSessions([...viewOnceMeRecipients, ...otherRecipients])

				const [
					{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
					{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
				] = await Promise.all([
					// For own devices: use DSM if available (1:1 chats only)
					createParticipantNodes(viewOnceMeRecipients, meMsg || message, extraAttrs),
					createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
				])
				participants.push(...meNodes)
				participants.push(...otherNodes)

				const phashRecipients = isViewOnceMsg
					? [...viewOnceMeRecipients, ...otherRecipients]
					: [...meRecipients, ...otherRecipients]
				if (phashRecipients.length > 0) {
					extraAttrs['phash'] = generateParticipantHashV2(phashRecipients)
				}

				shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
			}

			if (isRetryResend) {
				const isParticipantLid = isLidUser(participant!.jid)
				const isMe = areJidsSameUser(participant!.jid, isParticipantLid ? meLid : meId)

				let messageToSend = message
				if (isGroupOrStatus) {
					let groupSenderIdentity: string | undefined
					if (meLid && (await signalRepository.hasSenderKey({ group: destinationJid, meId: meLid }))) {
						groupSenderIdentity = meLid
					} else if (await signalRepository.hasSenderKey({ group: destinationJid, meId })) {
						groupSenderIdentity = meId
					}

					if (groupSenderIdentity) {
						try {
							const skdm = await signalRepository.getSenderKeyDistributionMessage({
								group: destinationJid,
								meId: groupSenderIdentity
							})
							messageToSend = {
								...message,
								senderKeyDistributionMessage: {
									groupId: destinationJid,
									axolotlSenderKeyDistributionMessage: skdm
								}
							}
						} catch (err) {
							logger.warn({ err, jid: destinationJid }, 'failed to build SKDM for retry, sending without it')
						}
					}
				}

				const encodedMessageToSend = isMe
					? encodeWAMessage({
							deviceSentMessage: {
								destinationJid,
								message: messageToSend
							}
						})
					: encodeWAMessage(messageToSend)

				const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
					data: encodedMessageToSend,
					jid: participant!.jid
				})

				binaryNodeContent.push({
					tag: 'enc',
					attrs: {
						v: '2',
						type,
						count: participant!.count.toString()
					},
					content: encryptedContent
				})
			}

			if (participants.length) {
				if (additionalAttributes?.['category'] === 'peer') {
					const peerNode = participants[0]?.content?.[0] as BinaryNode
					if (peerNode) {
						binaryNodeContent.push(peerNode) // push only enc
					}
				} else {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: {},

						content: participants
					})
				}
			}

			// WA Web stamps the PN counterpart when a direct 1:1 envelope is LID-addressed.
			// This lets the server relate the LID send to the PN chat identity.
			const isPeerMessage = additionalAttributes?.['category'] === 'peer'
			const is1on1Send = !isGroup && !isStatus && !isNewsletter && !isPeerMessage
			if (is1on1Send && isLidUser(destinationJid) && !additionalAttributes?.peer_recipient_pn) {
				try {
					const peerRecipientPn = await signalRepository.lidMapping.getPNForLID(destinationJid)
					if (peerRecipientPn && isPnUser(peerRecipientPn)) {
						additionalAttributes = {
							...additionalAttributes,
							peer_recipient_pn: jidNormalizedUser(peerRecipientPn)
						}
						logger.debug(
							{ jid: destinationJid, peerRecipientPn: additionalAttributes.peer_recipient_pn },
							'attached peer_recipient_pn for LID 1:1 message'
						)
					}
				} catch (err: any) {
					logger.debug({ jid: destinationJid, err: err?.message }, 'failed to resolve peer_recipient_pn')
				}
			}

			const stanza: BinaryNode = {
				tag: 'message',
				attrs: {
					id: msgId,
					to: destinationJid,
					type: shouldUseBizTextEnvelope ? 'text' : getMessageType(message),
					...(additionalAttributes || {})
				},
				content: binaryNodeContent
			}

			// if the participant to send to is explicitly specified (generally retry recp)
			// ensure the message is only sent to that person
			// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
			if (participant) {
				if (isJidGroup(destinationJid)) {
					stanza.attrs.to = destinationJid
					stanza.attrs.participant = participant.jid
				} else if (areJidsSameUser(participant.jid, meId)) {
					stanza.attrs.to = participant.jid
					stanza.attrs.recipient = destinationJid
				} else {
					stanza.attrs.to = participant.jid
				}
			} else {
				stanza.attrs.to = destinationJid
			}

			if (shouldIncludeDeviceIdentity || shouldForceCarouselDeviceIdentity) {
				;(stanza.content as BinaryNode[]).push({
					tag: 'device-identity',
					attrs: {},
					content: encodeSignedDeviceIdentity(authState.creds.account!, true)
				})

				logger.debug({ jid }, 'adding device identity')
			}

			if (reportingMessage && shouldIncludeReportingToken(reportingMessage)) {
				reportingMessage.messageContextInfo = reportingMessage.messageContextInfo || {}
				if (!reportingMessage.messageContextInfo.messageSecret) {
					reportingMessage.messageContextInfo.messageSecret = randomBytes(32)
				}
			}

			if (
				!isNewsletter &&
				!isRetryResend &&
				reportingMessage?.messageContextInfo?.messageSecret &&
				shouldIncludeReportingToken(reportingMessage)
			) {
				try {
					const encoded = encodeWAMessage(reportingMessage)
					const reportingKey: WAMessageKey = {
						id: msgId,
						fromMe: true,
						remoteJid: destinationJid,
						participant: participant?.jid
					}
					const reportingNode = await getMessageReportingToken(encoded, reportingMessage, reportingKey)
					if (reportingNode) {
						;(stanza.content as BinaryNode[]).push(reportingNode)
						logger.trace({ jid }, 'added reporting token to message')
						reportingTokenAdded = true
					}
				} catch (error: any) {
					logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token')
				}
			}

			// WA Web never attaches tctoken to peer (AppStateSync) messages; server rejects with 479.
			let didFetchTcToken = false
			let privacyTokenNodeTag: 'tctoken' | 'cstoken' | undefined

				// Resolve destination to LID for tctoken storage — matches Signal session key pattern
				const tcTokenJid = is1on1Send ? await resolveTcTokenJid(destinationJid, getLIDForPN) : destinationJid
				const peerRecipientPn =
					is1on1Send && isLidUser(destinationJid) && additionalAttributes?.peer_recipient_pn
						? jidNormalizedUser(additionalAttributes.peer_recipient_pn)
						: undefined
				const tcTokenCandidateJids = [
					tcTokenJid,
					...(peerRecipientPn && isPnUser(peerRecipientPn) ? [peerRecipientPn] : []),
					...(destinationJid !== tcTokenJid ? [destinationJid] : [])
				].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
				const findStoredTcToken = async () => {
					const data = is1on1Send ? await authState.keys.get('tctoken', tcTokenCandidateJids) : {}
					for (const candidate of tcTokenCandidateJids) {
						const entry = data[candidate]
						if (entry?.token?.length && !isTcTokenExpired(entry.timestamp)) {
							return { entry, jid: candidate, token: entry.token }
						}
					}

					return {
						entry: data[tcTokenJid],
						jid: tcTokenJid,
						token: data[tcTokenJid]?.token
					}
				}
				let storedTcToken = await findStoredTcToken()
				let existingTokenEntry = storedTcToken.entry
				let activeTcTokenJid = storedTcToken.jid
				let tcTokenBuffer = storedTcToken.token

				// Treat expired tokens the same as missing — re-fetch from server
				if (tcTokenBuffer?.length && isTcTokenExpired(existingTokenEntry?.timestamp)) {
					logger.debug(
						{ jid: destinationJid, tcTokenJid: activeTcTokenJid, timestamp: existingTokenEntry?.timestamp },
						'tctoken expired, will re-fetch'
					)
					tcTokenBuffer = undefined
					// Opportunistic cleanup: remove expired token from store
					try {
						await authState.keys.set({ tctoken: { [activeTcTokenJid]: null } })
					} catch {
						/* ignore cleanup errors */
					}
				}

			// If tctoken is missing or expired for a 1:1 send, proactively fetch it from the server
			if (!tcTokenBuffer?.length && is1on1Send) {
				try {
					logger.debug(
						{ jid: destinationJid, tcTokenJid, candidates: tcTokenCandidateJids, timeoutMs: preSendTcTokenTimeoutMs },
						'tctoken missing, requesting from server (bounded wait)'
					)
					const fetchJids = [
						destinationJid,
						...(peerRecipientPn && isPnUser(peerRecipientPn) ? [peerRecipientPn] : [])
					].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
					const fetchSummaries: {
						jid: string
						stored?: number
						tokenNodes?: number
						tokensNodeFound?: boolean
						storedJids?: string[]
						statusCode?: number
						error?: string
					}[] = []
					for (const fetchJid of fetchJids) {
						try {
							const fetchResult = await getPrivacyTokens([fetchJid], undefined, preSendTcTokenTimeoutMs)
							const storeResult = await storeTcTokensFromIqResult({
								result: fetchResult,
								fallbackJid: fetchJid,
								keys: authState.keys,
								getLIDForPN: signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
							})
							fetchSummaries.push({
								jid: fetchJid,
								stored: storeResult.stored,
								tokenNodes: storeResult.tokenNodes,
								tokensNodeFound: storeResult.tokensNodeFound,
								storedJids: storeResult.storedJids
							})

							storedTcToken = await findStoredTcToken()
							if (storedTcToken.token?.length) {
								break
							}
						} catch (err: any) {
							fetchSummaries.push({
								jid: fetchJid,
								statusCode: err?.output?.statusCode,
								error: err?.message
							})
							logger.warn(
								{
									jid: destinationJid,
									tcTokenJid,
									fetchJid,
									timeoutMs: preSendTcTokenTimeoutMs,
									statusCode: err?.output?.statusCode
								},
								'failed to fetch privacy token candidate before send'
							)
						}
					}

					// Re-read from key store — the notification handler or inline
					// parsing above may have stored the token
					storedTcToken = await findStoredTcToken()
					const refreshedEntry = storedTcToken.entry
					activeTcTokenJid = storedTcToken.jid
					existingTokenEntry = refreshedEntry
					tcTokenBuffer = storedTcToken.token
					logger.debug(
						{
							jid: destinationJid,
							tcTokenJid,
							activeTcTokenJid,
							fetchJids,
							candidates: tcTokenCandidateJids,
							timeoutMs: preSendTcTokenTimeoutMs,
							fetchSummaries,
							tokenBytes: tcTokenBuffer?.length || 0
						},
						'tctoken pre-send fetch completed'
					)

					// The getPrivacyTokens IQ (type='set') also acts as issuance,
					// so record senderTimestamp to prevent redundant fire-and-forget
					// on the next message to this contact.
					if (refreshedEntry?.token?.length) {
						await authState.keys.set({
							tctoken: {
								[activeTcTokenJid]: {
									...refreshedEntry,
									senderTimestamp: unixTimestampSeconds()
								}
							}
						})
					}

					didFetchTcToken = true
				} catch (err: any) {
					logger.warn(
						{
							jid: destinationJid,
							tcTokenJid,
							candidates: tcTokenCandidateJids,
							timeoutMs: preSendTcTokenTimeoutMs,
							statusCode: err?.output?.statusCode,
							trace: err?.stack
						},
						'failed to fetch privacy token before send, proceeding without blocking'
					)
				}
			}

			if (tcTokenBuffer?.length) {
				;(stanza.content as BinaryNode[]).push({
					tag: 'tctoken',
					attrs: {},
					content: tcTokenBuffer
				})
				privacyTokenNodeTag = 'tctoken'
			} else if (is1on1Send) {
				const recipientLidForCsToken = isLidUser(tcTokenJid) ? tcTokenJid : undefined
				const csTokenContent = await buildCsTokenFromStoredSalt({
					authState,
					recipientLid: recipientLidForCsToken,
					onDiagnostic: diagnostic => {
						const logPayload = {
							jid: destinationJid,
							tcTokenJid,
							recipientLid: recipientLidForCsToken,
							...diagnostic
						}
						if (diagnostic.reason === 'built') {
							logger.debug(logPayload, 'cstoken fallback build diagnostics')
						} else {
							logger.warn(logPayload, 'cstoken fallback unavailable')
						}
					}
				})
				if (csTokenContent?.length) {
					;(stanza.content as BinaryNode[]).push(...csTokenContent)
					privacyTokenNodeTag = 'cstoken'
					logger.debug({ jid: destinationJid, tcTokenJid, nodes: csTokenContent.length }, 'attached cstoken fallback to 1:1 message')
				} else {
					logger.warn({ jid: destinationJid, tcTokenJid }, 'sending 1:1 message without privacy token')
				}
			}

			msgId && (options.__privacyToken = {
				required: is1on1Send,
				tokenType: is1on1Send ? (privacyTokenNodeTag === 'tctoken' ? 'tc' : privacyTokenNodeTag === 'cstoken' ? 'cs' : 'none') : 'not_required',
				hasTcToken: privacyTokenNodeTag === 'tctoken',
				hasPrivacyToken: !!privacyTokenNodeTag,
				destinationJid,
				storageJid: is1on1Send ? tcTokenJid : undefined,
				activeJid: is1on1Send ? activeTcTokenJid : undefined,
				source: !is1on1Send ? 'not_required' : privacyTokenNodeTag === 'tctoken' ? (didFetchTcToken ? 'fetch' : 'cache') : privacyTokenNodeTag === 'cstoken' ? 'cs_salt' : 'missing',
				didFetch: didFetchTcToken
			})

			if (additionalNodes && additionalNodes.length > 0) {
				;(stanza.content as BinaryNode[]).push(...additionalNodes)
			}

			const innerMessage = message.documentWithCaptionMessage?.message || message
			if (shouldIncludeBizBinaryNode(innerMessage)) {
				;(stanza.content as BinaryNode[]).push(getBizBinaryNode(innerMessage))
				logger.debug({ jid }, 'adding biz node for buttons message')
			}

			if (innerMessage.buttonsMessage || innerMessage.listMessage || innerMessage.interactiveMessage) {
				logger.debug(
					{
						jid,
						msgId,
						stanzaType: stanza.attrs.type,
						encMediaType: extraAttrs['mediatype'],
						bizTextEnvelope: shouldUseBizTextEnvelope,
						privacyTokenNodeTag,
						hasMessageContextInfo: !!innerMessage.messageContextInfo,
						reportingTokenAdded
					},
					'interactive/list/buttons send context'
				)
			}

			logger.debug({ msgId }, `sending message to ${participants.length} devices`)

			await sendNode(stanza)

			// Fire-and-forget: issue our token to the contact (like WA Web's sendTcToken)
			// Only for 1:1 sends where we didn't already fetch, and only when bucket boundary crossed
			if (is1on1Send && !didFetchTcToken && shouldSendNewTcToken(existingTokenEntry?.senderTimestamp)) {
				const issueTimestamp = unixTimestampSeconds()
				// WA Web writes senderTimestamp only AFTER the IQ succeeds
				// (WAWebSendTcTokenChatAction.sendTcToken).
				// This ensures failed issuance allows re-issuance on the next message
				// rather than blocking it for up to 7 days (one bucket duration).
				getPrivacyTokens([destinationJid], issueTimestamp)
					.then(async result => {
						// Store any tokens the server returned in the IQ response.
						// Note: onNewJidStored not passed — the pruning index lives in messages-recv
						// (higher layer). This is benign: fire-and-forget only runs for contacts
						// we're actively messaging, so their JIDs will be tracked via the receive path.
						const storeResult = await storeTcTokensFromIqResult({
							result,
							fallbackJid: tcTokenJid,
							keys: authState.keys,
							getLIDForPN
						})
						logger.debug(
							{
								jid: destinationJid,
								tcTokenJid,
								stored: storeResult.stored,
								tokenNodes: storeResult.tokenNodes,
								tokensNodeFound: storeResult.tokensNodeFound,
								storedJids: storeResult.storedJids
							},
							'fire-and-forget tctoken issuance completed'
						)

						// Persist senderTimestamp to prevent redundant issuances.
						// WA Web stores tcTokenSenderTimestamp in the chat table unconditionally.
						const currentData = await authState.keys.get('tctoken', [tcTokenJid])
						const currentEntry = currentData[tcTokenJid]
						await authState.keys.set({
							tctoken: {
								[tcTokenJid]: {
									// Spread preserves token+timestamp if they exist,
									// falls back to empty buffer if no token received yet
									token: Buffer.alloc(0),
									...currentEntry,
									senderTimestamp: issueTimestamp
								}
							}
						})
					})
					.catch(err => {
						logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed')
					})
			}

			// Add message to retry cache if enabled
			if (messageRetryManager && !participant) {
				messageRetryManager.addRecentMessage(destinationJid, msgId, message)
			}
		}, meId)

		return msgId
	}

	const getMessageType = (message: proto.IMessage) => {
		const normalizedMessage = normalizeMessageContent(message)
		if (!normalizedMessage) return 'text'

		if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) {
			return 'reaction'
		}

		if (
			normalizedMessage.pollCreationMessage ||
			normalizedMessage.pollCreationMessageV2 ||
			normalizedMessage.pollCreationMessageV3 ||
			normalizedMessage.pollUpdateMessage
		) {
			return 'poll'
		}

		if (normalizedMessage.eventMessage) {
			return 'event'
		}

		if (getMediaType(normalizedMessage) !== '') {
			return 'media'
		}

		return 'text'
	}

	const getMediaType = (message: proto.IMessage) => {
		// For view-once media, unwrap the viewOnceMessage wrapper before checking media type
		const inner =
			message.viewOnceMessage?.message ||
			message.viewOnceMessageV2?.message ||
			message.viewOnceMessageV2Extension?.message
		if (inner) {
			return getMediaType(inner)
		}

		if (message.imageMessage) {
			return 'image'
		} else if (message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if (message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if (message.contactMessage) {
			return 'vcard'
		} else if (message.documentMessage) {
			return 'document'
		} else if (message.contactsArrayMessage) {
			return 'contact_array'
		} else if (message.liveLocationMessage) {
			return 'livelocation'
		} else if (message.stickerMessage) {
			return 'sticker'
		} else if (message.listMessage) {
			return 'list'
		} else if (message.buttonsMessage) {
			return 'buttons'
		} else if (message.listResponseMessage) {
			return 'list_response'
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if (message.orderMessage) {
			return 'order'
		} else if (message.productMessage) {
			return 'product'
		} else if (message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if (message.groupInviteMessage) {
			return 'url'
		}

		return ''
	}

	const getPrivacyTokens = async (jids: string[], timestamp?: number, timeoutMs?: number) => {
		const t = (timestamp ?? unixTimestampSeconds()).toString()
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'privacy'
				},
				content: [
					{
						tag: 'tokens',
						attrs: {},
						content: jids.map(jid => ({
							tag: 'token',
							attrs: {
								jid: jidNormalizedUser(jid),
								t,
								type: 'trusted_contact'
							}
						}))
					}
				]
			},
			timeoutMs
		)

		return result
	}

	const ensurePrivacyTokens = async (jids: string[], timeoutMs?: number) => {
		const normalized = (jids || [])
			.map(jid => jidNormalizedUser(jid))
			.filter((jid): jid is string => !!jid)
		if (!normalized.length) {
			return { stored: 0, tokenNodes: 0, tokensNodeFound: false, storedJids: [] }
		}
		const fallbackJid = normalized[0]!
		const result = await getPrivacyTokens(normalized, undefined, timeoutMs)
		const storeResult = await storeTcTokensFromIqResult({
			result,
			fallbackJid,
			keys: authState.keys,
			getLIDForPN: signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
		})
		return storeResult
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	registerSocketEndHandler(() => {
		if (!config.userDevicesCache && userDevicesCache.close) {
			userDevicesCache.close()
		}

		mediaConn = undefined
		if (messageRetryManager) {
			messageRetryManager.clear()
		}
	})

	return {
		...sock,
		userDevicesCache,
		devicesMutex,
		getPrivacyTokens,
		issuePrivacyTokens: getPrivacyTokens,
		ensurePrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		// Function (not getter) so the spread in chats.ts preserves the live closure binding.
		getMediaHost: () => mediaHost,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		messageRetryManager,
		updateMemberLabel,
		updateMediaMessage: async (message: WAMessage) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all([
				sendNode(node),
				waitForMsgMediaUpdate(async update => {
					const result = update.find(c => c.key.id === message.key.id)
					if (result) {
						if (result.error) {
							error = result.error
						} else {
							try {
								const media = decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
								if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = proto.MediaRetryNotification.ResultType[media.result!]
									throw new Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: getStatusCodeForMediaRetry(media.result!) || 404
									})
								}

								content.directPath = media.directPath
								content.url = getUrlFromDirectPath(content.directPath!, mediaHost)

								logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
							} catch (err: any) {
								error = err
							}
						}

						return true
					}
				})
			])

			if (error) {
				throw error
			}

			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])

			return message
		},
		sendMessage: async (jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) => {
			const userJid = authState.creds.me!.id
			let targetJid = jid
			if (typeof content === 'object' && 'react' in content && content.react?.key) {
				const reactKey = content.react.key
				if (reactKey.participant === '') {
					delete (reactKey as { participant?: string }).participant
					logger?.warn({ reactKey }, 'cleared empty reaction participant')
				}

				if (reactKey.remoteJid && reactKey.remoteJid !== jid) {
					logger?.warn(
						{ jid, reactRemoteJid: reactKey.remoteJid },
						'reaction target jid mismatch; using react key remoteJid'
					)
					targetJid = reactKey.remoteJid
				}
			}

			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(targetJid)
			) {
				const { disappearingMessagesInChat } = content
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat
				await groupToggleEphemeral(targetJid, value)
			} else {
				const fullMsg = await generateWAMessage(targetJid, content, {
					logger,
					userJid,
					getUrlInfo: text =>
						getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...(httpRequestOptions || {})
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					//TODO: CACHE
					getProfilePicUrl: sock.profilePictureUrl,
					getCallLink: sock.createCallLink,
					upload: waUploadToServer,
					mediaCache: config.mediaCache,
					options: config.options,
					messageId: generateMessageIDV2(sock.user?.id),
					...options
				})
				fullMsg.message = patchMessageForMdIfRequired(fullMsg.message!)
				const isEventMsg = 'event' in content && !!content.event
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const additionalAttributes: BinaryNodeAttributes = {}
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if (isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if (isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1'
				} else if (isPinMsg) {
					additionalAttributes.edit = '2'
				} else if (isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						}
					} as BinaryNode)
				} else if (isEventMsg) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							event_type: 'creation'
						}
					} as BinaryNode)
				}

				const retryRelayOptions: MessageRelayOptions = {
					messageId: fullMsg.key.id!,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes
				}
				try {
					await relayMessage(targetJid, fullMsg.message, retryRelayOptions)
					if (retryRelayOptions.__privacyToken) {
						fullMsg.__privacyToken = retryRelayOptions.__privacyToken
					}
				} catch (error) {
					if (isRetryableStaleConnectionError(error)) {
						throw new Boom('Send failed due to stale connection; safe to retry after reconnect', {
							statusCode: error.output.statusCode,
							data: {
								...error.data,
								retryableSend: {
									targetJid,
									fullMessage: fullMsg,
									relayOptions: retryRelayOptions
								}
							}
						})
					}

					throw error
				}
				if (config.emitOwnEvents) {
					process.nextTick(async () => {
						await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'))
					})
				}

				return fullMsg
			}
		}
	}
}
