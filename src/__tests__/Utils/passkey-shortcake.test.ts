import { proto } from '../../../WAProto/index.js'
import { aesDecryptGCM, sha256 } from '../../Utils/crypto'
import {
	buildEncryptedPairingRequest,
	buildShortcakeProloguePayload,
	linkingBase32,
	decodePrimaryEphemeralIdentity,
	deriveShortcakeVerificationCode,
	SHORTCAKE_GCM_IV_LENGTH,
	SHORTCAKE_NONCE_LENGTH
} from '../../Utils/passkey-shortcake'

describe('passkey shortcake utilities', () => {
	it('builds prologue payload with companion identity and nonce commitment', () => {
		const keyPair = {
			public: Buffer.alloc(32, 1),
			private: Buffer.alloc(32, 2)
		}
		const companionNonce = Buffer.alloc(SHORTCAKE_NONCE_LENGTH, 3)

		const { prologuePayload, companionEphemeralIdentity, commitmentHash, state } = buildShortcakeProloguePayload(
			'test-ref',
			proto.DeviceProps.PlatformType.CHROME,
			{ keyPair, companionNonce }
		)

		const decodedIdentity = proto.CompanionEphemeralIdentity.decode(companionEphemeralIdentity)
		expect(Buffer.from(decodedIdentity.publicKey || [])).toEqual(keyPair.public)
		expect(decodedIdentity.deviceType).toBe(proto.DeviceProps.PlatformType.CHROME)
		expect(decodedIdentity.ref).toBe('test-ref')

		const decodedPayload = proto.ProloguePayload.decode(prologuePayload)
		expect(Buffer.from(decodedPayload.companionEphemeralIdentity || [])).toEqual(companionEphemeralIdentity)
		expect(Buffer.from(decodedPayload.commitment?.hash || [])).toEqual(
			sha256(Buffer.concat([companionEphemeralIdentity, companionNonce]))
		)
		expect(commitmentHash).toEqual(Buffer.from(decodedPayload.commitment?.hash || []))
		expect(state).toMatchObject({ ref: 'test-ref', deviceType: proto.DeviceProps.PlatformType.CHROME })
	})

	it('derives the human verification code with crockford base32', () => {
		const companionNonce = Buffer.alloc(32, 0x11)
		const primaryPublicKey = Buffer.alloc(32, 0x22)
		const primaryNonce = Buffer.alloc(32, 0x33)

		expect(deriveShortcakeVerificationCode(companionNonce, primaryPublicKey, primaryNonce)).toBe('DBXG-9LHT')
		expect(linkingBase32(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x80]))).toBe('111H6ZW1')
	})

	it('decodes and validates primary ephemeral identity', () => {
		const publicKey = Buffer.alloc(32, 4)
		const nonce = Buffer.alloc(32, 5)
		const encoded = proto.PrimaryEphemeralIdentity.encode({ publicKey, nonce }).finish()

		expect(decodePrimaryEphemeralIdentity(encoded)).toEqual({ publicKey, nonce })

		const invalid = proto.PrimaryEphemeralIdentity.encode({ publicKey: Buffer.alloc(31), nonce }).finish()
		expect(() => decodePrimaryEphemeralIdentity(invalid)).toThrow('PrimaryEphemeralIdentity.publicKey must be 32 bytes')
	})

	it('encrypts pairing request as EncryptedPairingRequest', () => {
		const encryptionKey = Buffer.alloc(32, 6)
		const iv = Buffer.alloc(SHORTCAKE_GCM_IV_LENGTH, 7)
		const pairingRequest = {
			companionPublicKey: Buffer.alloc(32, 8),
			companionIdentityKey: Buffer.alloc(32, 9),
			advSecret: Buffer.alloc(32, 10)
		}

		const { encryptedPairingRequest } = buildEncryptedPairingRequest(encryptionKey, pairingRequest, { iv })
		const decoded = proto.EncryptedPairingRequest.decode(encryptedPairingRequest)
		const decrypted = aesDecryptGCM(
			Buffer.from(decoded.encryptedPayload || []),
			encryptionKey,
			Buffer.from(decoded.iv || []),
			Buffer.alloc(0)
		)

		expect(Buffer.from(decoded.iv || [])).toEqual(iv)
		expect(proto.PairingRequest.decode(decrypted).toJSON()).toEqual(proto.PairingRequest.create(pairingRequest).toJSON())
	})
})
