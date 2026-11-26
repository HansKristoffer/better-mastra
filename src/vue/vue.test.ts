import { describe, expect, test } from 'bun:test'
import { createUIMessageStreamResponse } from 'ai'
import { createSSRApp, effectScope, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { z } from 'zod'

import {
	createCardRegistry,
	createChangePlanStore,
	createChatSession,
	createChatSessions,
	createScreenContextStack,
	type ToolPart
} from '../client/index.js'
import {
	ToolParts,
	useChangePlan,
	useChatSession,
	useChatThread,
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

	test('useChatThread switches threads reactively and ignores stale loads', async () => {
		const sessions = createChatSessions((id) =>
			createChatSession({
				threadId: id,
				transport: { api: 'https://api.test/chat' }
			})
		)
		const threadId = ref('t1')
		let resolveT1: (() => void) | undefined
		const scope = effectScope()
		const thread = scope.run(() =>
			useChatThread({
				sessions,
				threadId,
				load: async (id) => {
					if (id === 't1') {
						await new Promise<void>((r) => {
							resolveT1 = r
						})
						return {
							messages: [
								{
									id: 'm1',
									role: 'user',
									parts: [{ type: 'text', text: 'stale' }]
								}
							]
						}
					}
					return {
						messages: [
							{
								id: 'm2',
								role: 'user',
								parts: [{ type: 'text', text: 'fresh' }]
							},
							{
								id: 'a2',
								role: 'assistant',
								parts: [
									{
										type: 'dynamic-tool',
										toolName: 'edit',
										toolCallId: 'c1',
										state: 'input-available',
										input: {}
									}
								]
							}
						],
						pendingChanges: [
							{
								kind: 'approval',
								runId: 'r1',
								toolCallId: 'c1',
								toolName: 'edit',
								approvalId: 'r1::c1'
							}
						]
					}
				}
			})
		)!

		threadId.value = 't2'
		await nextTick()
		await wait(10)
		// Stale t1 load resolves late — must NOT overwrite t2
		resolveT1?.()
		await wait(10)

		expect(thread.threadId.value).toBe('t2')
		expect(thread.messages.value.map((m) => m.id)).toEqual(['m2', 'a2'])
		expect(thread.pendingApproval.value?.approvalId).toBe('r1::c1')
		scope.stop()
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

describe('useChangePlan', () => {
	test('loads the plan when its ids are set and follows the store', async () => {
		const plan = (id: string, status: string) => ({
			id,
			threadId: 'thread-1',
			status,
			steps: [],
			createdAt: '2026-11-26T00:00:00.000Z',
			updatedAt: '2026-11-26T00:00:00.000Z'
		})
		// Answers each plan by the id at the end of its URL.
		const store = createChangePlanStore({
			api: '/chat',
			fetch: async (input) =>
				Response.json({
					plan: plan(String(input).split('/').at(-1) ?? '', 'proposed')
				})
		})
		const planId = ref('plan-1')
		const scope = effectScope()
		const refs = scope.run(() => useChangePlan(store, 'thread-1', planId))!

		await wait(5)
		expect(refs.plan.value?.id).toBe('plan-1')

		planId.value = 'plan-2'
		await nextTick()
		await wait(5)
		expect(refs.plan.value?.id).toBe('plan-2')

		store.onData({
			type: 'data-change-plan',
			data: { plan: plan('plan-2', 'discarded') }
		})
		expect(refs.plan.value?.status).toBe('discarded')
		scope.stop()
	})
})
