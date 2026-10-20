import { createAnthropic } from '@ai-sdk/anthropic'
import type { SharedV4ProviderOptions } from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'
import type { LlmEffort } from '../effort.js'
import { movePerTurnContext } from '../prompt-cache.js'
import { type LlmRoute, withoutTemperature } from '../route.js'

/** Sonnet 5.5 rejects `thinking: disabled`; Haiku 5.5 accepts it but rejects `between_tools`. */
const BETWEEN_TOOLS_MODELS = new Set(['claude-sonnet-5-5'])

/** Models that 400 on any non-default temperature, top_p or top_k. */
const NO_SAMPLING_MODELS = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5'])

/**
 * Claude on Anthropic's own API. Claude caches only when asked:
 * `cacheControl` at the request level is Anthropic's automatic mode, where the
 * breakpoint sits on the last block and moves forward, so a turn's tool hops
 * and every later turn read the conversation so far at 0.1x input price
 * (writes cost 1.25x). Set on every call, and per-turn context is moved
 * behind the cached history (`movePerTurnContext`).
 */
export function anthropicRoute(apiKey: string): LlmRoute {
	// Pinned: the SDK otherwise honours ANTHROPIC_BASE_URL, which a developer's
	// shell may point at a local gateway.
	const provider = createAnthropic({
		apiKey,
		baseURL: 'https://api.anthropic.com/v1'
	})

	return {
		model: (modelId) =>
			wrapLanguageModel({
				// `@ai-sdk/anthropic` can build on a newer `@ai-sdk/provider` copy
				// than `ai`; the V4 model contract is the same.
				model: provider(modelId) as unknown as Parameters<
					typeof wrapLanguageModel
				>[0]['model'],
				middleware: {
					specificationVersion: 'v4',
					transformParams: async ({ params }) => ({
						// The 5.5 models have no sampling controls.
						...(NO_SAMPLING_MODELS.has(modelId)
							? withoutTemperature(params)
							: params),
						prompt: movePerTurnContext(params.prompt, 'anthropic'),
						providerOptions: {
							...params.providerOptions,
							anthropic: {
								cacheControl: { type: 'ephemeral' },
								...params.providerOptions?.anthropic
							}
						}
					})
				}
			}),
		reasoningOptions: anthropicReasoningOptions
	}
}

/**
 * Sonnet 5.5's lowest setting is `between_tools`: no thinking before the
 * answer, only short progress notes between tool calls. OFF and LOW both map
 * to it at effort low; MEDIUM and HIGH use adaptive thinking at that effort.
 */
export function anthropicReasoningOptions(
	modelId: string,
	effort: LlmEffort
): SharedV4ProviderOptions {
	const lowest = effort === 'off' || effort === 'low'

	if (lowest && BETWEEN_TOOLS_MODELS.has(modelId)) {
		return { anthropic: { thinking: { type: 'between_tools' }, effort: 'low' } }
	}
	if (effort === 'off') return { anthropic: { thinking: { type: 'disabled' } } }

	return { anthropic: { thinking: { type: 'adaptive' }, effort } }
}
