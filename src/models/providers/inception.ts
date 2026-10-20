import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel } from 'ai'
import type { LlmEffort } from '../effort.js'
import type { LlmRoute } from '../route.js'

/**
 * Inception's Mercury diffusion models over their OpenAI-compatible chat API.
 * https://docs.inceptionlabs.ai/api-reference/chat/create-a-chat-completion
 */
export function inceptionRoute(apiKey: string): LlmRoute {
	const provider = createOpenAICompatible({
		name: 'inception',
		includeUsage: true,
		// Without it the SDK sends bare JSON mode, drops the schema, and
		// `generateObject` fails to parse (probed 2026-09-18).
		supportsStructuredOutputs: true,
		apiKey,
		baseURL: 'https://api.inceptionlabs.ai/v1'
	})

	return {
		model: (modelId) =>
			// Mercury rejects a temperature outside [0.5, 1].
			wrapLanguageModel({
				model: provider.chatModel(modelId),
				middleware: {
					specificationVersion: 'v4',
					transformParams: async ({ params }) => ({
						...params,
						...(params.temperature === undefined
							? {}
							: { temperature: Math.min(1, Math.max(0.5, params.temperature)) })
					})
				}
			}),
		reasoningOptions: inceptionReasoningOptions
	}
}

/**
 * There is no way to turn Mercury's reasoning off. Mercury 2.5's lowest effort
 * is `instant`; `mercury-voice` rejects it and starts at `low` (2026-09-29).
 */
const LOWEST_EFFORT_BY_MODEL: Record<string, string> = {
	'mercury-voice': 'low'
}

export function inceptionReasoningOptions(modelId: string, effort: LlmEffort) {
	const lowestEffort = LOWEST_EFFORT_BY_MODEL[modelId] ?? 'instant'

	return {
		inception: { reasoningEffort: effort === 'off' ? lowestEffort : effort }
	}
}
