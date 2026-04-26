import { proto } from '../../../WAProto'
import { generateWAMessageContent } from '../../Utils/messages'

describe('list message rendering metadata', () => {
	it('defaults section lists to PRODUCT_LIST so the send path emits product_list biz metadata', async () => {
		const message = await generateWAMessageContent(
			{
				text: 'Choose an option',
				buttonText: 'Open',
				sections: [
					{
						title: 'Options',
						rows: [{ title: 'First', rowId: 'first' }]
					}
				]
			},
			{} as never
		)

		expect(message.listMessage?.listType).toBe(proto.Message.ListMessage.ListType.PRODUCT_LIST)
	})

	it('keeps an explicit listType override when callers provide one', async () => {
		const message = await generateWAMessageContent(
			{
				text: 'Choose an option',
				buttonText: 'Open',
				listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
				sections: [
					{
						title: 'Options',
						rows: [{ title: 'First', rowId: 'first' }]
					}
				]
			},
			{} as never
		)

		expect(message.listMessage?.listType).toBe(proto.Message.ListMessage.ListType.SINGLE_SELECT)
	})

	it('generates native carousel content as a direct interactiveMessage', async () => {
		const message = await generateWAMessageContent(
			{
				text: 'Featured items',
				nativeCarousel: {
					cards: [
						{
							title: 'First',
							body: 'First item',
							buttons: [{ type: 'reply', text: 'Choose', id: 'first' }]
						},
						{
							title: 'Second',
							body: 'Second item',
							buttons: [{ type: 'url', text: 'Open', url: 'https://example.com' }]
						}
					]
				}
			},
			{} as never
		)

		expect(message.interactiveMessage?.carouselMessage?.cards).toHaveLength(2)
		expect(message.interactiveMessage?.carouselMessage?.messageVersion).toBe(1)
		expect(message.viewOnceMessage).toBeFalsy()
		expect(message.interactiveMessage?.carouselMessage?.cards?.[0]?.nativeFlowMessage?.buttons?.[0]?.name).toBe(
			'quick_reply'
		)
	})
})
