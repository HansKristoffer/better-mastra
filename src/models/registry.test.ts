import { afterEach, describe, expect, test } from 'bun:test'
import { generateText, streamText, tool } from 'ai'
import { z } from 'zod'
import { openRouterPrivacyRouting } from './openrouter'
import { extractRequestyCostUsd } from './providers/requesty'
import { createLlmRegistry } from './registry'
import { chatCompletion, stubFetch } from './stub-fetch.test'

const keys = {
	openrouter: 'test-openrouter-key',
	anthropic: 'test-anthropic-key',
	openai: 'test-openai-key',
	requesty: 'test-requesty-key',
	inception: 'test-inception-key',
	vertex: { project: 'test-project', apiKey: 'test-vertex-key' }
}
const llms = await createLlmRegistry({ keys })
const privacy = await createLlmRegistry({
	keys: { openrouter: 'synthetic-assistant-key' },
	openRouterRouting: openRouterPrivacyRouting({
		'anthropic/claude-sonnet-5.5': 'google-vertex/europe',
		'anthropic/claude-haiku-5.5': 'google-vertex/europe'
	})
})

let restore = () => {}
afterEach(() => restore())

function sse(parts: unknown[]) {
	return new Response(
		`${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`,
		{ headers: { 'content-type': 'text/event-stream' } }
	)
}

const chunk = (
	model: string,
	delta: Record<string, unknown>,
	finish_reason: string | null = null
) => ({
	id: 'response-1',
	model,
	created: 1,
	choices: [{ index: 0, delta, finish_reason }]
})

describe('resolveLlm', () => {
	test('a pinned effort wins over the requested one and never reaches the provider', () => {
		const llm = llms.resolveLlm('anthropic-direct/claude-sonnet-5-5@medium', {
			reasoning: 'low'
		})

		expect(llm.route).toBe('anthropic-direct')
		expect(llm.model).toMatchObject({ modelId: 'claude-sonnet-5-5' })
		expect(llm.providerOptions).toEqual({
			anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' }
		})
	})

	test('without an effort no thinking options are sent', () => {
		expect(
			llms.resolveLlm('google/gemini-3.8-flash').providerOptions
		).toBeUndefined()
	})

	test('a bare Gemini id goes to Vertex EU, a vendor id to OpenRouter', () => {
		expect(
			llms.resolveLlm('gemini-3.5-flash-lite', { reasoning: 'off' }).route
		).toBe('vertex-eu')
		expect(llms.resolveLlm('x-ai/grok-4.6', { reasoning: 'low' }).route).toBe(
			'openrouter'
		)
	})

	test('a route without a key fails only when it is selected', async () => {
		const openRouterOnly = await createLlmRegistry({
			keys: { openrouter: 'key' }
		})
		expect(() =>
			openRouterOnly.resolveLlm('requesty/sference/glm-5.3')
		).toThrow('Model route "requesty" is not configured')
		expect(openRouterOnly.resolveLlm('google/gemini-3.8-flash').route).toBe(
			'openrouter'
		)
	})

	test('rejects a route with no model id', () => {
		expect(() => llms.resolveLlm('inception/')).toThrow(
			'Missing or invalid model ID for inception'
		)
	})

	test('an app route takes its prefix', async () => {
		const custom = await createLlmRegistry({
			keys: {},
			routes: {
				local: {
					model: (id) => llms.resolveLlm(`openai-direct/${id}`).model,
					reasoningOptions: () => ({})
				}
			}
		})
		expect(custom.parseModelId('local/qwen@high')).toEqual({
			route: 'local',
			providerModelId: 'qwen',
			effort: 'high'
		})
	})
})

describe('cost', () => {
	const usage = { inputTokens: 10_000, outputTokens: 100 }

	test('an unpriced model does not inherit a cheaper model rate', async () => {
		expect(
			await llms.cost({ modelId: 'gemini-3.8-flash', steps: null, usage })
		).toEqual({ usd: null, estimated: true })
	})

	test('prices Anthropic cache reads and writes at their own rates', async () => {
		const cost = await llms.cost({
			modelId: 'anthropic-direct/claude-sonnet-5-5@medium',
			steps: null,
			usage: {
				inputTokens: 30_000,
				outputTokens: 200,
				cachedInputTokens: 25_000,
				cacheWriteTokens: 4_000
			}
		})

		// 1k plain at $2, 25k read at $0.2, 4k written at $2.5, 200 out at $10.
		expect(cost).toEqual({ usd: 0.019, estimated: true })
	})

	test('a step without a reported cost makes the whole call unknown', async () => {
		expect(
			await llms.cost({
				modelId: 'google/gemini-3.8-flash',
				steps: [
					{ providerMetadata: { openrouter: { usage: { cost: 0.1 } } } },
					{}
				],
				usage
			})
		).toEqual({ usd: null, estimated: false })
	})

	test('sums the reported cost of every step', async () => {
		expect(
			await llms.cost({
				modelId: 'google/gemini-3.8-flash',
				steps: [
					{ providerMetadata: { openrouter: { usage: { cost: 0.1 } } } },
					{ providerMetadata: { openrouter: { usage: { cost: 0.05 } } } }
				],
				usage
			})
		).toEqual({ usd: 0.15000000000000002, estimated: false })
	})
})

