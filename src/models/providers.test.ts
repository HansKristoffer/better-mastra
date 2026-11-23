import { describe, expect, it } from 'bun:test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { openRouterReasoningOptions } from './openrouter'
import { thoughtSignatureRecovery } from './openrouter-compat'
import { anthropicReasoningOptions } from './providers/anthropic'
import { inceptionReasoningOptions } from './providers/inception'
import { requestyReasoningOptions } from './providers/requesty'
import { vertexEuPublisherBaseUrl } from './providers/vertex'

describe('anthropicReasoningOptions', () => {
	it.each(['off', 'low'] as const)(
		'maps %s to between_tools on Sonnet 5.5, which rejects disabled',
		(effort) => {
			expect(anthropicReasoningOptions('claude-sonnet-5-5', effort)).toEqual({
				anthropic: { thinking: { type: 'between_tools' }, effort: 'low' }
			})
		}
	)

	it('uses adaptive thinking at medium and above', () => {
		expect(anthropicReasoningOptions('claude-sonnet-5-5', 'medium')).toEqual({
			anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' }
		})
	})

	it('disables thinking on Haiku 5.5, which rejects between_tools', () => {
		expect(anthropicReasoningOptions('claude-haiku-5-5', 'off')).toEqual({
			anthropic: { thinking: { type: 'disabled' } }
		})
	})
})

describe('openRouterReasoningOptions', () => {
	it('disables reasoning for OFF', () => {
		expect(
			openRouterReasoningOptions('google/gemini-3.5-flash-lite', 'off')
		).toEqual({ openrouter: { reasoning: { enabled: false } } })
	})

	it('passes any other effort through, medium included', () => {
		expect(openRouterReasoningOptions('x-ai/grok-4.6', 'medium')).toEqual({
			openrouter: { reasoning: { effort: 'medium' } }
		})
	})
})

describe('requestyReasoningOptions', () => {
	it('GLM 5.3 rejects OFF instead of silently using an unsupported effort', () => {
		expect(() => requestyReasoningOptions('sference/glm-5.3', 'off')).toThrow(
			'OFF is unsupported'
		)
		expect(requestyReasoningOptions('sference/glm-5.3', 'low')).toEqual({
			requesty: { reasoningEffort: 'low' }
		})
		expect(requestyReasoningOptions('another/model', 'off')).toEqual({
			requesty: { reasoningEffort: 'none' }
		})
	})
})

describe('inceptionReasoningOptions', () => {
	it('Mercury Voice has no instant effort, so OFF sends its lowest: low', () => {
		expect(inceptionReasoningOptions('mercury-voice', 'off')).toEqual({
			inception: { reasoningEffort: 'low' }
		})
		expect(inceptionReasoningOptions('mercury-voice', 'medium')).toEqual({
			inception: { reasoningEffort: 'medium' }
		})
	})
})

describe('vertexEuPublisherBaseUrl', () => {
	it('pins the EU REP host, which the SDK does not build for location eu', () => {
		expect(vertexEuPublisherBaseUrl('lullu-eu')).toBe(
			'https://aiplatform.eu.rep.googleapis.com/v1/projects/lullu-eu/locations/eu/publishers/google'
		)
	})
})

const prompt: LanguageModelV4CallOptions['prompt'] = [
	{ role: 'user', content: [{ type: 'text', text: 'hej' }] },
	{
		role: 'assistant',
		content: [
			{ type: 'reasoning', text: '[REDACTED]' },
			{
				type: 'tool-call',
				toolCallId: 'call_1',
				toolName: 'getSetup',
				input: {},
				providerOptions: {
					openrouter: {
						reasoning_details: [
							{ type: 'reasoning.encrypted', data: 'AY89a1', id: 'call_1' }
						]
					}
				}
			}
		]
	},
	{
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: 'call_1',
				toolName: 'getSetup',
				output: { type: 'json', value: { language: 'da' } }
			}
		]
	}
]

const params = { prompt } as LanguageModelV4CallOptions

/** Stand-in for a stream result; the test only cares which prompt reached it. */
const STREAM = { stream: new ReadableStream() } as unknown as Awaited<
	ReturnType<NonNullable<typeof thoughtSignatureRecovery.wrapStream>>
>

describe('thoughtSignatureRecovery', () => {
	it.each(['Corrupted thought signature.', 'Invalid thought signature.'])(
		'retries without the signature when the upstream cannot read it: %s',
		async (rejection) => {
			let retried: LanguageModelV4CallOptions | undefined
			const result = await thoughtSignatureRecovery.wrapStream?.({
				doStream: () => Promise.reject(new Error(rejection)),
				params,
				model: {
					doStream: (next: LanguageModelV4CallOptions) => {
						retried = next
						return Promise.resolve(STREAM)
					}
				}
			} as never)

			expect(result).toBe(STREAM)
			const assistant = retried?.prompt[1]
			expect(assistant?.role).toBe('assistant')
			expect(JSON.stringify(assistant)).not.toContain('reasoning_details')
			expect(JSON.stringify(assistant)).not.toContain('AY89a1')
			// The tool call itself has to survive, or the tool result is orphaned.
			expect(JSON.stringify(assistant)).toContain('call_1')
		}
	)

	it('rethrows anything else', async () => {
		const promise = thoughtSignatureRecovery.wrapStream?.({
			doStream: () => Promise.reject(new Error('rate limited')),
			params,
			model: { doStream: () => Promise.resolve(STREAM) }
		} as never)
		await expect(promise).rejects.toThrow('rate limited')
	})
})

