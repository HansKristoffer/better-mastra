import { describe, expect, test } from 'bun:test'
import { createUIMessageStreamResponse } from 'ai'
import { createSSRApp, effectScope, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { z } from 'zod'

import {
	createCardRegistry,
	createChatSession,
	createScreenContextStack,
	type ToolPart
} from '../client/index.js'
import {
	ToolParts,
	useChatSession,
	useScreenContext,
	useWordReveal
} from './index.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useChatSession', () => {
	test('mirrors the turn and the messages into refs, and stops listening with its scope', async () => {
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
		const scope = effectScope()
		const chat = scope.run(() => useChatSession(session))!

		chat.send('Hej')

		expect(chat.turn.value.kind).toBe('requesting')

		await wait(20)

		expect(chat.turn.value.kind).toBe('idle')
		expect(chat.messages.value.map((message) => message.role)).toEqual([
			'user',
			'assistant'
		])

		scope.stop()
		session.chat.messages = []

		expect(chat.messages.value).toHaveLength(2)
	})
})

describe('useScreenContext', () => {
	test('registers while its scope lives and while enabled', async () => {
		const stack = createScreenContextStack<string>()
		const open = ref(true)
		const scope = effectScope()

		scope.run(() =>
			useScreenContext(stack, { read: () => 'Kurv' }, { enabled: open })
		)

		expect(stack.read()).toBe('Kurv')

		open.value = false
		await nextTick()

		expect(stack.read()).toBeUndefined()

		open.value = true
		await nextTick()
		scope.stop()

		expect(stack.read()).toBeUndefined()
	})
})

describe('useWordReveal', () => {
	test('reveals whole words while streaming and everything once it ends', async () => {
		const text = ref('Dit budget er')
		const streaming = ref(true)
		const scope = effectScope()
		const shown = scope.run(() => useWordReveal(text, streaming))!

		expect(shown.value).toBe('')

		await wait(50)

		expect(shown.value).toBe('Dit')

		text.value = 'Dit budget er fint'
		streaming.value = false
		await nextTick()

		expect(shown.value).toBe('Dit budget er fint')
		scope.stop()
	})
})

describe('ToolParts', () => {
	test('draws each card with its component and folds runs of steps', async () => {
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
		const app = createSSRApp(() =>
			h(ToolParts, {
				parts: [
					part('search', 's1', {}),
					part('lookup', 's2', {}),
					part('listGoals', 'g1', { count: 2 })
				],
				registry,
				cards: {
					goals: (props: { card: { data: { count: number } } }) =>
						h('b', props.card.data.count),
					generic: (props: { card: { toolName: string } }) =>
						h('i', props.card.toolName)
				},
				steps: (
					_props: unknown,
					{ slots }: { slots: { default?: () => unknown } }
				) => h('ul', slots.default?.() as never)
			})
		)

		expect((await renderToString(app)).replace(/<!--.*?-->/g, '')).toBe(
			'<ul><i>search</i><i>lookup</i></ul><b>2</b>'
		)
	})
})
