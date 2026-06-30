import { proto } from '../../WAProto/index.js';
import type { KeyPair } from '../Types/index.js';
export declare const SHORTCAKE_NONCE_LENGTH = 32;
export declare const SHORTCAKE_VERIFICATION_CODE_LENGTH = 5;
export declare const SHORTCAKE_ENCRYPTION_KEY_LENGTH = 32;
export declare const SHORTCAKE_GCM_IV_LENGTH = 12;
export declare const SHORTCAKE_ENCRYPTION_KEY_INFO = "Pairing Information Encryption Key";
export declare const PASSKEY_HANDOFF_INFO = "shortcake-passkey-handoff-v1";
export type ShortcakeLinkingState = {
    keyPair: KeyPair;
    companionNonce: Buffer;
    ref: string;
    deviceType: proto.DeviceProps.PlatformType;
    bridgeId?: string;
    encryptionKey?: Buffer;
    skipHandoffUX?: boolean;
};
export type BuildShortcakeProloguePayloadOptions = {
    keyPair?: KeyPair;
    companionNonce?: Buffer;
};
export declare const buildShortcakeProloguePayload: (ref: string, deviceType?: proto.DeviceProps.PlatformType, options?: BuildShortcakeProloguePayloadOptions) => {
    prologuePayload: Buffer<ArrayBuffer>;
    companionEphemeralIdentity: Buffer<ArrayBuffer>;
    commitmentHash: Buffer<ArrayBufferLike>;
    state: {
        keyPair: KeyPair;
        companionNonce: Buffer<ArrayBufferLike>;
        ref: string;
        deviceType: proto.DeviceProps.PlatformType;
    };
};
export declare const decodePrimaryEphemeralIdentity: (rawIdentity: Buffer | Uint8Array) => {
    publicKey: Buffer<ArrayBuffer>;
    nonce: Buffer<ArrayBuffer>;
};
export declare const deriveShortcakeVerificationCode: (companionNonce: Buffer | Uint8Array, primaryPublicKey: Buffer | Uint8Array, primaryNonce: Buffer | Uint8Array) => string;
export declare const deriveShortcakeEncryptionKey: (companionPrivateKey: Buffer | Uint8Array, primaryPublicKey: Buffer | Uint8Array, deviceType: proto.DeviceProps.PlatformType, ref: string) => Buffer<ArrayBuffer>;
export declare const derivePasskeyHandoffKey: (advSecretKey: Buffer | Uint8Array) => Buffer<ArrayBuffer>;
export declare const computePairingHandoffProof: (handoffKey: Buffer | Uint8Array, prologuePayload: Buffer | Uint8Array) => Buffer<ArrayBufferLike>;
export type BuildEncryptedPairingRequestOptions = {
    iv?: Buffer;
};
export declare const buildEncryptedPairingRequest: (encryptionKey: Buffer | Uint8Array, pairingRequest: proto.IPairingRequest, options?: BuildEncryptedPairingRequestOptions) => {
    encryptedPairingRequest: Buffer<ArrayBuffer>;
    encryptedPayload: Buffer<ArrayBuffer>;
    iv: Buffer<ArrayBufferLike>;
};
export declare const linkingBase32: (data: Buffer | Uint8Array) => string;
//# sourceMappingURL=passkey-shortcake.d.ts.map