describe('routes on the wire', () => {
	test('OpenRouter pins Gemini to AI Studio and sends usage accounting', async () => {
		const fetch = stubFetch(() => Response.json(chatCompletion()))
		restore = fetch.restore
		const llm = llms.resolveLlm('google/gemini-3.8-flash@medium', {
			reasoning: 'low'
		})
		await generateText({
			model: llm.model,
			...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
			prompt: 'Hi'
		})

		expect(fetch.calls[0]?.url).toContain('openrouter.ai')
		expect(fetch.bodies()[0]).toMatchObject({
			model: 'google/gemini-3.8-flash',
			reasoning: { effort: 'medium' },
			usage: { include: true },
			provider: { order: ['google-ai-studio'] }
		})
	})

	test('Instant uses the exact direct alias without reasoning or sampling overrides', async () => {
		const fetch = stubFetch(() =>
			Response.json({
				id: 'resp_test',
				model: 'chat-latest',
				created_at: 1,
				status: 'completed',
				output: [
					{
						type: 'message',
						id: 'msg_test',
						role: 'assistant',
						status: 'completed',
						content: [{ type: 'output_text', text: 'Hello', annotations: [] }]
					}
				],
				usage: {
					input_tokens: 100,
					output_tokens: 2,
					total_tokens: 102,
					input_tokens_details: { cached_tokens: 50 },
					output_tokens_details: { reasoning_tokens: 0 }
				}
			})
		)
		restore = fetch.restore
		const llm = llms.resolveLlm('openai-direct/chat-latest', {
			reasoning: 'off'
		})
		const result = await generateText({
			model: llm.model,
			...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
			prompt: 'Hello',
			temperature: 0.4,
			tools: {
				lookup: tool({
					description: 'Look up an item',
					inputSchema: z.object({
						query: z.string(),
						limit: z.number().optional()
					})
				})
			}
		})

		expect(result.text).toBe('Hello')
		expect(fetch.calls[0]?.url).toBe('https://api.openai.com/v1/responses')
		const body = fetch.bodies()[0]
		expect(body).toMatchObject({
			model: 'chat-latest',
			store: false,
			tools: [{ type: 'function', name: 'lookup', strict: false }]
		})
		expect(body).not.toHaveProperty('reasoning')
		expect(body).not.toHaveProperty('temperature')
		expect(() =>
			llms.resolveLlm('openai-direct/chat-latest', { reasoning: 'low' })
		).toThrow('no configurable reasoning effort')
	})

	test('Requesty sends the upstream id and reasoning setting, and preserves streamed usage', async () => {
		const model = 'sference/glm-5.3'
		const fetch = stubFetch(() =>
			sse([
				chunk(model, { reasoning_content: 'Considering the request.' }),
				chunk(model, { content: 'Hello ' }),
				chunk(model, { content: 'there!' }, 'stop'),
				{
					...chunk(model, {}),
					choices: [],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 30,
						completion_tokens_details: { reasoning_tokens: 20 },
						prompt_tokens_details: { cached_tokens: 40 },
						cost: 0.002
					}
				}
			])
		)
		restore = fetch.restore
		const llm = llms.resolveLlm('requesty/sference/glm-5.3', {
			reasoning: 'low'
		})
		const result = streamText({
			model: llm.model,
			...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
			prompt: 'Hello'
		})
		await result.consumeStream()

		expect(await result.text).toBe('Hello there!')
		expect(await result.reasoningText).toBe('Considering the request.')
		expect((await result.totalUsage).outputTokenDetails).toEqual({
			textTokens: 10,
			reasoningTokens: 20
		})
		expect((await result.totalUsage).inputTokenDetails.cacheReadTokens).toBe(40)
		expect(extractRequestyCostUsd((await result.steps)[0])).toBe(0.002)
		expect(fetch.calls[0]?.url).toBe(
			'https://router.requesty.ai/v1/chat/completions'
		)
		expect(fetch.bodies()[0]).toMatchObject({
			model,
			reasoning_effort: 'low',
			stream: true,
			stream_options: { include_usage: true }
		})
		expect(
			new Headers(fetch.calls[0]?.init?.headers).get('authorization')
		).toBe('Bearer test-requesty-key')
	})

	test('Inception sends instant effort for OFF, a clamped temperature, and an estimated cost', async () => {
		const model = 'mercury-2.5'
		const fetch = stubFetch(() =>
			sse([
				chunk(model, { content: 'Hello ' }),
				chunk(model, { content: 'there!' }, 'stop'),
				{
					...chunk(model, {}),
					choices: [],
					usage: {
						prompt_tokens: 1_000_000,
						completion_tokens: 1_000_000,
						total_tokens: 2_000_000,
						completion_tokens_details: { reasoning_tokens: 0 },
						prompt_tokens_details: { cached_tokens: 40 }
					}
				}
			])
		)
		restore = fetch.restore
		const llm = llms.resolveLlm('inception/mercury-2.5', { reasoning: 'off' })
		const result = streamText({
			model: llm.model,
			...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
			temperature: 0.4,
			prompt: 'Hello'
		})
		await result.consumeStream()
		const usage = await result.totalUsage

		expect(fetch.bodies()[0]).toMatchObject({
			model,
			reasoning_effort: 'instant',
			temperature: 0.5
		})
		expect(
			await llms.cost({
				modelId: llm.modelId,
				steps: result.steps,
				usage: {
					inputTokens: usage.inputTokens ?? null,
					outputTokens: usage.outputTokens ?? null
				}
			})
		).toEqual({ usd: 0.19, estimated: true })
	})
})

