import type { ILogger } from '../Utils/logger'
import {
	type BinaryNode,
	getBinaryNodeChild,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser
} from '../WABinary'
import { BinaryInfo } from './BinaryInfo'
import { encodeWAM } from './encode'

type WamProps = Record<string, number | string | null>
type SendWAMBuffer = (wamBuffer: Buffer) => Promise<unknown>

export type WamTelemetryOptions = {
	enabled?: boolean
	debugEvents?: boolean
	flushIntervalMs?: number
	maxEvents?: number
}

type TrackedSend = {
	destination: number
	messageType: number
	isLid: number
	isGroup: boolean
	ciphertextType?: number
	mediaType?: number
	editType?: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_MAX_EVENTS = 50
const HIGH_RETRY_THRESHOLD = 5

const CIPHERTEXT_TYPES: Record<string, number> = {
	msg: 0,
	pkmsg: 1,
	skmsg: 2,
	msmsg: 3
}

const MEDIA_TYPES: Record<string, number> = {
	'': 1,
	image: 2,
	video: 3,
	audio: 4,
	ptt: 5,
	location: 6,
	contact: 7,
	document: 8,
	url: 9,
	call: 10,
	gif: 11,
	sticker: 16,
	'md-app-state': 20,
	'md-msg-hist': 21,
	list: 25,
	'list-reply': 26,
	buttons: 27,
	'buttons-response': 28,
	reaction: 34,
	poll: 37
}

const EDIT_TYPES: Record<string, number> = {
	'': 0,
	'1': 1,
	'2': 2,
	'3': 3,
	edit: 1,
	sender_revoke: 2,
	admin_revoke: 3,
	admin_edit: 4,
	pin: 5
}

const HISTORY_SYNC_TYPES: Record<number, number> = {
	0: 1,
	1: 3,
	2: 2,
	3: 4,
	4: 7,
	5: 6,
	6: 5
}

const envFlag = (name: string) => {
	const value = `${process.env[name] || ''}`.trim().toLowerCase()
	return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

const envNumber = (name: string, fallback: number) => {
	const parsed = Number(process.env[name])
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const asEvent = (name: string, props: WamProps) =>
	({
		[name]: {
			props,
			globals: {}
		}
	}) as any

const childNodes = (node: BinaryNode | undefined): BinaryNode[] =>
	node && Array.isArray(node.content) ? (node.content as BinaryNode[]) : []

const firstEncNode = (node: BinaryNode): BinaryNode | undefined => {
	if (node.tag === 'enc') {
		return node
	}

	for (const child of childNodes(node)) {
		const found = firstEncNode(child)
		if (found) {
			return found
		}
	}

	return undefined
}

const destinationType = (jid = '') => {
	if (isJidNewsletter(jid)) {
		return 4
	}

	if (isJidStatusBroadcast(jid)) {
		return 3
	}

	if (isJidGroup(jid)) {
		return 1
	}

	return 0
}

const receiptMessageType = (jid = '') => {
	if (isJidNewsletter(jid)) {
		return 5
	}

	if (isJidStatusBroadcast(jid)) {
		return 4
	}

	if (isJidGroup(jid)) {
		return 2
	}

	return 1
}

const mediaType = (value?: string) => MEDIA_TYPES[`${value || ''}`] ?? 1
const ciphertextType = (value?: string) => CIPHERTEXT_TYPES[`${value || ''}`] ?? undefined
const editType = (value?: string) => EDIT_TYPES[`${value || ''}`] ?? undefined

const messageIdsFromReceipt = (node: BinaryNode) => {
	const ids = new Set<string>()
	if (node.attrs.id) {
		ids.add(node.attrs.id)
	}

	const list = getBinaryNodeChild(node, 'list')
	for (const item of childNodes(list as BinaryNode)) {
		if (item.tag === 'item' && item.attrs.id) {
			ids.add(item.attrs.id)
		}
	}

	return ids.size || 1
}

export const resolveWamTelemetryOptions = (options?: WamTelemetryOptions): Required<WamTelemetryOptions> => ({
	enabled: options?.enabled ?? envFlag('BAILEYS_WAM_TELEMETRY'),
	debugEvents: options?.debugEvents ?? envFlag('BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS'),
	flushIntervalMs: options?.flushIntervalMs ?? envNumber('BAILEYS_WAM_TELEMETRY_FLUSH_MS', DEFAULT_FLUSH_INTERVAL_MS),
	maxEvents: options?.maxEvents ?? envNumber('BAILEYS_WAM_TELEMETRY_MAX_EVENTS', DEFAULT_MAX_EVENTS)
})

export class WamTelemetry {
	private readonly enabled: boolean
	private readonly debugEvents: boolean
	private readonly flushIntervalMs: number
	private readonly maxEvents: number
	private readonly sentMessages = new Map<string, TrackedSend>()
	private timer: ReturnType<typeof setTimeout> | undefined
	private flushing = false
	private streamMode: number | undefined
	private connectedOnce = false
	private resumeCount = 0

	constructor(
		private readonly buffer: BinaryInfo,
		private readonly sendWAMBuffer: SendWAMBuffer,
		private readonly logger: ILogger,
		options?: WamTelemetryOptions
	) {
		const resolved = resolveWamTelemetryOptions(options)
		this.enabled = resolved.enabled
		this.debugEvents = resolved.debugEvents
		this.flushIntervalMs = resolved.flushIntervalMs
		this.maxEvents = resolved.maxEvents
		if (this.enabled) {
			this.logger.info({ flushIntervalMs: this.flushIntervalMs, maxEvents: this.maxEvents }, 'WAM_TELEMETRY_ENABLED')
		}
	}

	get isEnabled() {
		return this.enabled
	}

	commit(name: string, props: WamProps = {}) {
		if (!this.enabled) {
			return
		}

		this.buffer.events.push(asEvent(name, props))
		if (this.debugEvents) {
			this.logger.debug({ event: name, props }, 'WAM_TELEMETRY_COMMIT')
		}

		if (this.buffer.events.length >= this.maxEvents) {
			void this.flush()
			return
		}

		this.scheduleFlush()
	}

	onConnectionOpen() {
		this.commit('WebcSocketConnect', { webcSocketConnectReason: this.connectedOnce ? 1 : 0 })
		this.setStreamMode(2)
		if (this.connectedOnce) {
			this.resumeCount += 1
			this.commit('WebcPageResume', { webcResumeCount: this.resumeCount })
		}

		this.connectedOnce = true
	}

	onConnectionClose() {
		this.setStreamMode(3)
		void this.flush()
		this.dispose()
	}

	onOfflineComplete() {
		this.setStreamMode(1)
	}

	onNodeOut(node: BinaryNode) {
		if (!this.enabled || node.tag !== 'message') {
			return
		}

		const enc = firstEncNode(node)
		if (!enc) {
			return
		}

		const to = node.attrs.to || ''
		const destination = destinationType(to)
		const msgType = receiptMessageType(to)
		const isLid = isLidUser(to) || node.attrs.addressing_mode === 'lid' ? 1 : 0
		const isGroup = !!isJidGroup(to)
		const ctype = ciphertextType(enc.attrs.type)
		const mtype = mediaType(enc.attrs.mediatype)
		const version = Number(enc.attrs.v)
		const count = Number(enc.attrs.count)
		const props: WamProps = {
			e2eSuccessful: 1,
			e2eDestination: destination,
			isLid
		}

		if (ctype !== undefined) {
			props.e2eCiphertextType = ctype
		}
		if (Number.isFinite(version)) {
			props.e2eCiphertextVersion = version
		}
		if (mtype !== 1) {
			props.messageMediaType = mtype
		}
		if (Number.isFinite(count)) {
			props.retryCount = count
		}
		if (isGroup) {
			props.typeOfGroup = 1
		}

		this.commit('E2eMessageSend', props)
		this.commit('WebcMessageSend', {
			messageType: msgType,
			...(mtype !== 1 ? { messageMediaType: mtype } : {})
		})

		if (node.attrs.id) {
			this.trackSend(node.attrs.id, {
				destination,
				messageType: msgType,
				isLid,
				isGroup,
				ciphertextType: ctype,
				mediaType: mtype,
				editType: editType(node.attrs.edit)
			})
		}
	}

	onNodeIn(node: BinaryNode, handled: boolean) {
		if (!this.enabled) {
			return
		}

		if (node.tag === 'message') {
			this.onIncomingMessage(node)
			return
		}

		if (node.tag === 'receipt') {
			this.onIncomingReceipt(node)
			return
		}

		if (node.tag === 'ack' && node.attrs.class === 'message') {
			this.onIncomingAck(node)
			return
		}

		if (node.tag === 'ack') {
			return
		}

		if (!handled) {
			this.commit('UnknownStanza', {
				unknownStanzaTag: node.tag,
				...(node.attrs.type ? { unknownStanzaType: node.attrs.type } : {})
			})
		}
	}

	onHistorySync(syncType?: number, progress?: number) {
		if (!this.enabled) {
			return
		}

		this.commit('MdBootstrapHistoryDataReceived', {
			mdBootstrapHistoryPayloadType: typeof syncType === 'number' ? HISTORY_SYNC_TYPES[syncType] || 6 : 6,
			mdBootstrapPayloadType: 2,
			mdTimestamp: Math.round(Date.now() / 1000),
			...(typeof progress === 'number' ? { historySyncStageProgress: progress } : {})
		})
	}

	async flush() {
		if (!this.enabled || this.flushing || this.buffer.events.length === 0) {
			return
		}

		this.flushing = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}

		const eventCount = this.buffer.events.length
		try {
			const encoded = encodeWAM(this.buffer)
			this.buffer.events = []
			this.buffer.sequence += 1
			this.logger.debug({ eventCount, bytes: encoded.length }, 'WAM_TELEMETRY_FLUSH')
			await this.sendWAMBuffer(encoded)
			this.logger.debug({ eventCount }, 'WAM_TELEMETRY_SEND_OK')
		} catch (error) {
			this.logger.debug({ error, eventCount }, 'WAM_TELEMETRY_SEND_ERROR')
		} finally {
			this.flushing = false
			if (this.buffer.events.length > 0) {
				this.scheduleFlush()
			}
		}
	}

	dispose() {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}

	private onIncomingMessage(node: BinaryNode) {
		const enc = firstEncNode(node)
		const from = node.attrs.from || node.attrs.participant || ''
		const destination = destinationType(from)
		const isLid = isLidUser(from) || node.attrs.addressing_mode === 'lid' ? 1 : 0
		const mtype = mediaType(enc?.attrs.mediatype)
		const ctype = ciphertextType(enc?.attrs.type)
		const version = Number(enc?.attrs.v)
		const count = Number(enc?.attrs.count)
		const props: WamProps = {
			e2eSuccessful: 1,
			e2eDestination: destination,
			isLid,
			offline: node.attrs.offline ? 1 : 0
		}

		if (ctype !== undefined) {
			props.e2eCiphertextType = ctype
		}
		if (Number.isFinite(version)) {
			props.e2eCiphertextVersion = version
		}
		if (mtype !== 1) {
			props.messageMediaType = mtype
		}
		if (Number.isFinite(count)) {
			props.retryCount = count
		}
		if (isJidGroup(from)) {
			props.typeOfGroup = 1
		}

		if (enc) {
			this.commit('E2eMessageRecv', props)
		}

		this.commit('MessageReceive', {
			messageType: receiptMessageType(from),
			isLid,
			messageIsOffline: node.attrs.offline ? 1 : 0,
			...(mtype !== 1 ? { messageMediaType: mtype } : {}),
			...(isJidGroup(from) ? { typeOfGroup: 1 } : {})
		})
	}

	private onIncomingReceipt(node: BinaryNode) {
		this.commit('ReceiptStanzaReceive', {
			receiptStanzaType: node.attrs.type || '',
			receiptStanzaTotalCount: messageIdsFromReceipt(node)
		})

		const retry = getBinaryNodeChild(node, 'retry')
		const retryCount = Number(retry?.attrs.count)
		if (Number.isFinite(retryCount) && retryCount >= HIGH_RETRY_THRESHOLD) {
		this.commit('MessageHighRetryCount', {
			retryCount,
			messageType: receiptMessageType(node.attrs.from || ''),
			isSenderLidBased: node.attrs.is_lid === 'true' || isLidUser(node.attrs.from || '') ? 1 : 0
		})
		}
	}

	private onIncomingAck(node: BinaryNode) {
		const id = node.attrs.id
		if (!id) {
			return
		}

		const info = this.sentMessages.get(id)
		if (!info) {
			return
		}

		this.sentMessages.delete(id)
		this.commit('MessageSend', {
			messageSendResult: node.attrs.error ? 3 : 1,
			messageType: info.messageType,
			isLid: info.isLid,
			...(info.ciphertextType !== undefined ? { e2eCiphertextType: info.ciphertextType } : {}),
			...(info.mediaType !== undefined && info.mediaType !== 1 ? { messageMediaType: info.mediaType } : {}),
			...(info.isGroup ? { typeOfGroup: 1 } : {})
		})
	}

	private setStreamMode(mode: number) {
		if (this.streamMode === mode) {
			return
		}

		this.streamMode = mode
		this.commit('WebcStreamModeChange', { webcStreamMode: mode })
	}

	private scheduleFlush() {
		if (this.timer) {
			return
		}

		this.timer = setTimeout(() => {
			this.timer = undefined
			void this.flush()
		}, this.flushIntervalMs)
	}

	private trackSend(id: string, info: TrackedSend) {
		if (this.sentMessages.size >= 256) {
			const oldest = this.sentMessages.keys().next().value
			if (oldest) {
				this.sentMessages.delete(oldest)
			}
		}

		this.sentMessages.set(id, info)
	}
}
