import { createAnthropic } from '@ai-sdk/anthropic'
import type {
	LanguageModelV4CallOptions,
	LanguageModelV4Prompt,
	SharedV4ProviderOptions
} from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'
import type { LlmEffort } from '../effort.js'
import { type LlmRoute, withoutTemperature } from '../route.js'

/** Sonnet 5.5 rejects `thinking: disabled`; Haiku 5.5 accepts it but rejects `between_tools`. */
const BETWEEN_TOOLS_MODELS = new Set(['claude-sonnet-5-5'])

/** Models that 400 on any non-default temperature, top_p or top_k. */
const NO_SAMPLING_MODELS = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5'])

/** Anthropic allows at most four cache breakpoints across tools, system and messages (automatic caching takes one). */
const ANTHROPIC_MAX_BREAKPOINTS = 4

export interface AnthropicRouteOptions {
	/**
	 * Prompt-cache TTL for Anthropic's automatic top-level `cacheControl`
	 * (`'5m'` default, or `'1h'` extended). Ignored when explicit markers in the
	 * prompt use a shorter TTL, since Anthropic requires longest-TTL-first.
	 */
	readonly cacheTtl?: '5m' | '1h'
}

/**
 * Claude on Anthropic's own API. Claude caches only when asked:
 * `cacheControl` at the request level is Anthropic's automatic mode, where the
 * breakpoint sits on the last block and moves forward, so a turn's tool hops
 * and every later turn read the conversation so far at 0.1x input price
 * (writes cost 1.25x for 5m, 2x for 1h). Set whenever the request has fewer
 * than four explicit cache markers, so callers with 1–3 explicit breakpoints
 * (e.g. a shared system prompt) still get automatic sliding-tail caching
 * without exceeding Anthropic's four-slot limit.
 */
export function anthropicRoute(
	apiKey: string,
	options: AnthropicRouteOptions = {}
): LlmRoute {
	// Pinned: the SDK otherwise honours ANTHROPIC_BASE_URL, which a developer's
	// shell may point at a local gateway.
	const provider = createAnthropic({
		apiKey,
		baseURL: 'https://api.anthropic.com/v1'
	})
	const automaticControl =
		options.cacheTtl === '1h'
			? { type: 'ephemeral' as const, ttl: '1h' as const }
			: { type: 'ephemeral' as const }

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
					transformParams: async ({ params }) => {
						const markers = inspectCacheMarkers(params.prompt, params.tools)
						const cacheControl =
							markers.hasFiveMin && automaticControl.ttl === '1h'
								? { type: 'ephemeral' as const }
								: automaticControl

						return {
							// The 5.5 models have no sampling controls.
							...(NO_SAMPLING_MODELS.has(modelId)
								? withoutTemperature(params)
								: params),
							providerOptions: {
								...params.providerOptions,
								anthropic: {
									...(markers.count < ANTHROPIC_MAX_BREAKPOINTS && {
										cacheControl
									}),
									...params.providerOptions?.anthropic
								}
							}
						}
					}
				}
			}),
		reasoningOptions: anthropicReasoningOptions
	}
}

/** Counts explicit Anthropic cache breakpoints and checks whether any use the shorter 5m TTL. */
function inspectCacheMarkers(
	prompt: LanguageModelV4Prompt,
	tools?: LanguageModelV4CallOptions['tools']
): { readonly count: number; readonly hasFiveMin: boolean } {
	let count = 0
	let hasFiveMin = false

	const check = (options: SharedV4ProviderOptions | undefined) => {
		const control = options?.anthropic?.cacheControl
		if (control === undefined) return
		count += 1
		if (
			typeof control === 'object' &&
			control !== null &&
			(control as { ttl?: unknown }).ttl !== '1h'
		) {
			hasFiveMin = true
		}
	}

	for (const tool of tools ?? []) {
		if ('providerOptions' in tool) check(tool.providerOptions)
	}
	for (const message of prompt) {
		check(message.providerOptions)
		if (typeof message.content !== 'string') {
			for (const part of message.content) {
				check(part.providerOptions)
			}
		}
	}
	return { count, hasFiveMin }
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
