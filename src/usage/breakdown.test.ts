import { describe, expect, mock, test } from 'bun:test'
import type { Mastra } from '@mastra/core'

import {
	USAGE_BREAKDOWN_MAX_GROUPS,
	type UsageBreakdownRow,
	averageCostPerGroup,
	medianCostPerGroup,
	readUsageBreakdown
} from './breakdown'

const FROM = new Date('2026-10-01T00:00:00.000Z')
const TO = new Date('2026-10-17T00:00:00.000Z')

interface BreakdownGroup {
	readonly dimensions: Record<string, string | null>
	readonly value: number
	readonly estimatedCost?: number | null
}

describe('readUsageBreakdown', () => {
	test.each(['userId', 'threadId', 'entityName'] as const)(
		'should return one row per %s with its tokens and recorded cost',
		async (groupBy) => {
			// Given input and output token totals for two groups, where only the input carries the reported cost,
			// and one group read most of its input from the prompt cache
			const { mastra, getMetricBreakdown } = fakeMastra({
				input: [
					{ dimensions: { [groupBy]: 'a' }, value: 9_000, estimatedCost: 0.03 },
					{ dimensions: { [groupBy]: 'b' }, value: 1_000, estimatedCost: 0.01 }
				],
				output: [
					{ dimensions: { [groupBy]: 'a' }, value: 400, estimatedCost: null },
					{ dimensions: { [groupBy]: 'b' }, value: 100, estimatedCost: 0.002 }
				],
				cacheRead: [
					{ dimensions: { [groupBy]: 'a' }, value: 8_000, estimatedCost: 0.5 }
				],
				cacheWrite: [{ dimensions: { [groupBy]: 'b' }, value: 900 }]
			})

			// When the usage is read for the window
			const rows = await readUsageBreakdown({
				mastra,
				groupBy,
				from: FROM,
				to: TO
			})

			// Then each group has its tokens, its cache share, and the sum of the costs Mastra recorded on the totals
			expect(rows).toEqual([
				{
					group: 'a',
					inputTokens: 9_000,
					cacheReadTokens: 8_000,
					cacheWriteTokens: 0,
					outputTokens: 400,
					cost: 0.03
				},
				{
					group: 'b',
					inputTokens: 1_000,
					cacheReadTokens: 0,
					cacheWriteTokens: 900,
					outputTokens: 100,
					cost: 0.012
				}
			])
			expect(getMetricBreakdown).toHaveBeenCalledWith({
				name: ['mastra_model_total_input_tokens'],
				groupBy: [groupBy],
				aggregation: 'sum',
				filters: { timestamp: { start: FROM, end: TO, endExclusive: true } },
				limit: USAGE_BREAKDOWN_MAX_GROUPS
			})
		}
	)

	test('should leave the cost out of a group Mastra recorded no cost for', async () => {
		// Given a user whose calls had neither a reported cost nor a listed price
		const { mastra } = fakeMastra({
			input: [
				{ dimensions: { userId: 'user-1' }, value: 500, estimatedCost: null }
			],
			output: [{ dimensions: { userId: 'user-1' }, value: 50 }]
		})

		// When the usage is read
		const rows = await readUsageBreakdown({
			mastra,
			groupBy: 'userId',
			from: FROM,
			to: TO
		})

		// Then the user has tokens and no cost
		expect(rows).toEqual([
			{
				group: 'user-1',
				inputTokens: 500,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 50,
				cost: undefined
			}
		])
	})
})

describe('averageCostPerGroup and medianCostPerGroup', () => {
	test('should average and take the median over the groups with a recorded cost', () => {
		// Given four users, one of them without a recorded cost
		const rows = [
			usageRow(0.01),
			usageRow(0.05),
			usageRow(0.03),
			usageRow(undefined)
		]

		// When the cost per user is summarised
		const average = averageCostPerGroup(rows)
		const median = medianCostPerGroup(rows)

		// Then the user without a cost is not counted as free
		expect(average).toBeCloseTo(0.03)
		expect(median).toBeCloseTo(0.03)
	})

	test('should take the middle of the two middle costs for an even number of groups', () => {
		// Given four users with a recorded cost
		const rows = [usageRow(0.04), usageRow(0.01), usageRow(0.02), usageRow(0.1)]

		// When the median cost per user is taken
		const median = medianCostPerGroup(rows)

		// Then it lies between the second and third cost
		expect(median).toBeCloseTo(0.03)
	})

	test('should have no average or median without a recorded cost', () => {
		// Given users without a recorded cost
		const rows = [usageRow(undefined), usageRow(undefined)]

		// When the cost per user is summarised
		// Then there is nothing to summarise
		expect(averageCostPerGroup(rows)).toBeUndefined()
		expect(medianCostPerGroup(rows)).toBeUndefined()
	})
})

function fakeMastra(totals: {
	readonly input: readonly BreakdownGroup[]
	readonly output: readonly BreakdownGroup[]
	readonly cacheRead?: readonly BreakdownGroup[]
	readonly cacheWrite?: readonly BreakdownGroup[]
}) {
	const byMetric: Record<string, readonly BreakdownGroup[] | undefined> = {
		mastra_model_total_input_tokens: totals.input,
		mastra_model_total_output_tokens: totals.output,
		mastra_model_input_cache_read_tokens: totals.cacheRead,
		mastra_model_input_cache_write_tokens: totals.cacheWrite
	}
	const getMetricBreakdown = mock(
		async (args: { readonly name: readonly string[] }) => ({
			groups: args.name.flatMap((name) => byMetric[name] ?? [])
		})
	)
	const observability = { getMetricBreakdown }
	const mastra = {
		getStorage: () => ({
			getStore: async (name: string) =>
				name === 'observability' ? observability : undefined
		})
	} as unknown as Mastra

	return { mastra, getMetricBreakdown }
}

function usageRow(cost: number | undefined): UsageBreakdownRow {
	return {
		group: crypto.randomUUID(),
		inputTokens: 1_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 100,
		cost
	}
}
