import { describe, expect, test } from 'bun:test'
import { createTool } from '@mastra/core/tools'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import { MESSAGE_DECLINED_PART } from '../protocol/index.js'
import {
	type ChatTurnScreening,
	createMessageScreener,
	type ScreeningVerdict
} from './screening.js'
import {
	createHarness,
	type ModelStreamPart,
	readTurn,
	requestContext,
	type Scope,
	SCOPE,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'

const TOOL = 'lookupSpending'

/** A verdict that arrives after `ms`, and when it did. */
function delayedScreen(verdict: ScreeningVerdict, ms: number) {
	const seen: string[] = []
	let decidedAt = Number.POSITIVE_INFINITY
	const screen: ChatTurnScreening<Scope>['screen'] = async ({ text }) => {
		seen.push(text)
		await Bun.sleep(ms)
		decidedAt = performance.now()
		return verdict
	}

	return { screen, seen, decidedAt: () => decidedAt }
}

/** A model reply that takes `ms` before its first part. */
function slowReply(parts: ModelStreamPart[], ms: number) {
	return async () => ({
		stream: new ReadableStream<ModelStreamPart>({
			async start(controller) {
				await Bun.sleep(ms)
				for (const part of parts) controller.enqueue(part)
				controller.close()
			}
		})
	})
}

function screenedHarness(
	screening: ChatTurnScreening<Scope>,
	replies: Parameters<typeof createHarness>[0] extends infer O
		? O extends { replies?: infer R }
			? R
			: never
		: never
) {
	const ran: number[] = []
	const lookup = createTool({
		id: TOOL,
		description: 'Looks up spending.',
		inputSchema: z.object({ category: z.string() }),
		execute: async () => {
			ran.push(performance.now())
			return { spent: 1_250 }
		}
	})
	const prepared: (Promise<ScreeningVerdict> | undefined)[] = []
	const harness = createHarness({
		replies,
		overrides: {
			screening,
			prepare: async ({ scope, threadKey, screening: verdict }) => {
				prepared.push(verdict)
				return {
					requestContext: requestContext.create(scope, threadKey),
					plan: {
						instructions: 'Stable instructions.',
						model: harness.model,
						modelId: 'test-model',
						tools: { [TOOL]: lookup },
						maxSteps: 4
					}
				}
			}
		}
	})

	return { harness, ran, prepared }
}

/** What memory holds for the harness's thread and resource: the thread row, and every message of the resource, orphans included. */
async function storedThread(harness: ReturnType<typeof createHarness>) {
	const thread = await harness.memory.getThreadById({
		threadId: harness.threadKey.threadId
	})
	const { messages } = await harness.memory.listMessagesByResourceId({
		resourceId: harness.threadKey.resourceId
	})

	return { thread, messages }
}

describe('runChatTurn with screening', () => {
	test('should answer a declined message with the short reply only, run no tool and store nothing', async () => {
		// Given a model that calls a tool at once, and a screener that declines a little later
		const screen = delayedScreen(
			{ verdict: 'off_topic', category: 'essay' },
			40
		)
		const { harness, ran } = screenedHarness(
			{
				screen: screen.screen,
				reply: () => 'I can only help with your budget.'
			},
			[
				toolCallReply(TOOL, { category: 'food' }),
				textReply('Here is your essay.')
			]
		)

		// When the user writes
		const { chunks, message } = await readTurn(
			await harness.run({
				messages: [userMessage('Write me an essay about dogs')]
			})
		)

		// Then the client got only the reply, the tool never ran, and the thread holds nothing
		const text = message?.parts
			.flatMap((part) => (part.type === 'text' ? [part.text] : []))
			.join('')
		expect(text).toBe('I can only help with your budget.')
		expect(chunks).toContainEqual(
			expect.objectContaining({
				type: MESSAGE_DECLINED_PART,
				data: { verdict: 'off_topic' }
			})
		)
		expect(JSON.stringify(chunks)).not.toContain('Here is your essay')
		expect(ran).toEqual([])
		expect(await storedThread(harness)).toEqual({ thread: null, messages: [] })
		expect(harness.finished[0]?.outcome).toBe('declined')
		expect(harness.releases).toHaveLength(1)
	})

	test('should run screening beside the model, so an allowed answer waits for the slower of the two, not both', async () => {
		// Given a screener and a model that each take 120 ms
		const screen = delayedScreen({ verdict: 'allowed' }, 120)
		const { harness, ran } = screenedHarness({ screen: screen.screen }, [
			slowReply(toolCallReply(TOOL, { category: 'food' }), 120),
			textReply('1.250 kr.')
		])
		const startedAt = performance.now()

		// When the user asks
		const { message } = await readTurn(
			await harness.run({ messages: [userMessage('Mad?')] })
		)

		// Then the answer arrives whole, the tool ran only after the verdict, and the wait overlapped
		expect(message?.parts).toContainEqual(
			expect.objectContaining({ type: 'text', text: '1.250 kr.' })
		)
		expect(ran).toHaveLength(1)
		expect(ran[0]!).toBeGreaterThanOrEqual(screen.decidedAt())
		expect(performance.now() - startedAt).toBeLessThan(230)
		expect((await storedThread(harness)).messages.length).toBeGreaterThan(0)
	})

	test('should hold a tool the model calls before the verdict until it is allowed', async () => {
		const screen = delayedScreen({ verdict: 'allowed' }, 60)
		const { harness, ran } = screenedHarness({ screen: screen.screen }, [
			toolCallReply(TOOL, { category: 'food' }),
			textReply('1.250 kr.')
		])

		await readTurn(await harness.run({ messages: [userMessage('Mad?')] }))

		expect(ran[0]!).toBeGreaterThanOrEqual(screen.decidedAt())
	})

	test('before the model should never send a declined message to the main model', async () => {
		const screen = delayedScreen(
			{ verdict: 'abusive', category: 'harassment' },
			20
		)
		const { harness } = screenedHarness(
			{ screen: screen.screen, mode: 'before-model' },
			[textReply('Hej!')]
		)

		const { message } = await readTurn(
			await harness.run({ messages: [userMessage('You are useless')] })
		)

		expect(harness.model.doStreamCalls).toHaveLength(0)
		expect(JSON.stringify(message?.parts)).toContain("I won't respond to that.")
		expect(await storedThread(harness)).toEqual({ thread: null, messages: [] })
	})

	test("should screen only a new thread's first message by default, or every message when asked", async () => {
		for (const [when, screened] of [
			['first-message', 1],
			['every-message', 2]
		] as const) {
			const screen = delayedScreen({ verdict: 'allowed' }, 0)
			const { harness } = screenedHarness({ screen: screen.screen, when }, [
				textReply('Hej!')
			])

			await readTurn(await harness.run({ messages: [userMessage('Hej')] }))
			await readTurn(await harness.run({ messages: [userMessage('Igen')] }))

			expect(screen.seen).toHaveLength(screened)
		}
	})

	test('should remove only the declined message from a thread that already had turns', async () => {
		// Given a thread with an answered turn, screened on every message
		const verdicts: ScreeningVerdict[] = [
			{ verdict: 'allowed' },
			{ verdict: 'off_topic' }
		]
		const { harness } = screenedHarness(
			{ screen: async () => verdicts.shift()!, when: 'every-message' },
			[textReply('Hej!')]
		)
		await readTurn(await harness.run({ messages: [userMessage('Hej')] }))
		const before = (await storedThread(harness)).messages.map(
			(message) => message.id
		)

		// When the next message is declined
		await readTurn(
			await harness.run({ messages: [userMessage('Write me a poem')] })
		)

		// Then the thread holds exactly what it held before
		const after = await storedThread(harness)
		expect(after.thread).not.toBeNull()
		expect(after.messages.map((message) => message.id)).toEqual(before)
	})

	test('should count a strike for an abusive message, and refuse a paused user with the seconds left', async () => {
		const recorded: ScreeningVerdict[] = []
		let pausedFor: number | undefined
		const screen = delayedScreen(
			{ verdict: 'abusive', category: 'harassment' },
			0
		)
		const { harness } = screenedHarness(
			{
				screen: screen.screen,
				strikes: {
					check: async () => pausedFor,
					record: async (_scope, verdict) => {
						recorded.push(verdict)
					}
				}
			},
			[textReply('Hej!')]
		)

		await readTurn(
			await harness.run({ messages: [userMessage('You are useless')] })
		)
		expect(recorded).toEqual([{ verdict: 'abusive', category: 'harassment' }])

		pausedFor = 42.2
		const refused = await harness.run({ messages: [userMessage('Hello?')] })
		expect(refused).toMatchObject({
			kind: 'refused',
			code: 'user_paused',
			status: 429
		})
		if (refused.kind === 'refused') {
			expect(await refused.response.json()).toEqual({
				error: 'user_paused',
				retryAfterSeconds: 43
			})
			expect(refused.response.headers.get('Retry-After')).toBe('43')
		}
	})

	test('should let a message through when the screener fails, and log it', async () => {
		const { harness } = screenedHarness(
			{
				screen: async () => {
					throw new Error('screener down')
				}
			},
			[textReply('Hej!')]
		)

		const { message } = await readTurn(
			await harness.run({ messages: [userMessage('Hej')] })
		)

		expect(message?.parts).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Hej!' })
		)
		expect(harness.errors).toContainEqual(
			expect.objectContaining({ message: 'screener down' })
		)
	})

	test('should hand prepare the verdict, so a new thread can pick its tier from it', async () => {
		const screen = delayedScreen({ verdict: 'allowed', tier: 'deep' }, 0)
		const { harness, prepared } = screenedHarness({ screen: screen.screen }, [
			textReply('Hej!')
		])

		await readTurn(
			await harness.run({ messages: [userMessage('Analyse my year')] })
		)

		expect(await prepared[0]).toEqual({ verdict: 'allowed', tier: 'deep' })
		expect(SCOPE.userId).toBe('user-1')
	})
})

describe('createMessageScreener', () => {
	test('should classify with one structured call on the cheap model, the message as data', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async () => ({
				content: [
					{
						type: 'text',
						text: '{"verdict":"off_topic","category":"essay","tier":"fast"}'
					}
				],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 }
				},
				warnings: []
			})
		})
		const screen = createMessageScreener({
			model,
			purpose: 'a budgeting app',
			tiers: { fast: 'short questions', deep: 'analysis' }
		})

		const verdict = await screen({
			scope: SCOPE,
			text: 'Write an essay',
			threadKey: { threadId: 't', resourceId: 'r' },
			isNewThread: true,
			signal: new AbortController().signal
		})

		expect(verdict).toEqual({
			verdict: 'off_topic',
			category: 'essay',
			tier: 'fast'
		})
		expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
			'a budgeting app'
		)
	})
})