describe('anthropicRoute', () => {
	const answer = () =>
		Response.json({
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-haiku-5-5',
			content: [{ type: 'text', text: 'Hej' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 1 }
		})

	it('should ask for automatic caching on a prompt without cache markers, and leave a marked one to its markers', async () => {
		// Given Claude on Anthropic's own API, with its requests captured
		const { generateText } = await import('ai')
		const { anthropicRoute } = await import('./providers/anthropic')
		const { stubFetch } = await import('./stub-fetch.test')
		const fetch = stubFetch(answer)
		const model = anthropicRoute('test-key').model('claude-haiku-5-5')

		try {
			// When calls have 0, 1, and 4 explicit cache breakpoints
			const mark = { anthropic: { cacheControl: { type: 'ephemeral' } } }
			await generateText({ model, prompt: 'Hej' })
			await generateText({
				model,
				messages: [
					{ role: 'system', content: 'Stable.', providerOptions: mark },
					{ role: 'user', content: 'Hej' }
				],
				allowSystemInMessages: true
			})
			await generateText({
				model,
				messages: [
					{ role: 'system', content: 'A.', providerOptions: mark },
					{ role: 'system', content: 'B.', providerOptions: mark },
					{ role: 'user', content: 'C', providerOptions: mark },
					{ role: 'assistant', content: 'D', providerOptions: mark },
					{ role: 'user', content: 'E' }
				],
				allowSystemInMessages: true
			})

			// Then automatic caching is kept for 0–3 explicit markers (≤ 4 total) and omitted at 4
			const [plain, oneMarked, fourMarked] = fetch.bodies()
			expect(plain?.cache_control).toEqual({ type: 'ephemeral' })
			expect(oneMarked?.cache_control).toEqual({ type: 'ephemeral' })
			expect(JSON.stringify(oneMarked?.system)).toContain('cache_control')
			expect(fourMarked?.cache_control).toBeUndefined()
		} finally {
			fetch.restore()
		}
	})

	it('supports 1h automatic cache TTL and downgrades safely when an explicit marker uses 5m', async () => {
		const { generateText } = await import('ai')
		const { anthropicRoute } = await import('./providers/anthropic')
		const { stubFetch } = await import('./stub-fetch.test')
		const fetch = stubFetch(answer)
		const model = anthropicRoute('test-key', { cacheTtl: '1h' }).model(
			'claude-haiku-5-5'
		)

		try {
			await generateText({ model, prompt: 'Hej' })
			await generateText({
				model,
				messages: [
					{
						role: 'system',
						content: 'Short TTL.',
						providerOptions: {
							anthropic: { cacheControl: { type: 'ephemeral' } }
						}
					},
					{ role: 'user', content: 'Hej' }
				],
				allowSystemInMessages: true
			})

			const [oneHour, downgraded] = fetch.bodies()
			expect(oneHour?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
			expect(downgraded?.cache_control).toEqual({ type: 'ephemeral' })
		} finally {
			fetch.restore()
		}
	})
})

describe('openAiRoute prompt caching & openrouter-compat identity', () => {
	it('forwards promptCacheKey and promptCacheRetention on openAiRoute', async () => {
		const { generateText } = await import('ai')
		const { openAiRoute } = await import('./providers/openai')
		const { stubFetch } = await import('./stub-fetch.test')
		const fetch = stubFetch(() =>
			Response.json({
				id: 'resp_1',
				object: 'response',
				created_at: 1,
				model: 'gpt-5-mini',
				output: [
					{
						id: 'msg_1',
						type: 'message',
						role: 'assistant',
						status: 'completed',
						content: [{ type: 'output_text', text: 'Hej', annotations: [] }]
					}
				],
				usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }
			})
		)
		const model = openAiRoute('test-key', {
			promptCacheKey: 'hellu-buddy',
			promptCacheRetention: '24h'
		}).model('gpt-5-mini')

		try {
			await generateText({ model, prompt: 'Hej' })
			const [body] = fetch.bodies()
			expect(body?.prompt_cache_key).toBe('hellu-buddy')
			expect(body?.prompt_cache_retention).toBe('24h')
		} finally {
			fetch.restore()
		}
	})

	it('stripReasoningFromPrompt preserves identity of untouched assistant messages', async () => {
		const { stripReasoningFromPrompt } = await import('./openrouter-compat')
		const untouched = {
			role: 'assistant' as const,
			content: [{ type: 'text' as const, text: 'Plain reply' }]
		}
		const stripped = stripReasoningFromPrompt([...prompt, untouched])
		expect(stripped).toBeDefined()
		expect(stripped?.at(-1)).toBe(untouched)
	})
})
