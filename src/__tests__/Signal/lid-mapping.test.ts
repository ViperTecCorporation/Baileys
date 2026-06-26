import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

const mockKeys: jest.Mocked<SignalKeyStoreWithTransaction> = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
	isolatedTransaction: jest.fn<NonNullable<SignalKeyStoreWithTransaction['isolatedTransaction']>>(
		async (work: () => any) => await work()
	) as any,
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`12345_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping']) // Simulate not found in DB

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})
	})

	describe('getLIDsForPNs', () => {
		it('force refreshes a PN mapping through USync instead of using cache or storage', async () => {
			const pn = '12345678900@s.whatsapp.net'
			const oldLid = '11111111111111@lid'
			const newLid = '22222222222222@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping'])

			await lidMappingStore.storeLIDPNMappings([{ pn: pn, lid: oldLid }])

			jest.clearAllMocks()
			mockPnToLIDFunc.mockResolvedValue([{ pn: pn, lid: newLid }])

			const result = await lidMappingStore.getLIDsForPNs([ pn ], { force: true })

			expect(mockKeys.get).not.toHaveBeenCalled()
			expect(mockPnToLIDFunc).toHaveBeenCalledWith([ pn ])
			expect(mockKeys.set).toHaveBeenCalledWith({
				'lid-mapping': {
					'12345678900': '22222222222222',
					'22222222222222_reverse': '12345678900'
				}
			})
			expect(result).toEqual([{ pn: pn, lid: newLid }])
		})

		it('invalidates a stale PN and LID mapping before later lookups', async () => {
			const pn = '12345678900@s.whatsapp.net'
			const oldLid = '11111111111111@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping'])

			await lidMappingStore.storeLIDPNMappings([{ pn: pn, lid: oldLid }])

			jest.clearAllMocks()
			mockPnToLIDFunc.mockResolvedValue(undefined)

			await lidMappingStore.invalidateLIDPNMapping(pn, oldLid)
			const result = await lidMappingStore.getLIDsForPNs([pn])

			expect(mockKeys.set).toHaveBeenCalledWith({
				'lid-mapping': {
					'12345678900': null,
					'11111111111111_reverse': null
				}
			})
			expect(mockPnToLIDFunc).toHaveBeenCalledWith([pn])
			expect(result).toBeNull()
		})
	})

	describe('getKnownLIDForPN', () => {
		it('returns a stored LID without triggering USync', async () => {
			const pn = '12345678900@s.whatsapp.net'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ '12345678900': '22222222222222' } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getKnownLIDForPN(pn)

			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
			expect(result).toBe('22222222222222@lid')
		})

		it('ignores invalid stored LID values', async () => {
			const pn = '12345678900@s.whatsapp.net'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ '12345678900': {} } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getKnownLIDForPN(pn)

			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
			expect(result).toBeNull()
		})
	})
})
