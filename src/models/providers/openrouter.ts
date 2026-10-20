import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { wrapLanguageModel } from 'ai'
import { createBatchFetch } from '../openrouter-batch.js'
import {
	openRouterAnthropicCompatMiddleware,
	thoughtSignatureRecovery
} from '../openrouter-compat.js'
import {
	extractOpenRouterCostUsd,
	openRouterReasoningOptions,
	type OpenRouterRouting
} from '../openrouter.js'
import { type Logger, type LlmRoute, reportedCost } from '../route.js'

/** Call options that would replace our routing, model or usage reporting in the request body. */
const ROUTING_OVERRIDES: ReadonlySet<string> = new Set([
	'model',
	'models',
	'provider',
	'usage'
])

/**
 * OpenRouter with usage accounting on every call, upstream routing from
 * `routing`, and the Batch API as a second transport. Call-level options that
 * would leave the routing are dropped, so no caller can leave a pinned
 * (zero-data-retention) upstream.
 */
export function openRouterRoute(input: {
	apiKey: string
	routing: OpenRouterRouting
	logger: Logger
}): LlmRoute {
	const direct = createOpenRouter({
		apiKey: input.apiKey,
		compatibility: 'strict'
	})
	const batch = createOpenRouter({
		apiKey: input.apiKey,
		compatibility: 'strict',
		fetch: createBatchFetch(input)
	})

	const build = (provider: typeof direct, modelId: string) => {
		const routing = input.routing(modelId)
		const model = provider(modelId, {
			usage: { include: true },
			...(routing ? { provider: routing } : {})
		})
		return wrapLanguageModel({
			model,
			middleware: [
				keepRouting,
				openRouterAnthropicCompatMiddleware,
				thoughtSignatureRecovery
			]
		})
	}

	return {
		model: (modelId) => build(direct, modelId),
		batchModel: (modelId) => build(batch, modelId),
		reasoningOptions: openRouterReasoningOptions,
		cost: reportedCost(extractOpenRouterCostUsd)
	}
}

const keepRouting = {
	specificationVersion: 'v4' as const,
	transformParams: async ({
		params
	}: {
		params: LanguageModelV4CallOptions
	}) => {
		const openrouter = params.providerOptions?.openrouter
		if (!openrouter) return params
		const kept = Object.fromEntries(
			Object.entries(openrouter).filter(([key]) => !ROUTING_OVERRIDES.has(key))
		)
		return {
			...params,
			providerOptions: { ...params.providerOptions, openrouter: kept }
		}
	}
}
