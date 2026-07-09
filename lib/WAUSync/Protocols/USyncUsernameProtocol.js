import { assertNodeErrorFree } from '../../WABinary/index.js';
import { USyncUser } from '../USyncUser.js';
export class USyncUsernameProtocol {
    constructor() {
        this.name = 'username';
    }
    getQueryElement() {
        return {
            tag: 'username',
            attrs: {}
        };
    }
    getUserElement(user) {
        void user;
        return {
            tag: 'username',
            attrs: {}
        };
    }
    parser(node) {
        if (node.tag === 'username') {
            assertNodeErrorFree(node);
            if (typeof node.content === 'string') {
                return node.content;
            }
            if (node.content instanceof Uint8Array) {
                return new TextDecoder().decode(node.content);
            }
        }
        return null;
    }
}
//# sourceMappingURL=USyncUsernameProtocol.js.map