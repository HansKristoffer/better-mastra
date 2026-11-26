import { describe, expect, test } from 'bun:test'

import { COST_BUDGET_STOP_REASON } from '../protocol/index.js'
import { addUpUsage } from './processors.js'
import {
	createHarness,
	LOOKUP_TOOL,
	readTurn,
	requestContext,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'

function costHarness(
	cost: (spent: { steps: readonly unknown[] }) => number | null,
	maxUsd: number
) {
	const priced: number[] = []
	const harness = createHarness({
		replies: [
			toolCallReply(LOOKUP_TOOL, { category: 'food' }, 'call-1'),
			toolCallReply(LOOKUP_TOOL, { category: 'rent' }, 'call-2'),
			toolCallReply(LOOKUP_TOOL, { category: 'fun' }, 'call-3'),
			textReply('Done.')
		],
		maxSteps: 6
	})
	const prepare = harness.deps.prepare
	;(harness.deps as { prepare: typeof prepare }).prepare = async (input) => {
		const prepared = await prepare(input)
		return {
			...prepared,
			requestContext: requestContext.create(input.scope, input.threadKey),
			plan: {
				...prepared.plan,
				costBudget: {
					maxUsd,
					cost: ({ steps }) => {
						priced.push(steps.length)
						return cost({ steps })
					}
				}
			}
		}
	}

	return { harness, priced }
}

describe('a turn with a cost budget', () => {
	test('should stop before the model call that would follow the spend passing the cap', async () => {
		// Given steps that cost one cent each and a cap of 1.5 cents
		const { harness, priced } = costHarness(
			({ steps }) => steps.length * 0.01,
			0.015
		)

		// When the model keeps calling tools
		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Everything?')] })
		)

		// Then the third model call never happened, and the turn says why
		expect(harness.model.doStreamCalls).toHaveLength(2)
		expect(priced).toEqual([1, 2])
		expect(chunks).toContainEqual(
			expect.objectContaining({
				type: 'data-tripwire',
				data: expect.objectContaining({ reason: COST_BUDGET_STOP_REASON })
			})
		)
		expect(harness.finished[0]?.outcome).toBe('budget_stop')
	})

	test('should never stop a run its model has no price for', async () => {
		const { harness } = costHarness(() => null, 0.000_001)

		await readTurn(
			await harness.run({ messages: [userMessage('Everything?')] })
		)

		expect(harness.model.doStreamCalls).toHaveLength(4)
		expect(harness.finished[0]?.outcome).toBe('answered')
	})

	test('should add up the tokens of the steps, keeping a count no step reported as null', () => {
		expect(
			addUpUsage([
				{ usage: { inputTokens: 10, outputTokens: 5 } },
				{ usage: { inputTokens: 20, outputTokens: 1, cachedInputTokens: 8 } }
			])
		).toEqual({ inputTokens: 30, outputTokens: 6, cachedInputTokens: 8 })
		expect(addUpUsage([{}])).toEqual({
			inputTokens: null,
			outputTokens: null,
			cachedInputTokens: null
		})
	})
})
