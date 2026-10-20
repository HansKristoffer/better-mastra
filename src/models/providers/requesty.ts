import {
	createOpenAICompatible,
	type MetadataExtractor
} from '@ai-sdk/openai-compatible'
import type { LlmEffort } from '../effort.js'
import { isRecord, type LlmRoute, reportedCost } from '../route.js'

export function requestyRoute(apiKey: string): LlmRoute {
	const provider = createOpenAICompatible({
		name: 'requesty',
		includeUsage: true,
		metadataExtractor: requestyMetadataExtractor,
		convertUsage: (usage) => {
			const total = usage?.completion_tokens ?? undefined
			const reasoning =
				usage?.completion_tokens_details?.reasoning_tokens ?? undefined
			return {
				inputTokens: {
					total: usage?.prompt_tokens ?? undefined,
					noCache: undefined,
					cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? undefined,
					cacheWrite: undefined
				},
				outputTokens: {
					total,
					reasoning,
					text:
						total !== undefined && reasoning !== undefined
							? Math.max(0, total - reasoning)
							: undefined
				}
			}
		},
		apiKey,
		baseURL: 'https://router.requesty.ai/v1'
	})

	return {
		model: (modelId) => provider.chatModel(modelId),
		reasoningOptions: requestyReasoningOptions,
		cost: reportedCost(extractRequestyCostUsd)
	}
}

/** Requesty's normalized reasoning control; support depends on the upstream model. */
export function requestyReasoningOptions(modelId: string, effort: LlmEffort) {
	// GLM 5.3 always thinks; unsupported effort values can select MAX instead.
	if (modelId.endsWith('/glm-5.3') && effort === 'off') {
		throw new Error(
			`${modelId} requires reasoning; OFF is unsupported. Use LOW or HIGH.`
		)
	}
	return { requesty: { reasoningEffort: effort === 'off' ? 'none' : effort } }
}

function cost(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: undefined
}

function responseCost(value: unknown) {
	return isRecord(value) && isRecord(value.usage)
		? cost(value.usage.cost)
		: undefined
}

const requestyMetadataExtractor: MetadataExtractor = {
	extractMetadata: async ({ parsedBody }) => {
		const usd = responseCost(parsedBody)
		return usd === undefined ? undefined : { requesty: { cost: usd } }
	},
	createStreamExtractor: () => {
		let usd: number | undefined
		return {
			processChunk: (chunk) => {
				usd = responseCost(chunk) ?? usd
			},
			buildMetadata: () =>
				usd === undefined ? undefined : { requesty: { cost: usd } }
		}
	}
}

export function extractRequestyCostUsd(value: unknown) {
	if (!isRecord(value) || !isRecord(value.providerMetadata)) return undefined
	const requesty = value.providerMetadata.requesty
	return isRecord(requesty) ? cost(requesty.cost) : undefined
}
