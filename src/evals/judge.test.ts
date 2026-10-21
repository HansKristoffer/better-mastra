import { describe, expect, test } from 'bun:test'
import {
	createAgentTestRun,
	createTestMessage
} from '@mastra/evals/scorers/utils'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
	defaultJudgeSystem,
	defineJudge,
	type JudgeVerdict,
	renderTranscript
} from './judge.js'

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 }
}

/** A judge model that answers every call with the output as JSON, and keeps the prompts it saw. */
function judgeModel(output: unknown) {
	const text = JSON.stringify(output)
	const prompts: string[] = []
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(JSON.stringify(options.prompt))
			return {
				content: [{ type: 'text', text }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage: USAGE,
				warnings: []
			}
		},
		doStream: async (options) => {
			prompts.push(JSON.stringify(options.prompt))
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start', warnings: [] },
						{ type: 'text-start', id: 't' },
						{ type: 'text-delta', id: 't', delta: text },
						{ type: 'text-end', id: 't' },
						{
							type: 'finish',
							finishReason: { unified: 'stop', raw: 'stop' },
							usage: USAGE
						}
					]
				})
			}
		}
	})
	return { model, prompts }
}

const verdict: JudgeVerdict = {
	outcome: 'partly',
	grounded: true,
	concise: true,
	naturalLanguage: true,
	frictions: [{ fault: 'toolContract', what: 'Read the wrong month.' }]
}

describe('a judge', () => {
	test('judges a transcript with the page, facts and task in the prompt', async () => {
		const { model, prompts } = judgeModel(verdict)
		const judge = defineJudge({
			version: 'test-v1',
			model,
			system: defaultJudgeSystem({ assistant: 'Helper', user: 'staff member' })
		})
		const result = await judge.judge({
			page: { path: '/deals', title: 'Deals' },
			instructionFacts: { plan: 'pro' },
			task: 'Answers from the tools, changing nothing.',
			turns: [
				{
					userText: 'How many open deals?',
					replyText: 'Two.',
					toolCalls: [
						{
							name: 'deal_list',
							input: {},
							output: { count: 2 },
							errorText: null
						}
					]
				}
			]
		})
		expect(result).toEqual(verdict)
		expect(prompts[0]).toContain('Answers from the tools, changing nothing.')
		expect(prompts[0]).toContain('deal_list')
		expect(prompts[0]).toContain('Helper')
	})

	test('scores a Mastra run with the same rubric', async () => {
		const { model } = judgeModel(verdict)
		const scorer = defineJudge({
			version: 'test-v1',
			model,
			system: 'Judge.'
		}).scorer()
		const result = await scorer.run(
			createAgentTestRun({
				inputMessages: [
					createTestMessage({ role: 'user', content: 'How many?' })
				],
				output: [createTestMessage({ role: 'assistant', content: 'Two.' })]
			})
		)
		expect(result).toEqual(expect.objectContaining({ score: 0.5 }))
		expect(scorer.id).toBe('judge-test-v1')
	})

	test('judges through the app generate hook, which needs no model', async () => {
		const requests: { system: string; prompt: string }[] = []
		const judge = defineJudge({
			version: 'test-v1',
			system: 'Judge.',
			generate: async (request) => {
				requests.push({ system: request.system, prompt: request.prompt })
				return { ...verdict, outcome: 'done' as const }
			}
		})

		const judged = await judge.judge({
			turns: [{ userText: 'How many?', replyText: 'Two.', toolCalls: [] }]
		})

		expect(judged.outcome).toBe('done')
		expect(requests).toEqual([
			{ system: 'Judge.', prompt: expect.stringContaining('User: How many?') }
		])
		expect(() => judge.scorer()).toThrow('has no model')
	})
})

test('a transcript clips long tool payloads and shows errors', () => {
	const transcript = renderTranscript([
		{
			userText: 'Hi',
			replyText: '',
			toolCalls: [
				{ name: 'big', input: {}, output: 'x'.repeat(2000), errorText: null },
				{ name: 'bad', input: {}, output: null, errorText: 'boom' }
			]
		}
	])
	expect(transcript).toContain(`${'x'.repeat(1500)}…`)
	expect(transcript).toContain('Tool bad({}) -> ERROR boom')
	expect(transcript).toContain('Assistant: (no text)')
})
