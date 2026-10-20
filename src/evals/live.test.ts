import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { answerRuleChecks, detectReplyLanguage } from './checks.js'
import { newestTurn, shouldScore } from './live.js'

test('samples a share of the turns, never an excluded scope', () => {
	const sample = (random: number, scope = 'org_score') =>
		shouldScore({ share: 0.1, scope, exclude: ['org_own'], random })
	expect([sample(0.05), sample(0.5), sample(0, 'org_own')]).toEqual([
		true,
		false,
		false
	])
})

describe('the newest turn of a thread', () => {
	const messages: UIMessage[] = [
		{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Old question' }] },
		{
			id: 'a1',
			role: 'assistant',
			parts: [{ type: 'text', text: 'Old answer' }]
		},
		{
			id: 'u2',
			role: 'user',
			parts: [{ type: 'text', text: 'Hvor mange samtaler fik vi i går?' }]
		},
		{
			id: 'a2',
			role: 'assistant',
			parts: [
				{
					type: 'tool-analytics_query',
					toolCallId: 'c1',
					state: 'output-available',
					input: { day: 'yesterday' },
					output: { count: 2 }
				},
				{
					type: 'tool-deal_markWon',
					toolCallId: 'c2',
					state: 'approval-requested',
					input: {},
					approval: { id: 'p1' }
				},
				{
					type: 'text',
					text: 'Old Name here: you had two conversations yesterday, and the assistant answered both of them.'
				}
			]
		}
	]

	test('is the last user message and everything after it', () => {
		const turn = newestTurn(messages)
		expect(turn).toEqual(
			expect.objectContaining({
				assistantMessageId: 'a2',
				userText: 'Hvor mange samtaler fik vi i går?',
				heldForApproval: ['deal_markWon'],
				toolCalls: [
					expect.objectContaining({
						name: 'analytics_query',
						output: { count: 2 }
					}),
					expect.objectContaining({ name: 'deal_markWon' })
				]
			})
		)
	})

	test('is scored with the offline answer rules', () => {
		const turn = newestTurn(messages)!
		const failed = answerRuleChecks(
			{
				turns: [turn],
				language: detectReplyLanguage(turn.userText),
				pageData: undefined
			},
			{
				forbidReply: [
					{ check: 'says Acme, never Old Name', pattern: /old name/i }
				]
			}
		)
			.filter((check) => !check.pass)
			.map((check) => check.check)
		expect(failed).toEqual(['replies in da', 'says Acme, never Old Name'])
	})

	test('is null without a user message', () => {
		expect(newestTurn([])).toBeNull()
	})
})
