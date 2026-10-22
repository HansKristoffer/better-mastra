import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { wrapLanguageModel } from 'ai'
import { must } from 'hanzio'
import { type ReasoningEffort, splitModelEffort } from './effort.js'
import {
	defaultOpenRouterRouting,
	type OpenRouterRouting
} from './openrouter.js'
import {
	ESTIMATED_MODEL_PRICING,
	estimateModelCostUsd,
	type LlmUsageTotals,
	type ModelPricing
} from './pricing.js'
import type { VertexKeys } from './providers/vertex.js'
import {
	type Logger,
	type LlmCost,
	type LlmCostInput,
	type LlmRoute,
	silentLogger
} from './route.js'

export const BUILT_IN_ROUTES = [
	'vertex-eu',
	'openrouter',
	'openai-direct',
	'anthropic-direct',
	'requesty',
	'inception'
] as const

export type BuiltInRoute = (typeof BUILT_IN_ROUTES)[number]

/** API keys per route. A route without a key is not loaded, nor is its SDK. */
export type LlmKeys = {
	openrouter?: string | undefined
	anthropic?: string | undefined
	openai?: string | undefined
	requesty?: string | undefined
	inception?: string | undefined
	vertex?: VertexKeys | undefined
}

export type LlmRegistryOptions = {
	keys: LlmKeys
	/** Extra routes, or replacements for built-in ones, by route name. */
	routes?: Record<string, LlmRoute>
	/** Prices for routes that report no cost. Defaults to `ESTIMATED_MODEL_PRICING`. */
	pricing?: ModelPricing
	/** OpenRouter upstream routing. Defaults to `defaultOpenRouterRouting`. */
	openRouterRouting?: OpenRouterRouting
	/**
	 * The route for an id without a route prefix. Defaults to Vertex EU for a
	 * bare Gemini id and OpenRouter for `vendor/model`.
	 */
	defaultRoute?: (modelId: string) => string
	logger?: Logger
}

export type ResolveLlmOptions = {
	/** Used unless the id pins an effort with `@low|medium|high`. */
	reasoning?: ReasoningEffort | undefined
	/** Caps every call's output; a call asking for more gets the cap. */
	maxOutputTokens?: number | undefined
}

export type ResolvedLlm = {
	modelId: string
	route: string
	model: LanguageModelV4
	providerOptions: ReturnType<LlmRoute['reasoningOptions']> | undefined
}

export type LlmRegistry = Awaited<ReturnType<typeof createLlmRegistry>>

const defaultRoute = (modelId: string) =>
	modelId.includes('/') ? 'openrouter' : 'vertex-eu'

/** Loads a route's SDK only when its key is set, so missing optional peers never break startup. */
async function loadBuiltInRoutes(
	keys: LlmKeys,
	openRouterRouting: OpenRouterRouting,
	logger: Logger
) {
	const load = async (sdk: string, build: () => Promise<LlmRoute>) => {
		try {
			return await build()
		} catch (error) {
			throw new Error(`Install ${sdk} to use this model route`, {
				cause: error
			})
		}
	}
	const routes: Partial<Record<BuiltInRoute, LlmRoute>> = {}
	const { openrouter, anthropic, openai, requesty, inception, vertex } = keys
	if (openrouter)
		routes.openrouter = await load('@openrouter/ai-sdk-provider', async () =>
			(await import('./providers/openrouter.js')).openRouterRoute({
				apiKey: openrouter,
				routing: openRouterRouting,
				logger
			})
		)
	if (anthropic)
		routes['anthropic-direct'] = await load('@ai-sdk/anthropic', async () =>
			(await import('./providers/anthropic.js')).anthropicRoute(anthropic)
		)
	if (openai)
		routes['openai-direct'] = await load('@ai-sdk/openai', async () =>
			(await import('./providers/openai.js')).openAiRoute(openai)
		)
	if (requesty)
		routes.requesty = await load('@ai-sdk/openai-compatible', async () =>
			(await import('./providers/requesty.js')).requestyRoute(requesty)
		)
	if (inception)
		routes.inception = await load('@ai-sdk/openai-compatible', async () =>
			(await import('./providers/inception.js')).inceptionRoute(inception)
		)
	if (vertex)
		routes['vertex-eu'] = await load('@ai-sdk/google-vertex', async () =>
			(await import('./providers/vertex.js')).vertexEuRoute(vertex)
		)
	return routes
}

/**
 * Every model a project uses, behind one id format: `route/model@effort`.
 * `anthropic-direct/claude-sonnet-5-5@medium`, `requesty/sference/glm-5.3`,
 * `google/gemini-3.8-flash` (OpenRouter) or `gemini-3.5-flash-lite` (Vertex
 * EU). Keep the full id in saved configuration and metrics; only the SDK
 * sees the provider's id.
 */