describe('zero-data-retention routing and output caps', () => {
	test('sends the pinned routing, usage reporting and the cap', async () => {
		const fetch = stubFetch(() => Response.json(chatCompletion('Hej')))
		restore = fetch.restore
		const { model } = privacy.resolveLlm('anthropic/claude-haiku-5.5', {
			maxOutputTokens: 4_096
		})
		await generateText({ model, prompt: 'Hej' })

		expect(
			new Headers(fetch.calls[0]?.init?.headers).get('authorization')
		).toBe('Bearer synthetic-assistant-key')
		expect(fetch.bodies()[0]).toEqual(
			expect.objectContaining({
				model: 'anthropic/claude-haiku-5.5',
				max_tokens: 4_096,
				usage: { include: true },
				provider: {
					zdr: true,
					data_collection: 'deny',
					order: ['google-vertex/europe'],
					only: ['google-vertex/europe'],
					allow_fallbacks: false
				}
			})
		)
	})

	test('keeps a call within the cap and on the pinned endpoint whatever the caller asks', async () => {
		const fetch = stubFetch(() => Response.json(chatCompletion('Hej')))
		restore = fetch.restore
		const { model } = privacy.resolveLlm('anthropic/claude-sonnet-5.5', {
			maxOutputTokens: 8_192
		})
		await generateText({
			model,
			prompt: 'Hej',
			maxOutputTokens: 100_000,
			providerOptions: {
				openrouter: {
					provider: { only: ['anthropic'] },
					models: ['openai/gpt-5'],
					reasoning: { effort: 'high' }
				}
			}
		})

		const body = fetch.bodies()[0]
		expect(body).toEqual(
			expect.objectContaining({
				model: 'anthropic/claude-sonnet-5.5',
				max_tokens: 8_192,
				reasoning: { effort: 'high' },
				provider: expect.objectContaining({ only: ['google-vertex/europe'] })
			})
		)
		expect(body).not.toHaveProperty('models')
	})

	test('makes one request when the provider fails, leaving retries to the caller', async () => {
		const fetch = stubFetch(() =>
			Response.json({ error: { message: 'Overloaded' } }, { status: 503 })
		)
		restore = fetch.restore
		const { model } = privacy.resolveLlm('anthropic/claude-haiku-5.5')

		await expect(
			model.doGenerate({
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hej' }] }]
			})
		).rejects.toThrow()
		expect(fetch.calls).toHaveLength(1)
	})

	test('refuses a model without privacy routing before any request', () => {
		const fetch = stubFetch(() => Response.json(chatCompletion()))
		restore = fetch.restore
		expect(() => privacy.resolveLlm('openai/gpt-5')).toThrow(
			'Unsupported OpenRouter privacy routing model: openai/gpt-5'
		)
		expect(fetch.calls).toHaveLength(0)
	})
})
