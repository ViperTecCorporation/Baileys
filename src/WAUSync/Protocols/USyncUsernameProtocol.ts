import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { USyncUser } from '../USyncUser'

export class USyncUsernameProtocol implements USyncQueryProtocol {
	name = 'username'

	getQueryElement(): BinaryNode {
		return {
			tag: 'username',
			attrs: {}
		}
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		void user
		return {
			tag: 'username',
			attrs: {}
		}
	}

	parser(node: BinaryNode): string | null {
		if (node.tag === 'username') {
			assertNodeErrorFree(node)
			if (typeof node.content === 'string') {
				return node.content
			}

			if (node.content instanceof Uint8Array) {
				return new TextDecoder().decode(node.content)
			}
		}

		return null
	}
}
