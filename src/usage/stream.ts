import type { LanguageModelUsage } from 'ai'

/**
 * Usage as the AI SDK reports it (`inputTokenDetails`), or as Mastra's own
 * usage object does (`cachedInputTokens`, `cacheCreationInputTokens`).
 */
export type RunUsage = Partial<
	Pick<
		LanguageModelUsage,
		'inputTokens' | 'outputTokens' | 'inputTokenDetails' | 'outputTokenDetails'
	>
> & {
	cachedInputTokens?: number | undefined
	cacheCreationInputTokens?: number | undefined
	reasoningTokens?: number | undefined
}

/**
 * A run's token totals, or null when it used none. Cache reads and writes are
 * part of `inputTokens`, reasoning part of `outputTokens`.
 */
export function readStreamTextUsage(usage: RunUsage | undefined) {
	if (!usage) return null
	const inputTokens = usage.inputTokens ?? 0
	const outputTokens = usage.outputTokens ?? 0
	if (inputTokens === 0 && outputTokens === 0) return null
	return {
		inputTokens,
		outputTokens,
		/** Provider-cache hits (Gemini implicit caching, Anthropic prompt caching). */
		cacheReadTokens:
			usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0,
		/** Anthropic prompt-cache writes, billed at 1.25x input. */
		cacheWriteTokens:
			usage.inputTokenDetails?.cacheWriteTokens ??
			usage.cacheCreationInputTokens ??
			0,
		reasoningTokens:
			usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? 0
	}
}

export type StreamTextUsage = NonNullable<
	ReturnType<typeof readStreamTextUsage>
>
