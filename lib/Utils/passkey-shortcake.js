import { randomBytes } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { aesEncryptGCM, Curve, hkdf, hmacSign, sha256 } from './crypto.js';
export const SHORTCAKE_NONCE_LENGTH = 32;
export const SHORTCAKE_VERIFICATION_CODE_LENGTH = 5;
export const SHORTCAKE_ENCRYPTION_KEY_LENGTH = 32;
export const SHORTCAKE_GCM_IV_LENGTH = 12;
export const SHORTCAKE_ENCRYPTION_KEY_INFO = 'Pairing Information Encryption Key';
const LINKING_BASE32_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';
export const PASSKEY_HANDOFF_INFO = 'shortcake-passkey-handoff-v1';
export const buildShortcakeProloguePayload = (ref, deviceType = proto.DeviceProps.PlatformType.CHROME, options = {}) => {
    const keyPair = options.keyPair || Curve.generateKeyPair();
    const companionNonce = options.companionNonce || randomBytes(SHORTCAKE_NONCE_LENGTH);
    if (companionNonce.length !== SHORTCAKE_NONCE_LENGTH) {
        throw new Error(`companion nonce must be ${SHORTCAKE_NONCE_LENGTH} bytes`);
    }
    const companionEphemeralIdentity = proto.CompanionEphemeralIdentity.encode({
        publicKey: keyPair.public,
        deviceType,
        ref
    }).finish();
    const commitmentHash = sha256(Buffer.concat([Buffer.from(companionEphemeralIdentity), companionNonce]));
    const prologuePayload = proto.ProloguePayload.encode({
        companionEphemeralIdentity,
        commitment: {
            hash: commitmentHash
        }
    }).finish();
    return {
        prologuePayload: Buffer.from(prologuePayload),
        companionEphemeralIdentity: Buffer.from(companionEphemeralIdentity),
        commitmentHash,
        state: {
            keyPair,
            companionNonce,
            ref,
            deviceType
        }
    };
};
export const decodePrimaryEphemeralIdentity = (rawIdentity) => {
    const primary = proto.PrimaryEphemeralIdentity.decode(rawIdentity);
    const publicKey = Buffer.from(primary.publicKey || []);
    const nonce = Buffer.from(primary.nonce || []);
    if (publicKey.length !== 32) {
        throw new Error('PrimaryEphemeralIdentity.publicKey must be 32 bytes');
    }
    if (nonce.length !== SHORTCAKE_NONCE_LENGTH) {
        throw new Error(`PrimaryEphemeralIdentity.nonce must be ${SHORTCAKE_NONCE_LENGTH} bytes`);
    }
    return { publicKey, nonce };
};
export const deriveShortcakeVerificationCode = (companionNonce, primaryPublicKey, primaryNonce) => {
    const digest = sha256(Buffer.concat([Buffer.from(companionNonce), Buffer.from(primaryPublicKey)]));
    const code = Buffer.alloc(SHORTCAKE_VERIFICATION_CODE_LENGTH);
    for (let i = 0; i < SHORTCAKE_VERIFICATION_CODE_LENGTH; i++) {
        code[i] = primaryNonce[i] ^ digest[i];
    }
    const encodedCode = linkingBase32(code);
    return `${encodedCode.slice(0, 4)}-${encodedCode.slice(4)}`;
};
export const deriveShortcakeEncryptionKey = (companionPrivateKey, primaryPublicKey, deviceType, ref) => {
    const sharedSecret = Curve.sharedKey(companionPrivateKey, primaryPublicKey);
    const salt = `Companion Pairing ${deviceType} with ref ${ref}`;
    return Buffer.from(hkdf(sharedSecret, SHORTCAKE_ENCRYPTION_KEY_LENGTH, {
        salt: Buffer.from(salt),
        info: SHORTCAKE_ENCRYPTION_KEY_INFO
    }));
};
export const derivePasskeyHandoffKey = (advSecretKey) => Buffer.from(hkdf(advSecretKey, 32, {
    info: PASSKEY_HANDOFF_INFO
}));
export const computePairingHandoffProof = (handoffKey, prologuePayload) => hmacSign(prologuePayload, handoffKey);
export const buildEncryptedPairingRequest = (encryptionKey, pairingRequest, options = {}) => {
    const iv = options.iv || randomBytes(SHORTCAKE_GCM_IV_LENGTH);
    if (iv.length !== SHORTCAKE_GCM_IV_LENGTH) {
        throw new Error(`encrypted pairing request iv must be ${SHORTCAKE_GCM_IV_LENGTH} bytes`);
    }
    const encodedPairingRequest = proto.PairingRequest.encode(pairingRequest).finish();
    const encryptedPayload = aesEncryptGCM(encodedPairingRequest, encryptionKey, iv, Buffer.alloc(0));
    const encryptedPairingRequest = proto.EncryptedPairingRequest.encode({
        encryptedPayload,
        iv
    }).finish();
    return {
        encryptedPairingRequest: Buffer.from(encryptedPairingRequest),
        encryptedPayload,
        iv
    };
};
export const linkingBase32 = (data) => {
    let output = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of data) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            output += LINKING_BASE32_ALPHABET[(buffer >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        output += LINKING_BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
    }
    return output;
};
//# sourceMappingURL=passkey-shortcake.js.map