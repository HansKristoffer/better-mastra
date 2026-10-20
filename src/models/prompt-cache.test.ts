import { describe, expect, it, test } from 'bun:test'
import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import { generateText } from 'ai'
import {
	markConversationForCache,
	movePerTurnContext,
	PER_TURN_SYSTEM_MESSAGE_OPTIONS
} from './prompt-cache'
import { createLlmRegistry } from './registry'
import { stubFetch } from './stub-fetch.test'

type PromptMessage = LanguageModelV4Prompt[number]

const user = (text: string) => ({
	role: 'user' as const,
	content: [{ type: 'text' as const, text }]
})
const assistant = (text: string) => ({
	role: 'assistant' as const,
	content: [{ type: 'text' as const, text }]
})

describe('movePerTurnContext', () => {
	const stable = {
		role: 'system' as const,
		content: 'You are Coworker.',
		providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
	}
	const perTurn = {
		role: 'system' as const,
		content: '# Current page\n/deals',
		providerOptions: PER_TURN_SYSTEM_MESSAGE_OPTIONS
	}

	it('puts the per-turn context after the newest user message, which it marks for the cache', () => {
		const prompt: LanguageModelV4Prompt = [
			stable,
			perTurn,
			user('How many deals?'),
			assistant('Twelve.'),
			user('And won?')
		]

		expect(movePerTurnContext(prompt)).toEqual([
			stable,
			user('How many deals?'),
			assistant('Twelve.'),
			{
				...user('And won?'),
				providerOptions: {
					anthropic: { cacheControl: { type: 'ephemeral' } }
				}
			},
			{ role: 'system', content: '# Current page\n/deals', providerOptions: {} }
		])
	})

	it('keeps the context in one place for every step of a turn', () => {
		const step: LanguageModelV4Prompt = [
			stable,
			perTurn,
			user('Open the biggest deal'),
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call_1',
						toolName: 'deal_getAll',
						input: {}
					}
				]
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call_1',
						toolName: 'deal_getAll',
						output: { type: 'json', value: [] }
					}
				]
			}
		]

		expect(movePerTurnContext(step).map((message) => message.role)).toEqual([
			'system',
			'user',
			'system',
			'assistant',
			'tool'
		])
	})

	it('leaves a prompt without per-turn context alone', () => {
		const prompt: LanguageModelV4Prompt = [stable, user('Hello')]
		expect(movePerTurnContext(prompt)).toBe(prompt)
	})

	it('marks for OpenRouter when asked', () => {
		const moved = movePerTurnContext([perTurn, user('Hej')], 'openrouter')
		expect(moved[0]?.providerOptions).toEqual({
			openrouter: { cacheControl: { type: 'ephemeral' } }
		})
	})

	test('the Anthropic route moves it on the wire', async () => {
		const llms = await createLlmRegistry({ keys: { anthropic: 'test-key' } })
		const fetch = stubFetch(() =>
			Response.json({
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				model: 'claude-haiku-5-5',
				content: [{ type: 'text', text: 'Hej' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 10, output_tokens: 1 }
			})
		)
		try {
			await generateText({
				model: llms.resolveLlm('anthropic-direct/claude-haiku-5-5').model,
				messages: [
					{ role: 'system', content: 'Stable.' },
					{
						role: 'system',
						content: 'Page: /deals',
						providerOptions: PER_TURN_SYSTEM_MESSAGE_OPTIONS
					},
					{ role: 'user', content: 'Hej' }
				],
				allowSystemInMessages: true
			})
			const body = fetch.bodies()[0] as { system?: unknown; messages: unknown }
			expect(JSON.stringify(body.system)).not.toContain('/deals')
			expect(JSON.stringify(body.messages)).toContain('/deals')
		} finally {
			fetch.restore()
		}
	})
})

const MARKER = { openrouter: { cacheControl: { type: 'ephemeral' } } }

const instructions: PromptMessage = {
	role: 'system',
	content: 'Stable instructions.',
	providerOptions: MARKER
}

const question: PromptMessage = user('Hvad har vi brugt på mad?')

const signal: PromptMessage = user(
	'<system-reminder>Now, on the budget.</system-reminder>'
)

describe('markConversationForCache', () => {
	test('marks the newest user message before a tool hop and the last result of the hop', () => {
		const lookups: PromptMessage = {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'lookup',
					input: {}
				},
				{
					type: 'tool-call',
					toolCallId: 'call-2',
					toolName: 'lookup',
					input: {}
				}
			]
		}
		const firstResult = {
			type: 'tool-result',
			toolCallId: 'call-1',
			toolName: 'lookup',
			output: { type: 'json', value: { spent: 1_250 } }
		} as const
		const lastResult = { ...firstResult, toolCallId: 'call-2' } as const

		const marked = markConversationForCache([
			instructions,
			question,
			signal,
			lookups,
			{ role: 'tool', content: [firstResult, lastResult] }
		])

		expect(marked).toEqual([
			instructions,
			question,
			{ ...signal, providerOptions: MARKER },
			lookups,
			{
				role: 'tool',
				content: [firstResult, { ...lastResult, providerOptions: MARKER }]
			}
		])
	})

	test('keeps what a marked message already tells OpenRouter', () => {
		const reasoningDetails = [{ type: 'reasoning.text', text: 'Tænker.' }]
		const answer: PromptMessage = {
			...assistant('Du har brugt 1.250 kr.'),
			providerOptions: { openrouter: { reasoning_details: reasoningDetails } }
		}

		expect(markConversationForCache([question, answer])).toEqual([
			{ ...question, providerOptions: MARKER },
			{
				...answer,
				providerOptions: {
					openrouter: {
						reasoning_details: reasoningDetails,
						cacheControl: { type: 'ephemeral' }
					}
				}
			}
		])
	})
})
