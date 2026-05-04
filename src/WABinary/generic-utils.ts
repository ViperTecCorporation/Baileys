import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { type BinaryNode } from './types'

// some extra useful utilities

const indexCache = new WeakMap<BinaryNode, Map<string, BinaryNode[]>>()

export const getBinaryNodeChildren = (node: BinaryNode | undefined, childTag: string) => {
	if (!node || !Array.isArray(node.content)) return []

	let index = indexCache.get(node)

	// Build the index once per node
	if (!index) {
		index = new Map<string, BinaryNode[]>()

		for (const child of node.content) {
			let arr = index.get(child.tag)
			if (!arr) index.set(child.tag, (arr = []))
			arr.push(child)
		}

		indexCache.set(node, index)
	}

	// Return first matching child
	return index.get(childTag) || []
}

export const getBinaryNodeChild = (node: BinaryNode | undefined, childTag: string) => {
	return getBinaryNodeChildren(node, childTag)[0]
}

export const getAllBinaryNodeChildren = ({ content }: BinaryNode) => {
	if (Array.isArray(content)) {
		return content
	}

	return []
}

export const getBinaryNodeChildBuffer = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
		return child
	}
}

export const getBinaryNodeChildString = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
		return Buffer.from(child).toString('utf-8')
	} else if (typeof child === 'string') {
		return child
	}
}

export const getBinaryNodeChildUInt = (node: BinaryNode, childTag: string, length: number) => {
	const buff = getBinaryNodeChildBuffer(node, childTag)
	if (buff) {
		return bufferToUInt(buff, length)
	}
}

export const assertNodeErrorFree = (node: BinaryNode) => {
	const errNode = getBinaryNodeChild(node, 'error')
	if (errNode) {
		throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code! })
	}
}

export const reduceBinaryNodeToDictionary = (node: BinaryNode, tag: string) => {
	const nodes = getBinaryNodeChildren(node, tag)
	const dict = nodes.reduce(
		(dict, { attrs }) => {
			if (typeof attrs.name === 'string') {
				dict[attrs.name] = attrs.value! || attrs.config_value!
			} else {
				dict[attrs.config_code!] = attrs.value! || attrs.config_value!
			}

			return dict
		},
		{} as { [_: string]: string }
	)
	return dict
}

export const getBinaryNodeMessages = ({ content }: BinaryNode) => {
	const msgs: proto.WebMessageInfo[] = []
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item.tag === 'message') {
				msgs.push(proto.WebMessageInfo.decode(item.content as Buffer).toJSON() as proto.WebMessageInfo)
			}
		}
	}

	return msgs
}

function bufferToUInt(e: Uint8Array | Buffer, t: number) {
	let a = 0
	for (let i = 0; i < t; i++) {
		a = 256 * a + e[i]!
	}

	return a
}

const tabs = (n: number) => '\t'.repeat(n)

export function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i = 0): string {
	if (!node) {
		return node!
	}

	if (typeof node === 'string') {
		return tabs(i) + node
	}

	if (node instanceof Uint8Array) {
		return tabs(i) + Buffer.from(node).toString('hex')
	}

	if (Array.isArray(node)) {
		return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n')
	}

	const children = binaryNodeToString(node.content, i + 1)

	const tag = `<${node.tag} ${Object.entries(node.attrs || {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}='${v}'`)
		.join(' ')}`

	const content: string = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>'

	return tag + content
}

const INTERACTIVE_FLOW_NAMES = new Set([
	'mpm',
	'cta_catalog',
	'send_location',
	'call_permission_request',
	'wa_payment_transaction_details',
	'automated_greeting_message_view_catalog'
])

const decisionSourceContent: BinaryNode[] = [{ tag: 'decision_source', attrs: { value: 'df' } }]

const mixedNativeFlowNode: BinaryNode = {
	tag: 'interactive',
	attrs: { type: 'native_flow', v: '1' },
	content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
}

const qualityControlNode = (): BinaryNode => ({
	tag: 'quality_control',
	attrs: {
		decision_id: randomBytes(20).toString('hex'),
		source_type: 'third_party'
	},
	content: decisionSourceContent
})

export const shouldIncludeBizBinaryNode = (message: proto.IMessage) => {
	const innerMessage = message.documentWithCaptionMessage?.message || message
	const interactiveMessage = innerMessage.interactiveMessage

	return !!(
		innerMessage.buttonsMessage ||
		innerMessage.listMessage ||
		innerMessage.templateMessage ||
		interactiveMessage?.nativeFlowMessage ||
		interactiveMessage?.carouselMessage
	)
}

export const getBizBinaryNode = (message: proto.IMessage): BinaryNode => {
	const innerMessage = message.documentWithCaptionMessage?.message || message
	const flowMessage = innerMessage.interactiveMessage?.nativeFlowMessage
	const firstButtonName = flowMessage?.buttons?.[0]?.name
	const qualityContent = qualityControlNode()

	if (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info') {
		return {
			tag: 'biz',
			attrs: {
				native_flow_name: firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
			},
			content: [qualityContent]
		}
	}

	if (firstButtonName && INTERACTIVE_FLOW_NAMES.has(firstButtonName)) {
		return {
			tag: 'biz',
			attrs: {},
			content: [
				{
					tag: 'interactive',
					attrs: { type: 'native_flow', v: '1' },
					content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }]
				},
				qualityContent
			]
		}
	}

	if (innerMessage.listMessage) {
		const listType =
			innerMessage.listMessage.listType === proto.Message.ListMessage.ListType.SINGLE_SELECT
				? 'single_select'
				: 'product_list'

		return {
			tag: 'biz',
			attrs: {},
			content: [{ tag: 'list', attrs: { type: listType, v: '2' } }, qualityContent]
		}
	}

	return {
		tag: 'biz',
		attrs: {},
		content: [mixedNativeFlowNode, qualityContent]
	}
}
