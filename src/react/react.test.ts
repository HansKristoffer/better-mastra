import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, test } from 'bun:test'
import { createUIMessageStreamResponse } from 'ai'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'

import {
	createCardRegistry,
	createChatSession,
	createScreenContextStack,
	type ToolPart
} from '../client/index.js'

// happy-dom brings its own streams; the AI SDK pipes Bun's.
const native = {
	ReadableStream,
	WritableStream,
	TransformStream,
	TextDecoderStream,
	TextEncoderStream,
	Response,
	Request,
	Headers
}

GlobalRegistrator.register()
Object.assign(globalThis, native)

const { act, renderHook } = await import('@testing-library/react')
const { ToolParts, useChatSession, useScreenContext, useWordReveal } =
	await import('./index.js')

afterAll(() => GlobalRegistrator.unregister())

describe('useChatSession', () => {
	test('renders the turn and the messages as the answer streams in', async () => {
		const session = createChatSession({
			threadId: 'thread-1',
			transport: {
				api: 'https://api.test/chat',
				fetch: async () =>
					createUIMessageStreamResponse({
						stream: new ReadableStream({
							start(controller) {
								controller.enqueue({ type: 'start', messageId: 'a1' })
								controller.enqueue({ type: 'text-start', id: 't' })
								controller.enqueue({
									type: 'text-delta',
									id: 't',
									delta: 'Hej!'
								})
								controller.enqueue({ type: 'text-end', id: 't' })
								controller.enqueue({ type: 'finish' })
								controller.close()
							}
						})
					})
			}
		})
		const { result } = renderHook(() =>
			useChatSession(session, { throttleMs: 10 })
		)
		const send = result.current.send

		expect(result.current.turn.kind).toBe('idle')

		await act(async () => {
			result.current.send('Hej')
			await new Promise((resolve) => setTimeout(resolve, 30))
		})

		expect(result.current.turn.kind).toBe('idle')
		expect(result.current.messages.map((message) => message.role)).toEqual([
			'user',
			'assistant'
		])
		expect(result.current.send).toBe(send)
	})
})

describe('useScreenContext', () => {
	test('puts the screen on top on focus, reads its latest entry, and leaves on unmount', () => {
		const stack = createScreenContextStack<string>()
		let focus: (() => void) | undefined
		const useFocusEffect = (effect: () => void) => {
			focus = effect
		}
		const { rerender, unmount } = renderHook(
			({ value }) =>
				useScreenContext(stack, { read: () => value }, { useFocusEffect }),
			{ initialProps: { value: 'Budget' } }
		)

		expect(stack.read()).toBeUndefined()

		focus?.()
		rerender({ value: 'Budget, maj' })

		expect(stack.read()).toBe('Budget, maj')

		unmount()

		expect(stack.read()).toBeUndefined()
	})
})

describe('useWordReveal', () => {
	test('reveals whole words while streaming and everything once it ends', async () => {
		const { result, rerender } = renderHook(
			({ text, streaming }) => useWordReveal(text, streaming),
			{
				initialProps: { text: 'Dit budget er', streaming: true }
			}
		)

		expect(result.current).toBe('')

		await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

		expect(result.current).toBe('Dit')

		rerender({ text: 'Dit budget er fint', streaming: false })

		expect(result.current).toBe('Dit budget er fint')
	})
})

describe('ToolParts', () => {
	test('draws each card with its component and folds runs of steps', () => {
		const registry = createCardRegistry({
			schemas: { goals: z.object({ count: z.number() }) },
			toolCard: (toolName) => (toolName === 'listGoals' ? 'goals' : undefined)
		})
		const part = (toolName: string, toolCallId: string, output: unknown) =>
			({
				type: 'dynamic-tool',
				toolName,
				toolCallId,
				state: 'output-available',
				input: {},
				output
			}) as ToolPart
		const html = renderToStaticMarkup(
			createElement(ToolParts<{ goals: z.ZodObject<{ count: z.ZodNumber }> }>, {
				parts: [
					part('search', 's1', {}),
					part('lookup', 's2', {}),
					part('listGoals', 'g1', { count: 2 })
				],
				registry,
				cards: {
					goals: ({ card }) =>
						createElement(
							'b',
							null,
							card.state === 'done' ? card.data.count : '…'
						),
					generic: ({ card }) => createElement('i', null, card.toolName)
				},
				Steps: ({ children }) => createElement('ul', null, children)
			})
		)

		expect(html).toBe('<ul><i>search</i><i>lookup</i></ul><b>2</b>')
	})
})
