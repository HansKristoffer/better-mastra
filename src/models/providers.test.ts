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
