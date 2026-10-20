import { afterEach, expect, test } from 'bun:test'
import { APICallError, type LanguageModelUsage } from 'ai'
import { AiBillingError } from '../models/billing-error'
import { createLlmRegistry } from '../models/registry'
import { chatCompletion, stubFetch } from '../models/stub-fetch.test'
import type { UsageRecord } from './generate'
import { withUsage } from './generate'

const llms = await createLlmRegistry({
	keys: { openrouter: 'test-key', inception: 'test-inception-key' }
})
type Context = { organizationId: string }
const usage: Context = { organizationId: 'org_test' }

let restore = () => {}
afterEach(() => restore())

function metered() {
	const records: UsageRecord<Context>[] = []
	const billing: AiBillingError[] = []
	const ai = withUsage<Context>({
		llms,
		sink: (record) => {
			records.push(record)
		},
		onBillingError: (error) => billing.push(error)
	})
	return { ai, records, billing }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('a route-prefixed id goes to that route instead of OpenRouter', async () => {
	const fetch = stubFetch(() => Response.json(chatCompletion()))
	restore = fetch.restore
	await metered().ai.generateText({
		model: 'inception/mercury-2.5',
		reasoning: 'low',
		prompt: 'Hi',
		usage
	})
	expect(fetch.calls[0]?.url).toBe(
		'https://api.inceptionlabs.ai/v1/chat/completions'
	)
	expect(fetch.bodies()[0]).toMatchObject({
		model: 'mercury-2.5',
		reasoning_effort: 'low'
	})
})

test('an @effort suffix pins that OpenRouter effort over the caller', async () => {
	const fetch = stubFetch(() => Response.json(chatCompletion()))
	restore = fetch.restore
	await metered().ai.generateText({
		model: 'google/gemini-3.8-flash@medium',
		reasoning: 'low',
		prompt: 'Hi',
		usage
	})
	expect(fetch.calls[0]?.url).toContain('openrouter.ai')
	expect(fetch.bodies()[0]).toMatchObject({
		model: 'google/gemini-3.8-flash',
		reasoning: { effort: 'medium' }
	})
})

test('a timeout ends a call whose provider never answers', async () => {
	const fetch = stubFetch(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError'))
				)
			})
	)
	restore = fetch.restore
	const startedAt = performance.now()

	const call = metered().ai.generateText({
		model: 'google/gemini-3.8-flash',
		prompt: 'Hi',
		timeoutMs: 50,
		maxRetries: 0,
		usage
	} as Parameters<ReturnType<typeof metered>['ai']['generateText']>[0])

	await expect(call).rejects.toThrow()
	expect(performance.now() - startedAt).toBeLessThan(2_000)
})

test('reports tokens, the reported cost and the prompt version to the sink', async () => {
	const fetch = stubFetch(() =>
		Response.json(
			chatCompletion('ok', {
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: 110,
				prompt_tokens_details: { cached_tokens: 60 },
				cost: 0.004
			})
		)
	)
	restore = fetch.restore
	const { ai, records } = metered()
	await ai.generateText({
		model: 'google/gemini-3.8-flash',
		prompt: 'Hi',
		usage,
		promptVersion: 'v7'
	})
	await settle()

	expect(records).toEqual([
		expect.objectContaining({
			context: usage,
			modelId: 'google/gemini-3.8-flash',
			route: 'openrouter',
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 60,
			costUsd: 0.004,
			costEstimated: false,
			providerCalls: 1,
			batched: false,
			promptVersion: 'v7'
		})
	])
})

test('a 402 is reported once and rethrown as a billing error', async () => {
	const fetch = stubFetch(() =>
		Response.json({ error: { message: 'more credits' } }, { status: 402 })
	)
	restore = fetch.restore
	const { ai, billing } = metered()

	const call = ai.generateText({
		model: 'google/gemini-3.8-flash',
		prompt: 'Hi',
		usage
	})

	const error = await call.catch((e: unknown) => e)
	expect(error instanceof AiBillingError).toBe(true)
	expect(billing).toHaveLength(1)
	expect(APICallError.isInstance(billing[0]?.cause)).toBe(true)
})

test('meterStream reads Mastra cache writes and leaves aborted runs alone', async () => {
	const { ai, records } = metered()
	ai.meterStream(
		{
			totalUsage: Promise.resolve({
				inputTokens: 12_000,
				outputTokens: 120,
				cachedInputTokens: 5_000,
				cacheCreationInputTokens: 4_000
			}),
			steps: Promise.resolve([
				{ providerMetadata: { openrouter: { usage: { cost: 0.0012 } } } },
				{ providerMetadata: { openrouter: { usage: { cost: 0.0008 } } } }
			])
		},
		{ model: 'google/gemini-3.8-flash', usage, metadata: { threadId: 't1' } }
	)
	ai.meterStream(
		{
			totalUsage: Promise.reject(
				new Error('aborted')
			) as PromiseLike<LanguageModelUsage>
		},
		{ model: 'google/gemini-3.8-flash', usage }
	)
	await settle()

	expect(records).toEqual([
		expect.objectContaining({
			inputTokens: 12_000,
			cacheReadTokens: 5_000,
			cacheWriteTokens: 4_000,
			providerCalls: 2,
			costUsd: 0.002,
			metadata: { threadId: 't1' }
		})
	])
})
