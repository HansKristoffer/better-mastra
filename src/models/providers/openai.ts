import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel } from 'ai'
import type { LlmEffort } from '../effort.js'
import { type LlmRoute, withoutTemperature } from '../route.js'

export function openAiRoute(apiKey: string): LlmRoute {
	const provider = createOpenAI({ apiKey })

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
						if (!next.tools) return next
						return {
							...next,
							// Preserve optional tool inputs; Responses otherwise normalizes
							// an unspecified strict flag to strict schemas with required fields.
							tools: next.tools.map((tool) =>
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
