// The provider-compat middleware that replaces Mastra's `ProviderHistoryCompat`
// and `PrefillErrorHandler` for plain AI SDK calls through OpenRouter.
//
// OpenRouter re-emits Anthropic thinking as `reasoning_details` on assistant
// turns. On the next step Anthropic rejects those blocks as "modified", so
// `transformParams` strips them from the outbound prompt, and `wrapStream`
// retries once without the trailing assistant prefill when the provider still
// rejects the history.

import type {
	LanguageModelV4CallOptions,
	LanguageModelV4Middleware,
	LanguageModelV4Prompt
} from '@ai-sdk/provider'
import { isRecord } from './route.js'

/**
 * True for OpenRouter-hosted Anthropic models, the only ones that need the
 * strip: Grok's own reasoning round-trip is left intact. The model arrives as
 * a router id (`openrouter/anthropic/...`) or as a resolved language model
 * (`{ provider: 'openrouter', modelId: 'anthropic/...' }`).
 */
export function isOpenRouterRoutedAnthropicModel(model: unknown): boolean {
	if (typeof model === 'string') {
		return /^openrouter\/anthropic\//i.test(model)
	}
	if (!isRecord(model)) return false

	const provider =
		typeof model.provider === 'string' ? model.provider.toLowerCase() : ''
	const modelId =
		typeof model.modelId === 'string'
			? model.modelId
			: typeof model.id === 'string'
				? model.id
				: ''

	if (provider.startsWith('openrouter') && /^anthropic\//i.test(modelId)) {
		return true
	}
	return /^openrouter\/anthropic\//i.test(modelId)
}

/**
 * Remove `providerOptions.openrouter.reasoning_details`, dropping the
 * `openrouter` key when nothing else is left. `undefined` when there was
 * nothing to strip, so callers can skip copying the message.
 */
export function stripOpenRouterReasoningDetails<
	TOptions extends { openrouter?: unknown }
>(providerOptions: TOptions | undefined): TOptions | undefined {
	if (!providerOptions) return undefined
	const openrouter = providerOptions.openrouter
	if (!isRecord(openrouter) || !('reasoning_details' in openrouter)) {
		return undefined
	}
	const { reasoning_details: _removed, ...restOpenRouter } = openrouter
	const next = { ...providerOptions }
	if (Object.keys(restOpenRouter).length === 0) {
		delete next.openrouter
	} else {
		next.openrouter = restOpenRouter as TOptions['openrouter']
	}
	return next
}

/**
 * A new prompt with Anthropic reasoning stripped from assistant turns:
 * `reasoning` parts, and `reasoning_details` on the message and each
 * `tool-call` part. `undefined` when nothing needed stripping.
 */
export function stripReasoningFromPrompt(
	prompt: LanguageModelV4Prompt
): LanguageModelV4Prompt | undefined {
	let mutated = false
	const next: LanguageModelV4Prompt = prompt.map((message) => {
		if (message.role !== 'assistant') return message

		let providerOptions = message.providerOptions
		const cleanedMessageOptions =
			stripOpenRouterReasoningDetails(providerOptions)
		if (cleanedMessageOptions) {
			providerOptions = cleanedMessageOptions
			mutated = true
		}

		const content: typeof message.content = []
		for (const part of message.content) {
			if (part.type === 'reasoning') {
				mutated = true
				continue
			}
			if (part.type !== 'tool-call') {
				content.push(part)
				continue
			}
			const cleanedPartOptions = stripOpenRouterReasoningDetails(
				part.providerOptions
			)
			if (!cleanedPartOptions) {
				content.push(part)
				continue
			}
			mutated = true
			content.push({ ...part, providerOptions: cleanedPartOptions })
		}

		if (!mutated) return message
		const { providerOptions: _previous, ...rest } = message
		return {
			...rest,
			content,
			...(providerOptions ? { providerOptions } : {})
		}
	})
	return mutated ? next : undefined
}

/**
 * Drop a trailing assistant message. Anthropic will not always continue an
 * assistant prefill it did not produce, and a replayed history can end on
 * one. `undefined` when there is no trailing assistant turn to drop.
 */
export function dropTrailingAssistantPrefill(
	prompt: LanguageModelV4Prompt
): LanguageModelV4Prompt | undefined {
	const last = prompt.at(-1)
	if (last?.role !== 'assistant') return undefined
	const next = prompt.slice(0, -1)
	return next.length > 0 ? next : undefined
}

/**
 * The provider rejecting the assistant history we replayed. Matched on the
 * message because OpenRouter flattens provider errors into a 400 carrying the
 * vendor's text.
 */
export function isPrefillError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '')
	return /thinking|reasoning|prefill|final assistant|last assistant|was modified/i.test(
		message
	)
}

export const openRouterAnthropicCompatMiddleware: LanguageModelV4Middleware = {
	specificationVersion: 'v4',

	transformParams: async ({ params, model }) => {
		if (!isOpenRouterRoutedAnthropicModel(model)) return params
		const stripped = stripReasoningFromPrompt(params.prompt)
		return stripped ? { ...params, prompt: stripped } : params
	},

	wrapStream: async ({ doStream, params, model }) => {
		try {
			return await doStream()
		} catch (error) {
			if (!isPrefillError(error)) throw error
			// Reasoning is already stripped; the only lever left is the prefill.
			const prompt = dropTrailingAssistantPrefill(params.prompt)
			if (!prompt) throw error
			const retryParams: LanguageModelV4CallOptions = { ...params, prompt }
			return await model.doStream(retryParams)
		}
	}
}

/**
 * OpenRouter load-balances `google/*` between Google AI Studio and Vertex.
 * Gemini 3 encrypts its thought signature with the upstream that produced it,
 * so a hop that lands on the other one fails with "Corrupted thought
 * signature." (AI Studio) or "Invalid thought signature." (Vertex). The
 * signature is only an optimisation, so drop it and retry once.
 */
const UNREADABLE_THOUGHT_SIGNATURE = /thought signature/i

export const thoughtSignatureRecovery: LanguageModelV4Middleware = {
	specificationVersion: 'v4',

	wrapGenerate: async ({ doGenerate, params, model }) => {
		try {
			return await doGenerate()
		} catch (error) {
			const prompt = promptWithoutSignatures(error, params.prompt)
			if (!prompt) throw error
			return await model.doGenerate({ ...params, prompt })
		}
	},

	wrapStream: async ({ doStream, params, model }) => {
		try {
			return await doStream()
		} catch (error) {
			const prompt = promptWithoutSignatures(error, params.prompt)
			if (!prompt) throw error
			return await model.doStream({ ...params, prompt })
		}
	}
}

function promptWithoutSignatures(
	error: unknown,
	prompt: LanguageModelV4Prompt
) {
	const message = error instanceof Error ? error.message : String(error ?? '')
	if (!UNREADABLE_THOUGHT_SIGNATURE.test(message)) return undefined
	return stripReasoningFromPrompt(prompt)
}
