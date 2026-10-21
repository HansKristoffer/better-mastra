import { describe, expect, test } from 'bun:test'
import type { EvalCase, EvalToolCall, EvalTrace } from './case.js'
import {
	checkTrace,
	DEFAULT_LANGUAGE_WORDS,
	detectReplyLanguage,
	type EvalCheckOptions,
	inventedLinkIds
} from './checks.js'

const baseCase: EvalCase<{ path: string; data?: unknown }> = {
	id: 'test/case',
	suites: ['smoke'],
	bucket: 'answer',
	persona: 'shop',
	language: 'en',
	page: { path: '/dashboard' },
	turns: ['How are we doing?'],
	expect: { noWrites: true }
}

const options: EvalCheckOptions = {
	toolName: (name) => name.replaceAll('.', '_'),
	isWrite: (call) =>
		call.name !== 'navigateToPage' && !call.name.startsWith('analytics_'),
	isClientAction: (name) => !name.includes('_'),
	pageData: (page) => (page as { data?: unknown } | undefined)?.data,
	forbidReply: [{ check: 'says Acme, never Old Name', pattern: /old name/i }]
}

function trace(
	replyText: string,
	toolCalls: Partial<EvalToolCall>[] = []
): EvalTrace {
	return {
		caseId: 'test/case',
		modelId: 'test',
		turns: [
			{
				userText: 'How are we doing?',
				replyText,
				toolCalls: toolCalls.map((call) => ({
					name: 'unknown',
					state: 'output-available',
					input: {},
					output: {},
					errorText: null,
					...call
				})),
				heldForApproval: [],
				error: null,
				firstTextMs: 900,
				durationMs: 2000,
				steps: 1,
				inputTokens: 100,
				cacheReadTokens: 80,
				cacheWriteTokens: 0,
				outputTokens: 20,
				costUsd: 0.001
			}
		]
	}
}

const failed = (testCase: EvalCase<unknown>, run: EvalTrace) =>
	checkTrace(testCase, run, options)
		.filter((check) => !check.pass)
		.map((check) => check.check)

describe('the eval checks', () => {
	test('a read and an answer in the right language pass', () => {
		expect(
			failed(
				baseCase,
				trace(
					'You had 42 conversations last week, and the assistant answered most of them.',
					[{ name: 'analytics_query' }]
				)
			)
		).toEqual([])
	})

	test('a write in a case that must change nothing fails, while moving the user does not', () => {
		expect(
			failed(
				baseCase,
				trace('Done, I have changed it for you and the team.', [
					{ name: 'navigateToPage' },
					{ name: 'organization_updateNotes' }
				])
			)
		).toEqual(['changes nothing'])
	})

	test('an approval card held for the user counts as a write', () => {
		const held = trace('I have prepared the change for you to confirm.')
		held.turns[0]?.heldForApproval.push('deal_markWon')
		expect(failed(baseCase, held)).toEqual(['changes nothing'])
	})

	test('a reply in the wrong language, or naming a forbidden name, fails', () => {
		expect(
			failed(
				{ ...baseCase, language: 'da' },
				trace(
					'Old Name here: you had 42 conversations and most of them were answered.'
				)
			)
		).toEqual(['replies in da', 'says Acme, never Old Name'])
	})

	test('a language check is named by its label when the app gives one', () => {
		const labelled = checkTrace(
			{ ...baseCase, language: 'da' },
			trace('Du har 42 samtaler, og de fleste er besvaret.'),
			{
				...options,
				languages: {
					...DEFAULT_LANGUAGE_WORDS,
					da: { ...DEFAULT_LANGUAGE_WORDS.da!, label: 'Danish' }
				}
			}
		)

		expect(labelled.map((check) => check.check)).toContain('replies in Danish')
	})

	test('the same client action twice with the same input fails', () => {
		const filter = { name: 'applyFilters', input: { stage: 'won' } }
		expect(
			failed(
				{ ...baseCase, expect: {} },
				trace('I filtered the board for you.', [filter, filter])
			)
		).toEqual(['never repeats a client action with the same input'])
	})

	test('expected tools match after the name normalizer, and inputs and replies are searched', () => {
		const testCase: EvalCase<unknown> = {
			...baseCase,
			expect: {
				tools: ['deal.get'],
				anyTool: ['deal.list', 'deal.search'],
				forbidTools: ['deal.delete'],
				toolInputMentions: { tool: 'deal.get', anyOf: ['Won'] },
				replyMentionsAny: ['412']
			}
		}
		expect(
			failed(
				testCase,
				trace('The biggest open deal is worth 412,000 for you.', [
					{ name: 'deal_get', input: { stage: 'won' } },
					{ name: 'deal_search' }
				])
			)
		).toEqual([])
		expect(
			failed(
				testCase,
				trace('There is no deal for you.', [{ name: 'deal_delete' }])
			)
		).toEqual([
			'calls deal_get',
			'calls one of deal_list, deal_search',
			'does not call deal_delete',
			'deal_get input mentions one of Won',
			'mentions one of 412'
		])
	})
})

describe('reply language', () => {
	test('tells Danish from English and gives up on a word or two', () => {
		expect(
			detectReplyLanguage(
				'Du har to åbne deals, og den største er på 412.000 kr.'
			)
		).toBe('da')
		expect(
			detectReplyLanguage(
				'You have two open deals, and the biggest is worth 412,000.'
			)
		).toBe('en')
		expect(detectReplyLanguage('OK')).toBe('unknown')
	})

	test('takes the app’s own word lists', () => {
		const languages = {
			sv: { words: ['och', 'det', 'är', 'jag', 'inte'] },
			en: { words: ['and', 'it', 'is', 'not'] }
		}
		expect(detectReplyLanguage('Det är inte jag och det', languages)).toBe('sv')
	})
})

describe('links to records', () => {
	test('flags an id no tool or page returned', () => {
		const reply =
			'See [the deal](/deals?dealId=deal_eval_1003) and [this one](/deals?dealId=deal_made_up_77)'
		expect(
			inventedLinkIds(reply, {
				pageData: { deals: [{ id: 'deal_eval_1003' }] },
				toolOutputs: []
			})
		).toEqual(['deal_made_up_77'])
	})

	test('ignores path words without digits', () => {
		expect(
			inventedLinkIds('Open [Sources](/knowledge-hub/sources)', {
				pageData: null,
				toolOutputs: []
			})
		).toEqual([])
	})

	test('a link to a record in the turn’s page data passes the trace check', () => {
		const testCase: EvalCase<{ path: string; data?: unknown }> = {
			...baseCase,
			turns: [
				{
					text: 'Which deal is biggest?',
					page: { path: '/deals', data: { id: 'deal_eval_1003' } }
				}
			]
		}
		expect(
			failed(
				testCase,
				trace(
					'The biggest is [this deal](/deals?dealId=deal_eval_1003) for you.'
				)
			)
		).toEqual([])
	})
})
