import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { USyncUser } from '../USyncUser'

export type USyncContactProtocolResult = {
	type: string | undefined
	jid: string | undefined
	lid: string | undefined
	phoneNumber: string | undefined
	username: string | undefined
}

export class USyncContactProtocol implements USyncQueryProtocol {
	name = 'contact'

	getQueryElement(): BinaryNode {
		return {
			tag: 'contact',
			attrs: {}
		}
	}

	getUserElement(user: USyncUser): BinaryNode {
		if (user.phone) {
			return {
				tag: 'contact',
				attrs: {},
				content: user.phone
			}
		}

		if (user.username) {
			return {
				tag: 'contact',
				attrs: {
					username: user.username,
					...(user.usernameKey ? { pin: user.usernameKey } : {}),
					...(user.lid ? { lid: user.lid } : {})
				}
			}
		}

		if (user.type) {
			return {
				tag: 'contact',
				attrs: {
					type: user.type
				}
			}
		}

		return {
			tag: 'contact',
			attrs: {}
		}
	}

	parser(node: BinaryNode): USyncContactProtocolResult | null {
		if (node.tag === 'contact') {
			assertNodeErrorFree(node)
			return {
				type: node.attrs.type,
				jid: node.attrs.jid,
				lid: node.attrs.lid,
				phoneNumber: node.attrs.phone_number,
				username: node.attrs.username
			}
		}

		return null
	}
}
