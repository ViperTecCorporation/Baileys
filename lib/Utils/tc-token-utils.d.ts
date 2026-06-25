import type { SignalKeyStoreWithTransaction } from '../Types/index.js';
import type { BinaryNode } from '../WABinary/index.js';
/**
 * Check if a received token is expired using WA Web's rolling bucket algorithm.
 * Reference: WAWebTrustedContactsUtils.isTokenExpired
 *
 * Uses Receiver mode constants (tctoken_duration, tctoken_num_buckets).
 * NOTE: WA Web distinguishes Sender vs Receiver mode via AB props
 * (tctoken_duration_sender / tctoken_num_buckets_sender). Currently both
 * use identical values (604800 / 4), so we use a single function for both.
 * If WA ever diverges these, add a `mode` parameter here.
 */
export declare function isTcTokenExpired(timestamp: number | string | null | undefined): boolean;
/**
 * Check if we should issue a new token to this contact (bucket boundary crossed).
 * Reference: WAWebTrustedContactsUtils.shouldSendNewToken
 *
 * Returns true if senderTimestamp is null/undefined or in a previous bucket.
 */
export declare function shouldSendNewTcToken(senderTimestamp: number | undefined): boolean;
/**
 * Resolve a JID to its LID for tctoken storage, mirroring how Signal sessions
 * use LID keys via resolveLIDSignalAddress.
 *
 * WA Web always resolves to LID before storing/looking up tctokens:
 * `senderLid ?? toLid(from)` (WAWebSetTcTokenChatAction.handleIncomingTcToken)
 *
 * @param jid - The JID to resolve (can be PN or LID)
 * @param getLIDForPN - Resolver function (from lidMapping)
 * @returns The LID if mapping exists, otherwise the original JID
 */
export declare function resolveTcTokenJid(jid: string, getLIDForPN: (pn: string) => Promise<string | null>): Promise<string>;
/** Resolve target JID for issuing privacy token based on AB prop 14303 */
export declare function resolveIssuanceJid(jid: string, issueToLid: boolean, getLIDForPN: (pn: string) => Promise<string | null>, getPNForLID?: (lid: string) => Promise<string | null>): Promise<string>;
type TcTokenParams = {
    jid: string;
    baseContent?: BinaryNode[];
    authState: {
        keys: SignalKeyStoreWithTransaction;
    };
    getLIDForPN?: (pn: string) => Promise<string | null>;
};
type CsTokenParams = {
    baseContent?: BinaryNode[];
    authState: {
        keys: SignalKeyStoreWithTransaction;
    };
    meLid?: string;
};
export declare function buildTcTokenFromJid({ authState, jid, baseContent, getLIDForPN }: TcTokenParams): Promise<BinaryNode[] | undefined>;
export declare function storeNctSalt(keys: SignalKeyStoreWithTransaction, salt: Uint8Array | Buffer | null | undefined): Promise<void>;
export declare function buildCsTokenFromStoredSalt({ authState, meLid, baseContent }: CsTokenParams): Promise<BinaryNode[] | undefined>;
type StoreTcTokensParams = {
    result: BinaryNode;
    fallbackJid: string;
    keys: SignalKeyStoreWithTransaction;
    getLIDForPN: (pn: string) => Promise<string | null>;
    /** Optional callback when a new JID is stored (for index tracking) */
    onNewJidStored?: (jid: string) => void;
};
/**
 * Parse and store tctoken(s) from an IQ result node.
 * Includes timestamp monotonicity guard matching WA Web's handleIncomingTcToken.
 * Used by both the blocking fetch (messages-send) and IQ response (messages-recv) paths.
 */
export declare function storeTcTokensFromIqResult({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }: StoreTcTokensParams): Promise<void>;
export {};
//# sourceMappingURL=tc-token-utils.d.ts.map