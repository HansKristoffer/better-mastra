import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { wrapLanguageModel } from 'ai'
import { createBatchFetch } from '../openrouter-batch.js'
import {
	openRouterAnthropicCompatMiddleware,
	thoughtSignatureRecovery
} from '../openrouter-compat.js'
import {
	defaultOpenRouterRouting,
	extractOpenRouterCostUsd,
	openRouterReasoningOptions,
	type OpenRouterRouting
} from '../openrouter.js'
import {
	type Logger,
	type LlmRoute,
	reportedCost,
	silentLogger
} from '../route.js'
import { omit } from 'hanzio'

/** Call options that would replace our routing, model or usage reporting in the request body. */
const ROUTING_OVERRIDES = ['model', 'models', 'provider', 'usage']

/**
 * OpenRouter with usage accounting on every call, upstream routing from
 * `routing`, and the Batch API as a second transport. Call-level options that
 * would leave the routing are dropped, so no caller can leave a pinned
 * (zero-data-retention) upstream. Synchronous, so an app can build its
 * models at import time: `openRouterRoute({ apiKey }).model('vendor/model')`.
 */
export function openRouterRoute(input: {
	apiKey: string
	/** Defaults to `defaultOpenRouterRouting`. */
	routing?: OpenRouterRouting
	logger?: Logger
}): LlmRoute {
	const routing = input.routing ?? defaultOpenRouterRouting
	const direct = createOpenRouter({
		apiKey: input.apiKey,
		compatibility: 'strict'
	})
	const batch = createOpenRouter({
		apiKey: input.apiKey,
		compatibility: 'strict',
		fetch: createBatchFetch({
			apiKey: input.apiKey,
			logger: input.logger ?? silentLogger
		})
	})

	const build = (provider: typeof direct, modelId: string) => {
		const upstream = routing(modelId)
		const model = provider(modelId, {
			usage: { include: true },
			...(upstream ? { provider: upstream } : {})
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
		const kept = omit(openrouter, ROUTING_OVERRIDES)
		return {
			...params,
			providerOptions: { ...params.providerOptions, openrouter: kept }
		}
	}
}
