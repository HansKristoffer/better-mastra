import { describe, expect, test } from 'bun:test'

import { markConversationForCache } from './promptCache.js'

type Prompt = Parameters<typeof markConversationForCache>[0]
type PromptMessage = Prompt[number]

const MARKER = {
	anthropic: { cacheControl: { type: 'ephemeral' } },
	openrouter: { cacheControl: { type: 'ephemeral' } }
}

const instructions: PromptMessage = {
	role: 'system',
	content: 'Stable instructions.',
	providerOptions: MARKER
}

const question: PromptMessage = {
	role: 'user',
	content: [{ type: 'text', text: 'Hvad har vi brugt på mad?' }]
}

const signal: PromptMessage = {
	role: 'user',
	content: [
		{
			type: 'text',
			text: '<system-reminder>Now, on the budget.</system-reminder>'
		}
	]
}

describe('markConversationForCache', () => {
	test('should mark the newest user message before a tool hop and the last result of the hop', () => {
		// Given a step after two lookups the model asked for at once
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

		// When the conversation is marked for the cache
		const marked = markConversationForCache([
			instructions,
			question,
			signal,
			lookups,
			{ role: 'tool', content: [firstResult, lastResult] }
		])

		// Then the signal before the hop and the hop's last result carry a marker, and nothing else gains one
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

	test('should keep what a marked message already tells the provider', () => {
		// Given a last message that carries the model's reasoning details
		const reasoningDetails = [{ type: 'reasoning.text', text: 'Tænker.' }]
		const answer: PromptMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'Du har brugt 1.250 kr.' }],
			providerOptions: { openrouter: { reasoning_details: reasoningDetails } }
		}

		// When the conversation is marked for the cache
		const marked = markConversationForCache([question, answer])

		// Then the answer carries the marker beside its reasoning details
		expect(marked).toEqual([
			{ ...question, providerOptions: MARKER },
			{
				...answer,
				providerOptions: {
					...MARKER,
					openrouter: {
						reasoning_details: reasoningDetails,
						cacheControl: { type: 'ephemeral' }
					}
				}
			}
		])
	})
})
