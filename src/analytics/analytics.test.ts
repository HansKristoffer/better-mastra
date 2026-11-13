import { describe, expect, test } from 'bun:test'
import type { AnySpan } from '@mastra/core/observability'

import {
	createHarness,
	LOOKUP_TOOL,
	readTurn,
	textReply,
	toolCallReply,
	userMessage
} from '../turn/turnFixtures.test.js'
import {
	createPostHogCapture,
	POSTHOG_EU_HOST,
	type PostHogEvent,
	posthogGenerations,
	readModelCalls,
	readTurnTraceId,
	StripContentProcessor,
	toAiGenerationEvent,
	totalModelCalls
} from './index.js'

const STEP = {
	finishReason: 'stop',
	usage: {
		inputTokens: 1_200,
		outputTokens: 80,
		cachedInputTokens: 1_000,
		cacheCreationInputTokens: 150
	},
	response: {
		id: 'gen-1',
		modelId: 'anthropic/claude-haiku-5-5',
		dbMessages: [{ content: { metadata: { traceId: 'trace-1' } } }]
	},
	providerMetadata: { openrouter: { usage: { cost: 0.0042 } } },
	text: 'Du brugte 4.200 kr.'
}

describe('StripContentProcessor', () => {
	test('removes what can carry text and keeps what metrics need, on the same span', () => {
		const span = {
			id: 'span-1',
			traceId: 'trace-1',
			input: [{ role: 'user', content: 'Hvad bruger jeg på mad?' }],
			output: { text: 'Du brugte 4.200 kr.' },
			requestContext: { userId: 'user-1' },
			attributes: {
				model: 'claude-haiku-5-5',
				usage: { inputTokens: 1_200 },
				instructions: 'You are Astrid.',
				prompt: 'Hvad bruger jeg på mad?',
				tools: [{ name: 'lookup' }],
				screen: 'budget'
			},
			errorInfo: {
				message: 'Provider returned 400',
				details: { statusCode: 400, responseBody: '{"prompt":"Hvad…"}' }
			}
		} as unknown as AnySpan

		const processed = new StripContentProcessor({
			attributes: ['screen']
		}).process(span)

		expect(processed).toBe(span)
		expect(JSON.parse(JSON.stringify(span))).toEqual({
			id: 'span-1',
			traceId: 'trace-1',
			attributes: { model: 'claude-haiku-5-5', usage: { inputTokens: 1_200 } },
			errorInfo: {
				message: 'Provider returned 400',
				details: { statusCode: 400 }
			}
		})
		expect(new StripContentProcessor().process(undefined)).toBeUndefined()
	})
})

describe("reading a turn's model calls", () => {
	test('reads tokens, cache, cost and stop reason, and none of the text', () => {
		const calls = readModelCalls([STEP, 'not a step'], 'fallback-model')

		expect(calls).toEqual([
			{
				responseId: 'gen-1',
				modelId: 'anthropic/claude-haiku-5-5',
				inputTokens: 1_200,
				outputTokens: 80,
				cacheReadTokens: 1_000,
				cacheWriteTokens: 150,
				costUsd: 0.0042,
				stopReason: 'stop'
			}
		])
		expect(readTurnTraceId([STEP])).toBe('trace-1')
		expect(readTurnTraceId([{ response: {} }])).toBeUndefined()
		expect(totalModelCalls([...calls, ...calls])).toEqual({
			inputTokens: 2_400,
			outputTokens: 160,
			cacheReadTokens: 2_000,
			cacheWriteTokens: 300,
			costUsd: 0.0084
		})
		expect(
			readModelCalls([{}], 'fallback-model', { costOf: () => undefined })
		).toMatchObject([{ modelId: 'fallback-model', costUsd: undefined }])
	})

	test('reads the steps a real turn hands its usage sink', async () => {
		// Given a turn that calls a tool and then answers: two model calls
		const sent: Parameters<ReturnType<typeof posthogGenerations>>[0][] = []
		const harness = createHarness({
			replies: [
				toolCallReply(LOOKUP_TOOL, { category: 'food' }),
				textReply('Du brugte 4.200 kr.')
			],
			overrides: { sinks: { usage: (event) => sent.push(event) } }
		})

		await readTurn(await harness.run({ messages: [userMessage('Mad?')] }))

		const calls = readModelCalls(sent[0]?.steps ?? [], sent[0]?.modelId ?? '')

		expect(calls).toHaveLength(2)
		expect(calls.map((call) => call.stopReason)).toEqual(['tool-calls', 'stop'])
		expect(totalModelCalls(calls).inputTokens).toBeGreaterThan(0)
	})
})

