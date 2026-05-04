import { proto } from '../../../WAProto'
import { generateWAMessageContent } from '../../Utils/messages'
import { getBizBinaryNode, shouldIncludeBizBinaryNode } from '../../WABinary'

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
		expect(message.interactiveMessage?.carouselMessage?.carouselCardType).toBe(
			proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS
		)
		expect(message.viewOnceMessage).toBeFalsy()
		expect(message.interactiveMessage?.carouselMessage?.cards?.[0]?.nativeFlowMessage?.messageVersion).toBe(1)
		expect(message.interactiveMessage?.carouselMessage?.cards?.[0]?.nativeFlowMessage?.buttons?.[0]?.name).toBe(
			'quick_reply'
		)
	})

	it('adds quality control metadata to list biz nodes', () => {
		const message = {
			listMessage: {
				listType: proto.Message.ListMessage.ListType.PRODUCT_LIST
			}
		}

		expect(shouldIncludeBizBinaryNode(message)).toBe(true)
		expect(getBizBinaryNode(message)).toMatchObject({
			tag: 'biz',
			content: [
				{ tag: 'list', attrs: { type: 'product_list', v: '2' } },
				{
					tag: 'quality_control',
					attrs: { source_type: 'third_party' },
					content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
				}
			]
		})
	})

	it('adds quality control metadata to native flow biz nodes', () => {
		const message = {
			interactiveMessage: {
				nativeFlowMessage: {
					buttons: [{ name: 'quick_reply' }]
				}
			}
		}

		expect(shouldIncludeBizBinaryNode(message)).toBe(true)
		expect(getBizBinaryNode(message)).toMatchObject({
			tag: 'biz',
			content: [
				{
					tag: 'interactive',
					attrs: { type: 'native_flow', v: '1' },
					content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
				},
				{
					tag: 'quality_control',
					attrs: { source_type: 'third_party' },
					content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
				}
			]
		})
	})

	it('keeps native flow single_select lists as interactive messages', async () => {
		const message = await generateWAMessageContent(
			{
				interactiveMessage: {
					body: { text: 'Choose an option' },
					nativeFlowMessage: {
						buttons: [
							{
								name: 'single_select',
								buttonParamsJson: JSON.stringify({
									title: 'Open',
									sections: [
										{
											title: 'Options',
											rows: [{ id: 'first', rowId: 'first', title: 'First' }]
										}
									]
								})
							}
						],
						messageVersion: 1
					}
				}
			},
			{} as never
		)

		expect(message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name).toBe('single_select')
		expect(message.listMessage).toBeFalsy()
		expect(getBizBinaryNode(message)).toMatchObject({
			tag: 'biz',
			content: [
				{
					tag: 'interactive',
					attrs: { type: 'native_flow', v: '1' },
					content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
				},
				{
					tag: 'quality_control',
					attrs: { source_type: 'third_party' }
				}
			]
		})
	})
})
