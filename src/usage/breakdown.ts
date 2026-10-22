import type { Mastra } from '@mastra/core'
import { TokenMetrics } from '@mastra/core/observability'
import type {
	GetMetricBreakdownArgs,
	GetMetricBreakdownResponse as MetricBreakdown
} from '@mastra/core/storage'
import { type Logger, silentLogger } from '../models/route.js'
import { sumBy } from 'hanzio'

/** One group's tokens and cost over a time window. */
export type UsageBreakdownRow = {
	/** The dimension's value (user id, thread id, agent name); undefined for calls recorded without one. */
	readonly group: string | undefined
	readonly inputTokens: number
	readonly outputTokens: number
	/** The cost Mastra recorded for the group (USD); undefined when it recorded none. */
	readonly cost: number | undefined
}

/**
 * Mastra returns at most this many groups per breakdown, the largest first.
 * A window with more is cut off: the smallest groups are missing, and a group
 * near the cut can miss its output tokens. Report this many rows as truncated.
 */
export const USAGE_BREAKDOWN_MAX_GROUPS = 1_000

/**
 * Tokens and cost per user, thread or agent from Mastra's automatic metrics,
 * over a window that ends before `to`. The cost is the one Mastra recorded
 * (the provider's reported cost, or Mastra's price list), never a guess.
 */
export async function readUsageBreakdown(input: {
	readonly mastra: Pick<Mastra, 'getStorage'>
	readonly groupBy: GetMetricBreakdownArgs['groupBy'][number]
	readonly from: Date
	readonly to: Date
	readonly logger?: Logger
}): Promise<readonly UsageBreakdownRow[]> {
	const { mastra, groupBy, from, to } = input
	const observability = await mastra.getStorage()?.getStore('observability')

	if (!observability) {
		throw new Error('The Mastra instance has no observability storage')
	}

	const readTotal = (name: string): Promise<MetricBreakdown> =>
		observability.getMetricBreakdown({
			name: [name],
			groupBy: [groupBy],
			aggregation: 'sum',
			filters: { timestamp: { start: from, end: to, endExclusive: true } },
			limit: USAGE_BREAKDOWN_MAX_GROUPS
		})

	const [inputTotals, outputTotals] = await Promise.all([
		readTotal(TokenMetrics.TOTAL_INPUT),
		readTotal(TokenMetrics.TOTAL_OUTPUT)
	])

	if (
		[inputTotals, outputTotals].some(
			(totals) => totals.groups.length >= USAGE_BREAKDOWN_MAX_GROUPS
		)
	) {
		;(input.logger ?? silentLogger).warn(
			'Usage breakdown cut off at the group limit',
			{ groupBy, limit: USAGE_BREAKDOWN_MAX_GROUPS }
		)
	}

	return toRows(groupBy, inputTotals, outputTotals)
}

/**
 * One row per group. A group's cost is the sum of both totals' costs: Mastra
 * puts a provider-reported cost on the input total, and a price-list cost on
 * each total.
 */
function toRows(
	groupBy: string,
	inputTotals: MetricBreakdown,
	outputTotals: MetricBreakdown
): readonly UsageBreakdownRow[] {
	const rows = new Map<string | undefined, UsageBreakdownRow>()

	const add = (
		breakdown: MetricBreakdown,
		tokens: 'inputTokens' | 'outputTokens'
	) => {
		for (const { dimensions, value, estimatedCost } of breakdown.groups) {
			const group = dimensions[groupBy] ?? undefined
			const row = rows.get(group) ?? {
				group,
				inputTokens: 0,
				outputTokens: 0,
				cost: undefined
			}
			const cost =
				estimatedCost == null ? row.cost : (row.cost ?? 0) + estimatedCost
			rows.set(group, { ...row, [tokens]: row[tokens] + value, cost })
		}
	}

	add(inputTotals, 'inputTokens')
	add(outputTotals, 'outputTokens')

	return [...rows.values()]
}

/** Groups without a recorded cost are left out, rather than counted as free. */
function recordedCosts(rows: readonly UsageBreakdownRow[]) {
	return rows.flatMap((row) => (row.cost === undefined ? [] : [row.cost]))
}

/** The average recorded cost per group; undefined when no group has one. */
export function averageCostPerGroup(rows: readonly UsageBreakdownRow[]) {
	return averageOf(recordedCosts(rows))
}

/** The median recorded cost per group; undefined when no group has one. */
export function medianCostPerGroup(rows: readonly UsageBreakdownRow[]) {
	return medianOf(recordedCosts(rows))
}

export function averageOf(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined
	return sumBy(values, (value) => value) / values.length
}

/** The middle value, or the mean of the two middle values. */
export function medianOf(values: readonly number[]): number | undefined {
	const sorted = [...values].sort((a, b) => a - b)
	if (sorted.length === 0) return undefined
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: sorted[middle]
}
