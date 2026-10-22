import { describe, expect, test } from 'bun:test'
import type { MastraDBMessage } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import type { Memory } from '@mastra/memory'
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createMemory, listExtractor } from './memory'

type ModelCallOptions = Parameters<MockLanguageModelV4['doStream']>[0]

const KEY = { threadId: 'thread-1', resourceId: 'user-1' }
const STARTS_AT = new Date('2026-10-01T10:00:00.000Z')
/** Above Mastra's buffering floor of 6,000 tokens, which a lower per-record threshold falls back from. */
const TEST_OBSERVATION_THRESHOLD_TOKENS = 6_100
const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 10, text: 10, reasoning: 0 }
}
const EXTRACTED = { 'user-goals': { items: ['Save for a holiday'] } }

/** A mock model that streams one text answer, as Mastra's Observer and Reflector call it. */
function mockModel(
	modelId: string,
	answer: (options: ModelCallOptions) => string
) {
	return new MockLanguageModelV4({
		modelId,
		doStream: async (options) => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: 'stream-start', warnings: [] })
					controller.enqueue({ type: 'text-start', id: 'text' })
					controller.enqueue({
						type: 'text-delta',
						id: 'text',
						delta: answer(options)
					})
					controller.enqueue({ type: 'text-end', id: 'text' })
					controller.enqueue({
						type: 'finish',
						finishReason: { unified: 'stop', raw: 'stop' },
						usage: USAGE
					})
					controller.close()
				}
			})
		})
	})
}

const observerAnswering = () =>
	mockModel('observer', (options) =>
		options.responseFormat?.type === 'json'
			? JSON.stringify(EXTRACTED)
			: '<observations>\n* User wants to save for a holiday\n</observations>'
	)

/** Seeds a conversation long enough to observe, then observes and reflects through Mastra's own engine. */
async function runObservationCycle(memory: Memory) {
	await memory.createThread(KEY)
	await memory.saveMessages({
		messages: [0, 1].map((index): MastraDBMessage => ({
			id: `observed-${index}`,
			role: index === 0 ? 'user' : 'assistant',
			createdAt: new Date(STARTS_AT.getTime() + index * 1_000),
			...KEY,
			content: {
				format: 2,
				parts: [
					{ type: 'text', text: 'I want to save for a holiday. '.repeat(800) }
				]
			}
		}))
	})
	const engine = await memory.omEngine
	if (!engine) throw new Error('Observational memory is off')
	await engine.getOrCreateRecord(KEY.threadId, KEY.resourceId)
	await engine.updateRecordConfig(KEY.threadId, KEY.resourceId, {
		observation: { messageTokens: TEST_OBSERVATION_THRESHOLD_TOKENS }
	})
	await engine.observe(KEY)
	await engine.reflect(KEY.threadId, KEY.resourceId)
}

describe('createMemory', () => {
	test('observes and reflects on the given models within their output caps, and runs the extractors', async () => {
		const observer = observerAnswering()
		const reflector = mockModel(
			'reflector',
			() => '<observations>\n* User saves for a holiday\n</observations>'
		)
		const memory = createMemory({
			storage: new InMemoryStore(),
			observer,
			reflector,
			observerMaxOutputTokens: 16_384,
			reflectorMaxOutputTokens: 40_000,
			extract: [
				listExtractor({
					name: 'user-goals',
					instructions: 'List what the user wants to achieve.'
				})
			]
		})

		await runObservationCycle(memory)

		expect(observer.doStreamCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ maxOutputTokens: 16_384 })
			])
		)
		expect(reflector.doStreamCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ maxOutputTokens: 40_000 })
			])
		)
		const thread = await memory.getThreadById({ threadId: KEY.threadId })
		expect(JSON.stringify(thread?.metadata)).toContain('Save for a holiday')
	})

	test('goes on without observations when the Observer fails, trying it once', async () => {
		const observer = mockModel('observer', () => {
			throw new APICallError({
				message: 'Service unavailable',
				url: 'https://openrouter.test/api/v1/chat/completions',
				requestBodyValues: {},
				statusCode: 503
			})
		})
		const memory = createMemory({ storage: new InMemoryStore(), observer })

		await expect(runObservationCycle(memory)).resolves.toBeUndefined()
		expect(observer.doStreamCalls).toHaveLength(1)
	})

	test('without an observer it is plain message history', async () => {
		const memory = createMemory({ storage: new InMemoryStore() })
		await expect(memory.omEngine).resolves.toBeFalsy()
	})
})
