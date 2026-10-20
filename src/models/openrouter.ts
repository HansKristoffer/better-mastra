import type { SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { LlmEffort } from './effort.js'
import { isRecord } from './route.js'

/** OpenRouter's `provider` request field: which upstreams may serve a model. */
export type OpenRouterProviderRouting = {
	order?: string[]
	only?: string[]
	allow_fallbacks?: boolean
	zdr?: boolean
	data_collection?: 'allow' | 'deny'
}

/** Picks the upstream routing for a model id; throw to refuse a model. */
export type OpenRouterRouting = (
	modelId: string
) => OpenRouterProviderRouting | undefined

/**
 * Pins every hop of a Gemini turn to Google AI Studio (fallbacks stay on, see
 * `thoughtSignatureRecovery`), and runs Claude only on Vertex's EU region with
 * no fallback: an outage fails the call rather than leaving the region.
 */
export const defaultOpenRouterRouting: OpenRouterRouting = (modelId) => {
	if (modelId.startsWith('google/')) return { order: ['google-ai-studio'] }
	if (modelId.startsWith('anthropic/'))
		return { only: ['google-vertex/europe'], allow_fallbacks: false }
	return undefined
}

/**
 * Zero-data-retention routing: each model runs on exactly one approved
 * upstream, with data collection denied and no fallback. A model missing
 * from the table is refused before any request is sent.
 */
export function openRouterPrivacyRouting(
	upstreamByModel: Readonly<Record<string, string>>
): OpenRouterRouting {
	return (modelId) => {
		const upstream = upstreamByModel[modelId]
		if (!upstream) {
			throw new Error(
				`Unsupported OpenRouter privacy routing model: ${modelId}`
			)
		}
		return {
			zdr: true,
			data_collection: 'deny',
			order: [upstream],
			only: [upstream],
			allow_fallbacks: false
		}
	}
}

/**
 * OpenRouter's reasoning control, spread verbatim into the request body. Some
 * models think at `high` unless told otherwise, so an unset effort is not the
 * same as `low`. OFF disables thinking.
 */
export function openRouterReasoningOptions(
	_modelId: string,
	effort: LlmEffort
): SharedV4ProviderOptions {
	return effort === 'off'
		? { openrouter: { reasoning: { enabled: false } } }
		: { openrouter: { reasoning: { effort } } }
}

/** The real billed cost (USD) of an OpenRouter response or step, when present. */
export function extractOpenRouterCostUsd(result: unknown): number | undefined {
	if (!isRecord(result) || !isRecord(result.providerMetadata)) return undefined
	const openrouter = result.providerMetadata.openrouter
	if (!isRecord(openrouter) || !isRecord(openrouter.usage)) return undefined
	const cost = openrouter.usage.cost
	return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined
}
