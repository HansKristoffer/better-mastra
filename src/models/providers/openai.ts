import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel } from 'ai'
import type { LlmEffort } from '../effort.js'
import { type LlmRoute, withoutTemperature } from '../route.js'

export interface OpenAiRouteOptions {
	/**
	 * Stable routing key sent as OpenAI's `prompt_cache_key` to keep requests
	 * sharing a prefix on the same GPU cache shard under multi-user concurrency.
	 */
	readonly promptCacheKey?: string
	/** OpenAI prompt-cache retention (`'in_memory'` default or `'24h'`). */
	readonly promptCacheRetention?: 'in_memory' | '24h'
}

export function openAiRoute(
	apiKey: string,
	options: OpenAiRouteOptions = {}
): LlmRoute {
	const provider = createOpenAI({ apiKey })
	const defaultCacheOptions =
		options.promptCacheKey !== undefined ||
		options.promptCacheRetention !== undefined
			? {
					...(options.promptCacheKey !== undefined && {
						promptCacheKey: options.promptCacheKey
					}),
					...(options.promptCacheRetention !== undefined && {
						promptCacheRetention: options.promptCacheRetention
					})
				}
			: undefined

	return {
		model: (modelId) =>
			// The Instant alias does not advertise sampling controls, so omit the
			// caller's temperature for it.
			wrapLanguageModel({
				model: provider.responses(modelId),
				middleware: {
					specificationVersion: 'v4',
					transformParams: async ({ params }) => {
						const next =
							modelId === 'chat-latest' ? withoutTemperature(params) : params
						const withCache = defaultCacheOptions
							? {
									...next,
									providerOptions: {
										...next.providerOptions,
										openai: {
											...defaultCacheOptions,
											...next.providerOptions?.openai
										}
									}
								}
							: next

						if (!withCache.tools) {
							return withCache
						}
						return {
							...withCache,
							// Preserve optional tool inputs; Responses otherwise normalizes
							// an unspecified strict flag to strict schemas with required fields.
							tools: withCache.tools.map((tool) =>
								tool.type === 'function'
									? { ...tool, strict: tool.strict ?? false }
									: tool
							)
						}
					}
				}
			}),
		reasoningOptions: openAiReasoningOptions
	}
}

export function openAiReasoningOptions(modelId: string, effort: LlmEffort) {
	if (modelId === 'chat-latest' && effort !== 'off') {
		throw new Error(
			'chat-latest has no configurable reasoning effort; use OFF for its default Instant mode.'
		)
	}
	return {
		openai: {
			store: false,
			strictJsonSchema: false,
			...(modelId === 'chat-latest'
				? {}
				: { reasoningEffort: effort === 'off' ? 'none' : effort })
		}
	}
}
