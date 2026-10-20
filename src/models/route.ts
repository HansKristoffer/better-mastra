import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { LlmEffort } from './effort.js'
import type { LlmUsageTotals } from './pricing.js'

/** `usd` is null when unknown - never zero. `estimated` marks a table price. */
export type LlmCost = { usd: number | null; estimated: boolean }

export type LlmCostInput = {
	/** The call's steps (a `streamText`/`generateText` result's, or `[result]`). */
	steps: PromiseLike<readonly unknown[]> | readonly unknown[] | null
	providerModelId: string
	usage: LlmUsageTotals | null
}

/**
 * Everything a model id's route knows: its SDK model, how it says "think
 * this much", and how its cost is read. Without `cost` the registry prices
 * the call from its pricing table.
 */
export type LlmRoute = {
	model: (providerModelId: string) => LanguageModelV4
	/** The same model through the route's batch endpoint, where it has one. */
	batchModel?: (providerModelId: string) => LanguageModelV4
	reasoningOptions: (
		providerModelId: string,
		effort: LlmEffort
	) => SharedV4ProviderOptions
	cost?: (input: LlmCostInput) => Promise<LlmCost>
}

/**
 * The provider's own number, summed over the call's steps. A step without one
 * makes the whole call unknown rather than a partial sum, and an aborted run
 * rejects its steps - a null cost, not a failure.
 */
export function reportedCost(extract: (step: unknown) => number | undefined) {
	return async ({ steps }: LlmCostInput): Promise<LlmCost> => {
		if (!steps) return { usd: null, estimated: false }
		try {
			const settled = await steps
			let total = 0
			for (const step of settled) {
				const cost = extract(step)
				if (cost === undefined) return { usd: null, estimated: false }
				total += cost
			}
			return { usd: settled.length ? total : null, estimated: false }
		} catch {
			return { usd: null, estimated: false }
		}
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The logger the library writes to; anything with `info` and `warn` fits (pino, console). */
export type Logger = {
	info: (message: string, attributes?: Record<string, unknown>) => void
	warn: (message: string, attributes?: Record<string, unknown>) => void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} }

export function errorAttributes(error: unknown) {
	return error instanceof Error
		? { error_name: error.name, error_message: error.message }
		: { error_message: String(error) }
}

/** Drops `temperature` for models that refuse any sampling control. */
export function withoutTemperature<T extends { temperature?: number }>(
	params: T
): Omit<T, 'temperature'> {
	const { temperature: _dropped, ...rest } = params
	return rest
}
