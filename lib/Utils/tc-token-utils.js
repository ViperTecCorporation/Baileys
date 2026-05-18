import { getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidNormalizedUser } from '../WABinary/index.js';
/** 7 days in seconds — matches WA Web AB prop tctoken_duration */
const TC_TOKEN_BUCKET_DURATION = 604800;
/** 4 buckets → ~28-day rolling window — matches WA Web AB prop tctoken_num_buckets */
const TC_TOKEN_NUM_BUCKETS = 4;
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
export function isTcTokenExpired(timestamp) {
    if (timestamp === null || timestamp === undefined)
        return true;
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
    if (isNaN(ts))
        return true;
    const now = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION);
    const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1);
    const cutoffTimestamp = cutoffBucket * TC_TOKEN_BUCKET_DURATION;
    return ts < cutoffTimestamp;
}
/**
 * Check if we should issue a new token to this contact (bucket boundary crossed).
 * Reference: WAWebTrustedContactsUtils.shouldSendNewToken
 *
 * Returns true if senderTimestamp is null/undefined or in a previous bucket.
 */
export function shouldSendNewTcToken(senderTimestamp) {
    if (senderTimestamp === undefined)
        return true;
    const now = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION);
    const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION);
    return currentBucket > senderBucket;
}
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
export async function resolveTcTokenJid(jid, getLIDForPN) {
    if (isLidUser(jid))
        return jid;
    const lid = await getLIDForPN(jid);
    return lid ?? jid;
}
/** Resolve target JID for issuing privacy token based on AB prop 14303 */
export async function resolveIssuanceJid(jid, issueToLid, getLIDForPN, getPNForLID) {
    if (issueToLid) {
        if (isLidUser(jid))
            return jid;
        const lid = await getLIDForPN(jid);
        return lid ?? jid;
    }
    if (!isLidUser(jid))
        return jid;
    if (getPNForLID) {
        const pn = await getPNForLID(jid);
        return pn ?? jid;
    }
    return jid;
}
export async function buildTcTokenFromJid({ authState, jid, baseContent = [], getLIDForPN }) {
    try {
        const storageJid = getLIDForPN ? await resolveTcTokenJid(jid, getLIDForPN) : jid;
        const tcTokenData = await authState.keys.get('tctoken', [storageJid]);
        const entry = tcTokenData?.[storageJid];
        const tcTokenBuffer = entry?.token;
        if (!tcTokenBuffer?.length || isTcTokenExpired(entry?.timestamp)) {
            // Opportunistic cleanup: remove expired token from store
            if (tcTokenBuffer) {
                await authState.keys.set({ tctoken: { [storageJid]: null } });
            }
            return baseContent.length > 0 ? baseContent : undefined;
        }
        baseContent.push({
            tag: 'tctoken',
            attrs: {},
            content: tcTokenBuffer
        });
        return baseContent;
    }
    catch (error) {
        return baseContent.length > 0 ? baseContent : undefined;
    }
}
/**
 * Parse and store tctoken(s) from an IQ result node.
 * Includes timestamp monotonicity guard matching WA Web's handleIncomingTcToken.
 * Used by both the blocking fetch (messages-send) and IQ response (messages-recv) paths.
 */
export async function storeTcTokensFromIqResult({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }) {
    const tokensNode = getBinaryNodeChild(result, 'tokens');
    if (!tokensNode)
        return;
    const tokenNodes = getBinaryNodeChildren(tokensNode, 'token');
    for (const tokenNode of tokenNodes) {
        if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) {
            continue;
        }
        const rawJid = jidNormalizedUser(tokenNode.attrs.jid || fallbackJid);
        const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN);
        const existingTcData = await keys.get('tctoken', [storageJid]);
        const existingEntry = existingTcData[storageJid];
        // Timestamp monotonicity guard — only store if incoming timestamp >= existing
        // Matches WA Web handleIncomingTcToken
        const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0;
        const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0;
        if (existingTs > 0 && incomingTs > 0 && existingTs > incomingTs) {
            continue;
        }
        // Don't overwrite a valid timestamped token with a timestamp-less one —
        // it would be treated as immediately expired by isTcTokenExpired
        if (existingTs > 0 && !incomingTs) {
            continue;
        }
        await keys.set({
            tctoken: {
                [storageJid]: {
                    ...existingEntry,
                    token: Buffer.from(tokenNode.content),
                    timestamp: tokenNode.attrs.t
                }
            }
        });
        onNewJidStored?.(storageJid);
    }
}
//# sourceMappingURL=tc-token-utils.js.map