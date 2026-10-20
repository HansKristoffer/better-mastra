import { createGoogleVertex } from '@ai-sdk/google-vertex/edge'
import type { LlmEffort } from '../effort.js'
import type { LlmRoute } from '../route.js'

/** Vertex EU multi-region. `eu-aiplatform.googleapis.com` 404s; pin the REP host. */
export const VERTEX_EU_LOCATION = 'eu'
export const VERTEX_EU_REP_ORIGIN = 'https://aiplatform.eu.rep.googleapis.com'

export function vertexEuPublisherBaseUrl(project: string) {
	return `${VERTEX_EU_REP_ORIGIN}/v1/projects/${project}/locations/${VERTEX_EU_LOCATION}/publishers/google`
}

export type VertexKeys = { project: string; apiKey: string }

/**
 * Gemini via Vertex AI's EU multi-region. `@ai-sdk/google-vertex` still
 * builds `eu-aiplatform.googleapis.com` for `location: 'eu'`, which 404s, so
 * the REP base URL is pinned. Express-mode apiKey-only drops the location.
 *
 * @see https://github.com/vercel/ai/issues/15722
 */
export function vertexEuRoute({ project, apiKey }: VertexKeys): LlmRoute {
	const vertex = createGoogleVertex({
		apiKey,
		project,
		location: VERTEX_EU_LOCATION,
		baseURL: vertexEuPublisherBaseUrl(project)
	})

	return {
		model: (modelId) => vertex(modelId),
		reasoningOptions: vertexThinkingOptions
	}
}

const VERTEX_GEMINI_THINKING_OFF = {
	vertex: { thinkingConfig: { thinkingBudget: 0 } }
} as const

/** Token budgets for the Gemini generations before named thinking levels. */
const THINKING_BUDGET = { low: 512, medium: 1024, high: 2048 } as const

/**
 * Each Vertex generation's own thinking controls: Gemini 3.x uses named
 * levels, older models bounded token budgets.
 */
export function vertexThinkingOptions(modelId: string, effort: LlmEffort) {
	// Gemini 3.8 no longer supports numeric budgets or MINIMAL.
	if (modelId === 'gemini-3.8-flash') {
		if (effort === 'off')
			throw new Error('gemini-3.8-flash requires reasoning; use LOW or HIGH')
		return { vertex: { thinkingConfig: { thinkingLevel: effort } } }
	}
	if (modelId === 'gemini-3.5-flash-lite') {
		return {
			vertex: {
				thinkingConfig: { thinkingLevel: effort === 'off' ? 'minimal' : effort }
			}
		}
	}
	if (effort === 'off') return VERTEX_GEMINI_THINKING_OFF
	return {
		vertex: { thinkingConfig: { thinkingBudget: THINKING_BUDGET[effort] } }
	} as const
}