describe('PostHog LLM analytics', () => {
	const [call] = readModelCalls([STEP], 'fallback-model')

	test('maps a model call to $ai_generation without text or undefined values', () => {
		const event = toAiGenerationEvent(call!, {
			distinctId: 'user-1',
			traceId: 'trace-1',
			sessionId: undefined,
			provider: 'openrouter',
			properties: { workspace_id: 'ws-1', plan: undefined }
		})

		expect(event).toEqual({
			event: '$ai_generation',
			distinctId: 'user-1',
			properties: {
				$ai_trace_id: 'trace-1',
				$ai_span_id: 'gen-1',
				$ai_span_name: 'chat_step',
				$ai_model: 'anthropic/claude-haiku-5-5',
				$ai_provider: 'openrouter',
				$ai_input_tokens: 1_200,
				$ai_output_tokens: 80,
				$ai_cache_read_input_tokens: 1_000,
				$ai_cache_creation_input_tokens: 150,
				$ai_cache_reporting_exclusive: false,
				$ai_total_cost_usd: 0.0042,
				$ai_cost_passthrough: true,
				$ai_stop_reason: 'stop',
				$ai_is_error: false,
				workspace_id: 'ws-1'
			}
		})
		expect(JSON.stringify(event)).not.toContain('4.200 kr.')
	})

	test('sends one generation per model call of a traced turn, and none for a user it must not track', () => {
		const captured: PostHogEvent[] = []
		const sink = posthogGenerations<{ userId: string; consents: boolean }>({
			capture: (event) => void captured.push(event),
			identify: (scope, labels) =>
				scope.consents
					? { distinctId: scope.userId, sessionId: String(labels.sessionId) }
					: undefined,
			provider: 'openrouter'
		})
		const turn = {
			labels: { sessionId: 's-1' },
			modelId: 'fallback-model',
			steps: [STEP, STEP]
		}

		sink({ ...turn, scope: { userId: 'user-1', consents: true } })
		sink({ ...turn, scope: { userId: 'user-2', consents: false } })
		// A turn without a trace sends nothing rather than events under another id
		sink({
			...turn,
			steps: [{ ...STEP, response: { id: 'gen-2' } }],
			scope: { userId: 'user-1', consents: true }
		})

		expect(captured).toHaveLength(2)
		expect(captured[0]).toMatchObject({
			distinctId: 'user-1',
			properties: { $ai_trace_id: 'trace-1', $ai_session_id: 's-1' }
		})
	})

	test('posts to the capture API and never throws', async () => {
		const requests: { url: string; body: Record<string, unknown> }[] = []
		const errors: unknown[] = []
		const replies = [
			() => new Response(null, { status: 200 }),
			() => new Response(null, { status: 401 }),
			() => {
				throw new TypeError('fetch failed')
			}
		]
		const capture = createPostHogCapture({
			apiKey: 'phc_test',
			host: `${POSTHOG_EU_HOST}/`,
			fetch: (async (url: string, init: RequestInit) => {
				requests.push({ url, body: JSON.parse(String(init.body)) })

				return replies.shift()!()
			}) as unknown as typeof fetch,
			onError: (error, event) => errors.push([String(error), event])
		})
		const event: PostHogEvent = {
			event: '$ai_generation',
			distinctId: 'user-1',
			properties: { $ai_model: 'm' }
		}

		await capture(event)
		await capture(event)
		await capture(event)

		expect(requests[0]).toEqual({
			url: 'https://eu.i.posthog.com/i/v0/e/',
			body: {
				api_key: 'phc_test',
				event: '$ai_generation',
				distinct_id: 'user-1',
				properties: { $ai_model: 'm', $geoip_disable: true }
			}
		})
		expect(errors).toEqual([
			[
				'Error: PostHog rejected an event.',
				{ event: '$ai_generation', status: 401 }
			],
			['TypeError: fetch failed', { event: '$ai_generation' }]
		])
		// Without a key nothing is sent
		await createPostHogCapture({
			apiKey: undefined,
			fetch: (() => {
				throw new Error('must not be called')
			}) as unknown as typeof fetch
		})(event)
	})
})
