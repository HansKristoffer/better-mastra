/**
 * Cost estimates for routes that do not report their own spend.
 *
 * OpenRouter and Requesty return the real billed number per step, so they are
 * never estimated. Vertex, Inception and the direct OpenAI and Anthropic APIs
 * report nothing, so those routes are priced from a table and every number
 * derived from it is flagged `estimated: true`. Coarse on purpose: it ranks
 * models against each other and gives a usage row some cost, it does not
 * reconcile an invoice.
 */

export type ModelRates = {
	/** USD per million input tokens. */
	input: number
	/** USD per million output tokens. */
	output: number
	/** Cache reads; without a rate they are priced as plain input. */
	cacheRead?: number
	/** Cache writes (Anthropic's 1.25x); without a rate, plain input. */
	cacheWrite?: number
}

export type ModelPricing = Readonly<Record<string, ModelRates>>

/**
 * USD per million tokens, keyed by the provider's own model id (2026-09).
 * Mercury 2.5's price is an 80%-off promotion; re-check when it ends:
 * https://docs.inceptionlabs.ai/get-started/models. chat-latest and Sonnet 5.5
 * are the list prices OpenRouter shows; Haiku 5.5 is Anthropic's list price
 * for prompts up to 100k tokens (above it every rate is 5x).
 */
export const ESTIMATED_MODEL_PRICING: ModelPricing = Object.freeze({
	'gemini-3.5-flash-lite': { input: 0.1, output: 0.4 },
	'mercury-2.5': { input: 0.04, output: 0.15 },
	'mercury-voice': { input: 0.2, output: 0.75 },
	'chat-latest': { input: 5, output: 30, cacheRead: 0.5 },
	'claude-sonnet-5-5': {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5
	},
	'claude-haiku-5-5': {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125
	}
})

/** Token totals for a call. `inputTokens` includes cache reads and writes. */
export type LlmUsageTotals = {
	inputTokens: number | null
	outputTokens: number | null
	cachedInputTokens?: number | null | undefined
	cacheWriteTokens?: number | null | undefined
}

export function estimateModelCostUsd(
	pricing: ModelPricing,
	modelId: string | null,
	usage: LlmUsageTotals | null
): number | null {
	// A route is not a price. Unknown models must not inherit another's rates.
	const rates = modelId ? pricing[modelId] : undefined
	if (!rates || !usage) return null
	if (usage.inputTokens === null && usage.outputTokens === null) return null

	const cacheRead = usage.cachedInputTokens ?? 0
	const cacheWrite = usage.cacheWriteTokens ?? 0
	const plainInput = Math.max(
		0,
		(usage.inputTokens ?? 0) - cacheRead - cacheWrite
	)
	const perToken =
		plainInput * rates.input +
		cacheRead * (rates.cacheRead ?? rates.input) +
		cacheWrite * (rates.cacheWrite ?? rates.input) +
		(usage.outputTokens ?? 0) * rates.output

	return Number((perToken / 1_000_000).toFixed(6))
}
