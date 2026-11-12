/**
 * A turn's model calls, read from the steps `runChatTurn`'s `usage` sink hands
 * over: each call's model, tokens, cost and stop reason, and the trace id
 * Mastra stamped on the answer. The steps carry the prompt and the answer
 * too; nothing of that is read.
 */

import { isRecord, sumBy } from 'hanzio'
import { z } from 'zod'

import { extractOpenRouterCostUsd } from '../models/openrouter.js'

/** One model call, without any of its text. */
export interface ModelCall {
	/** The call's response id; empty when the provider sent none. */
	readonly responseId: string
	readonly modelId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number | undefined
	readonly cacheWriteTokens: number | undefined
	/** Undefined when nothing reported the call's cost. */
	readonly costUsd: number | undefined
	readonly stopReason: string | undefined
}

/** A turn's tokens and cost over its model calls. */
export interface ModelCallTotals {
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	/** Undefined when no call reported a cost. */
	readonly costUsd: number | undefined
}

const stepSchema = z.object({
	finishReason: z.string().optional(),
	usage: z
		.object({
			inputTokens: z.number().optional(),
			outputTokens: z.number().optional(),
			cachedInputTokens: z.number().optional(),
			cacheCreationInputTokens: z.number().optional()
		})
		.optional(),
	response: z
		.object({ id: z.string().optional(), modelId: z.string().optional() })
		.optional()
})

/** A stored message as far as its trace id goes. */
const tracedMessageSchema = z.object({
	content: z.object({ metadata: z.object({ traceId: z.string().min(1) }) })
})

/**
 * Each step as a model call. `modelId` names a call whose response names no
 * model; `costOf` reads a step's cost, by default the one OpenRouter reports.
 */
export function readModelCalls(
	steps: readonly unknown[],
	modelId: string,
	options: {
		readonly costOf?: (step: unknown) => number | undefined
	} = {}
): ModelCall[] {
	const costOf = options.costOf ?? extractOpenRouterCostUsd

	return steps.flatMap((step) => {
		const parsed = stepSchema.safeParse(step)

		if (!parsed.success) return []

		const { finishReason, usage, response } = parsed.data

		return [
			{
				responseId: response?.id ?? '',
				modelId: response?.modelId || modelId,
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				cacheReadTokens: usage?.cachedInputTokens,
				cacheWriteTokens: usage?.cacheCreationInputTokens,
				costUsd: costOf(step),
				stopReason: finishReason
			}
		]
	})
}

/**
 * The turn's trace id: Mastra writes the root span's trace id into the
 * metadata of the answer it builds from the steps, the value the stored
 * answer keeps. Undefined when the turn ran without tracing.
 */
export function readTurnTraceId(steps: readonly unknown[]): string | undefined {
	for (const step of steps) {
		for (const message of responseMessages(step)) {
			const parsed = tracedMessageSchema.safeParse(message)

			if (parsed.success) return parsed.data.content.metadata.traceId
		}
	}

	return undefined
}

/** The calls' tokens and cost added up. */
export function totalModelCalls(calls: readonly ModelCall[]): ModelCallTotals {
	const costs = calls.flatMap((call) =>
		call.costUsd === undefined ? [] : [call.costUsd]
	)

	return {
		inputTokens: sumBy(calls, 'inputTokens'),
		outputTokens: sumBy(calls, 'outputTokens'),
		cacheReadTokens: sumBy(calls, (call) => call.cacheReadTokens ?? 0),
		cacheWriteTokens: sumBy(calls, (call) => call.cacheWriteTokens ?? 0),
		costUsd: costs.length > 0 ? sumBy(costs, (cost) => cost) : undefined
	}
}

/** A step's stored response messages; Mastra may hand them over through a getter. */
function responseMessages(step: unknown): readonly unknown[] {
	const response = isRecord(step) ? step.response : undefined

	return isRecord(response) && Array.isArray(response.dbMessages)
		? response.dbMessages
		: []
}