export async function createLlmRegistry(options: LlmRegistryOptions) {
	const logger = options.logger ?? silentLogger
	const pricing = options.pricing ?? ESTIMATED_MODEL_PRICING
	const routes: Record<string, LlmRoute> = {
		...(await loadBuiltInRoutes(
			options.keys,
			options.openRouterRouting ?? defaultOpenRouterRouting,
			logger
		)),
		...options.routes
	}
	const knownRoutes = new Set<string>([
		...BUILT_IN_ROUTES,
		...Object.keys(options.routes ?? {})
	])
	const fallbackRoute = options.defaultRoute ?? defaultRoute

	function parseModelId(modelId: string) {
		const separator = modelId.indexOf('/')
		const prefix = separator < 0 ? modelId : modelId.slice(0, separator)
		const prefixed = knownRoutes.has(prefix)
		const route = prefixed ? prefix : fallbackRoute(modelId)
		const withEffort = prefixed
			? separator < 0
				? ''
				: modelId.slice(separator + 1)
			: modelId
		if (!withEffort.trim() || withEffort !== withEffort.trim()) {
			throw new Error(`Missing or invalid model ID for ${route}`)
		}
		const { modelId: providerModelId, effort } = splitModelEffort(withEffort)
		return { route, providerModelId, effort }
	}

	function routeFor(modelId: string) {
		const parsed = parseModelId(modelId)
		const adapter = must(
			routes[parsed.route],
			() =>
				new Error(
					`Model route "${parsed.route}" is not configured (${modelId}): pass its key to createLlmRegistry`
				)
		)
		return { ...parsed, adapter }
	}

	function build(
		model: LanguageModelV4,
		adapter: LlmRoute,
		parsed: ReturnType<typeof parseModelId>,
		resolve: ResolveLlmOptions
	) {
		const effort = parsed.effort ?? resolve.reasoning
		const cap = resolve.maxOutputTokens
		return {
			model: cap ? capOutputTokens(model, cap) : model,
			providerOptions: effort
				? adapter.reasoningOptions(parsed.providerModelId, effort)
				: undefined
		}
	}

	/**
	 * The one way to turn a model id into a model. A pinned `@effort` wins over
	 * `reasoning`; without either no thinking options are sent and the provider
	 * default applies.
	 */
	function resolveLlm(
		modelId: string,
		resolve: ResolveLlmOptions = {}
	): ResolvedLlm {
		const { adapter, ...parsed } = routeFor(modelId)
		return {
			modelId,
			route: parsed.route,
			...build(adapter.model(parsed.providerModelId), adapter, parsed, resolve)
		}
	}

	/**
	 * `resolveLlm` through the route's batch endpoint (see `withLlmMode`), or
	 * null when the route has none and the call has to go direct.
	 */
	function resolveBatchLlm(modelId: string, resolve: ResolveLlmOptions = {}) {
		const { adapter, ...parsed } = routeFor(modelId)
		if (!adapter.batchModel) return null
		return build(
			adapter.batchModel(parsed.providerModelId),
			adapter,
			parsed,
			resolve
		)
	}

	/** What a call cost, read the way its route reports it. */
	function cost(input: {
		modelId: string
		steps: LlmCostInput['steps']
		usage: LlmUsageTotals | null
	}): Promise<LlmCost> {
		const { route, providerModelId } = parseModelId(input.modelId)
		const adapter = routes[route]
		const costInput = { ...input, providerModelId }
		if (adapter?.cost) return adapter.cost(costInput)
		return Promise.resolve({
			usd: estimateModelCostUsd(pricing, providerModelId, input.usage),
			estimated: true
		})
	}

	/**
	 * A model id resolved for a Mastra agent through the same routes, never a
	 * Mastra `provider/model` string: Mastra's bundled providers cannot carry
	 * this registry's routing, caching or usage settings.
	 */
	function resolveMastraLlm(modelId: string, resolve?: ResolveLlmOptions) {
		const llm = resolveLlm(modelId, resolve)
		return {
			...llm,
			// Structurally identical; `ai` and @mastra/core can resolve different
			// package copies of the model types.
			model: llm.model as unknown as MastraLanguageModel
		}
	}

	return {
		parseModelId,
		resolveLlm,
		resolveBatchLlm,
		resolveMastraLlm,
		cost
	}
}

/** Keeps every call within `cap` output tokens, reasoning included. */
export function capOutputTokens(model: LanguageModelV4, cap: number) {
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v4',
			transformParams: async ({ params }) => ({
				...params,
				maxOutputTokens: Math.min(params.maxOutputTokens ?? cap, cap)
			})
		}
	})
}
