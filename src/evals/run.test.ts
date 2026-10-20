import { describe, expect, test } from 'bun:test'
import { simulateReadableStream, type UIMessageChunk } from 'ai'
import type { EvalCase } from './case.js'
import {
	EVAL_DRY_RUN_KEY,
	type EvalTurnInput,
	mapWithConcurrency,
	runEvalCase,
	withEvalDryRun
} from './run.js'

type Page = { path: string }

const testCase: EvalCase<Page> = {
	id: 'deals/open',
	suites: ['smoke'],
	bucket: 'answer',
	persona: 'shop',
	language: 'en',
	page: { path: '/dashboard' },
	turns: [
		'Show me my open deals',
		{ text: 'And the won ones?', page: { path: '/deals' } }
	],
	expect: {}
}

const stream = (chunks: UIMessageChunk[]) =>
	simulateReadableStream({
		chunks,
		initialDelayInMs: null,
		chunkDelayInMs: null
	})

const text = (id: string, delta: string): UIMessageChunk[] => [
	{ type: 'start-step' },
	{ type: 'text-start', id },
	{ type: 'text-delta', id, delta },
	{ type: 'text-end', id },
	{ type: 'finish-step' },
	{ type: 'finish' }
]

describe('running an eval case', () => {
	test('answers client actions, resubmits the thread, and records each turn', async () => {
		const calls: EvalTurnInput<typeof testCase>[] = []
		const trace = await runEvalCase({
			case: testCase,
			modelId: 'test/model',
			answerClientAction: (call) =>
				call.name === 'navigateToPage' ? { navigated: true } : undefined,
			cost: (usage) => (usage.inputTokens ?? 0) / 1000,
			runTurn: (input) => {
				calls.push({ ...input, messages: [...input.messages] })
				input.reportUsage({
					inputTokens: 100,
					outputTokens: 10,
					cacheReadTokens: 60
				})
				if (calls.length === 1) {
					return stream([
						{ type: 'start', messageId: 'a1' },
						{ type: 'start-step' },
						{
							type: 'tool-input-available',
							toolCallId: 'c1',
							toolName: 'navigateToPage',
							input: { path: '/deals' }
						},
						{ type: 'finish-step' },
						{ type: 'finish' }
					])
				}
				return stream([
					...(input.resuming
						? []
						: [{ type: 'start', messageId: 'a2' } as const]),
					...text('t', 'You have two open deals.')
				])
			}
		})

		expect(calls.map((call) => [call.resuming, call.messages.length])).toEqual([
			[false, 1],
			[true, 2],
			[false, 1]
		])
		expect(calls[2]?.page).toEqual({ path: '/deals' })
		expect(calls[0]?.requestContext.get(EVAL_DRY_RUN_KEY)).toBe(true)
		// A resubmit sends the answered client action back.
		expect(calls[1]?.messages[1]?.parts).toContainEqual(
			expect.objectContaining({
				state: 'output-available',
				output: { navigated: true }
			})
		)

		const [first, second] = trace.turns
		expect(first).toEqual(
			expect.objectContaining({
				replyText: 'You have two open deals.',
				steps: 2,
				inputTokens: 200,
				cacheReadTokens: 120,
				outputTokens: 20,
				costUsd: 0.2,
				error: null
			})
		)
		expect(first?.toolCalls).toEqual([
			expect.objectContaining({
				name: 'navigateToPage',
				state: 'output-available',
				output: { navigated: true }
			})
		])
		expect(first?.firstTextMs).toBeGreaterThanOrEqual(0)
		expect(second?.userText).toBe('And the won ones?')
	})

	test('stops on an approval card without answering it', async () => {
		let rounds = 0
		const trace = await runEvalCase({
			case: { ...testCase, turns: ['Mark the deal won'] },
			modelId: 'test/model',
			answerClientAction: () => ({ ok: true }),
			runTurn: () => {
				rounds += 1
				return stream([
					{ type: 'start', messageId: 'a1' },
					{
						type: 'tool-input-available',
						toolCallId: 'c1',
						toolName: 'deal_markWon',
						input: {}
					},
					{ type: 'tool-approval-request', approvalId: 'p1', toolCallId: 'c1' },
					{ type: 'finish' }
				])
			}
		})
		expect(rounds).toBe(1)
		expect(trace.turns[0]?.heldForApproval).toEqual(['deal_markWon'])
	})

	test('records a failing turn and stops the case', async () => {
		const trace = await runEvalCase({
			case: testCase,
			modelId: 'test/model',
			runTurn: () => {
				throw new Error('provider down')
			}
		})
		expect(trace.turns).toHaveLength(1)
		expect(trace.turns[0]?.error).toBe('provider down')
		expect(trace.turns[0]?.costUsd).toBe(0)
	})
})

test('a dry-run tool answers with a marker inside an eval run only', async () => {
	const tool = withEvalDryRun({
		id: 'deal.markWon',
		execute: async (_input: unknown, _context: unknown): Promise<unknown> => ({
			written: true
		})
	})
	const context = (dryRun: boolean) =>
		({ requestContext: new Map([[EVAL_DRY_RUN_KEY, dryRun]]) }) as never
	expect(await tool.execute?.({} as never, context(true))).toEqual(
		expect.objectContaining({ dryRun: true, tool: 'deal.markWon' })
	)
	expect(await tool.execute?.({} as never, context(false))).toEqual({
		written: true
	})
})

test('mapWithConcurrency keeps order with a bounded pool', async () => {
	let inFlight = 0
	let peak = 0
	const results = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms) => {
		inFlight += 1
		peak = Math.max(peak, inFlight)
		await Bun.sleep(ms)
		inFlight -= 1
		return ms
	})
	expect(results).toEqual([30, 10, 20, 0])
	expect(peak).toBe(2)
})
