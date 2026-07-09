import type { USyncQueryProtocol } from '../../Types/USync.js';
import { type BinaryNode } from '../../WABinary/index.js';
import { USyncUser } from '../USyncUser.js';
export type USyncContactProtocolResult = {
    type: string | undefined;
    jid: string | undefined;
    lid: string | undefined;
    phoneNumber: string | undefined;
    username: string | undefined;
};
export declare class USyncContactProtocol implements USyncQueryProtocol {
    name: string;
    getQueryElement(): BinaryNode;
    getUserElement(user: USyncUser): BinaryNode;
    parser(node: BinaryNode): USyncContactProtocolResult | null;
}
//# sourceMappingURL=USyncContactProtocol.d.ts.map