/**
 * How much a call may think. The names are ours; each route turns them into
 * its provider's wire shape. `medium` usually only arrives pinned on an id.
 */
export type ReasoningEffort = 'off' | 'low' | 'high'

export type LlmEffort = ReasoningEffort | 'medium'

type PinnedEffort = Exclude<LlmEffort, 'off'>

const EFFORT_SUFFIX = /^(.+)@(low|medium|high)$/

/**
 * `model@medium` pins that effort on every call, whatever the caller asks
 * for. The provider never sees the suffix.
 */
export function splitModelEffort(modelId: string): {
	modelId: string
	effort: PinnedEffort | null
} {
	const match = EFFORT_SUFFIX.exec(modelId)
	if (!match?.[1] || !match[2]) return { modelId, effort: null }

	return { modelId: match[1], effort: match[2] as PinnedEffort }
}
