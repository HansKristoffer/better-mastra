import type { Mastra } from '@mastra/core'
import { TokenMetrics } from '@mastra/core/observability'
import type {
	GetMetricBreakdownArgs,
	GetMetricBreakdownResponse as MetricBreakdown
} from '@mastra/core/storage'
import { must, sortBy, sumBy } from 'hanzio'
import { type Logger, silentLogger } from '../models/route.js'

/** One group's tokens and cost over a time window. */
export type UsageBreakdownRow = {
	/** The dimension's value (user id, thread id, agent name); undefined for calls recorded without one. */
	readonly group: string | undefined
	/** Every input token, those read from and written to the prompt cache included. */
	readonly inputTokens: number
	/** Of the input tokens, those read from the provider's prompt cache. */
	readonly cacheReadTokens: number
	/** Of the input tokens, those written to the provider's prompt cache. */
	readonly cacheWriteTokens: number
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
 * over a window that ends before `to`, with the share of the input the prompt
 * cache served and stored. The cost is the one Mastra recorded (the
 * provider's reported cost, or Mastra's price list), never a guess.
 */
export async function readUsageBreakdown(input: {
	readonly mastra: Pick<Mastra, 'getStorage'>
	readonly groupBy: GetMetricBreakdownArgs['groupBy'][number]
	readonly from: Date
	readonly to: Date
	readonly logger?: Logger
}): Promise<readonly UsageBreakdownRow[]> {
	const { mastra, groupBy, from, to } = input
	const observability = must(
		await mastra.getStorage()?.getStore('observability'),
		() => new Error('The Mastra instance has no observability storage')
	)

	const readTotal = (name: string): Promise<MetricBreakdown> =>
		observability.getMetricBreakdown({
			name: [name],
			groupBy: [groupBy],
			aggregation: 'sum',
			filters: { timestamp: { start: from, end: to, endExclusive: true } },
			limit: USAGE_BREAKDOWN_MAX_GROUPS
		})

	const [inputTotals, outputTotals, cacheReads, cacheWrites] =
		await Promise.all([
			readTotal(TokenMetrics.TOTAL_INPUT),
			readTotal(TokenMetrics.TOTAL_OUTPUT),
			readTotal(TokenMetrics.INPUT_CACHE_READ),
			readTotal(TokenMetrics.INPUT_CACHE_WRITE)
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

	return toRows(groupBy, {
		inputTokens: inputTotals,
		outputTokens: outputTotals,
		cacheReadTokens: cacheReads,
		cacheWriteTokens: cacheWrites
	})
}

type TokenField = Exclude<keyof UsageBreakdownRow, 'group' | 'cost'>

/** The cache metrics are parts of the input total, whose cost already counts them. */
const COSTED_FIELDS: readonly TokenField[] = ['inputTokens', 'outputTokens']

/**
 * One row per group. A group's cost is the sum of both totals' costs: Mastra
 * puts a provider-reported cost on the input total, and a price-list cost on
 * each total.
 */
function toRows(
	groupBy: string,
	breakdowns: Readonly<Record<TokenField, MetricBreakdown>>
): readonly UsageBreakdownRow[] {
	const rows = new Map<string | undefined, UsageBreakdownRow>()

	for (const tokens of Object.keys(breakdowns) as TokenField[]) {
		for (const { dimensions, value, estimatedCost } of breakdowns[tokens]
			.groups) {
			const group = dimensions[groupBy] ?? undefined
			const row = rows.get(group) ?? {
				group,
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
				cost: undefined
			}
			const cost =
				estimatedCost == null || !COSTED_FIELDS.includes(tokens)
					? row.cost
					: (row.cost ?? 0) + estimatedCost
			rows.set(group, { ...row, [tokens]: row[tokens] + value, cost })
		}
	}

	return [...rows.values()]
}

/** Groups without a recorded cost are left out, rather than counted as free. */
function recordedCosts(rows: readonly Pick<UsageBreakdownRow, 'cost'>[]) {
	return rows.flatMap((row) => (row.cost === undefined ? [] : [row.cost]))
}

/** The average recorded cost per group; undefined when no group has one. */
export function averageCostPerGroup(
	rows: readonly Pick<UsageBreakdownRow, 'cost'>[]
) {
	return averageOf(recordedCosts(rows))
}

/** The median recorded cost per group; undefined when no group has one. */
export function medianCostPerGroup(
	rows: readonly Pick<UsageBreakdownRow, 'cost'>[]
) {
	return medianOf(recordedCosts(rows))
}

export function averageOf(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined
	return sumBy(values, (value) => value) / values.length
}

/** The middle value, or the mean of the two middle values. */
export function medianOf(values: readonly number[]): number | undefined {
	const sorted = sortBy(values)
	if (sorted.length === 0) return undefined
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: sorted[middle]
}
