/**
 * Prompt cache markers: one on the stable instructions, and on every model
 * call two more on the conversation, so a tool hop reads the steps before it
 * from the provider's cache and the next turn reads the conversation up to the
 * user's message. The conversation markers exist only in the call; the stored
 * thread never carries one.
 */

import { type LanguageModelMiddleware, wrapLanguageModel } from 'ai'

import type { LanguageModelObject } from './types.js'

type ModelCallPrompt = Parameters<
	NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params']['prompt']

type PromptMessage = ModelCallPrompt[number]

type ToolMessage = Extract<PromptMessage, { readonly role: 'tool' }>

type MessageProviderOptions = PromptMessage['providerOptions']

/**
 * Anthropic's ephemeral cache marker, under the keys Anthropic and OpenRouter
 * read it from; every other provider ignores both and caches by prefix.
 */
export const CACHE_MARKER = {
	anthropic: { cacheControl: { type: 'ephemeral' } },
	openrouter: { cacheControl: { type: 'ephemeral' } }
} as const

/** The model with the conversation markers added to the prompt of every call it makes. */
export function withConversationCache(
	model: LanguageModelObject
): LanguageModelObject {
	return wrapLanguageModel({
		model,
		middleware: {
			transformParams: async ({ params }) => ({
				...params,
				prompt: markConversationForCache(params.prompt)
			})
		}
	})
}

/**
 * Marks the last message, which the next tool hop reads again, and the newest
 * user message before it, which the next turn reads again. Mastra sends the
 * per-request signal as a user message after the user's own and leaves it out
 * of the stored thread, so one turn's prompt matches the next one's only up to
 * the user's message. A tool message is marked on its last result alone: a
 * marker on the message goes on every result, and Anthropic takes four.
 */
export function markConversationForCache(
	prompt: ModelCallPrompt
): ModelCallPrompt {
	const lastIndex = prompt.length - 1
	// `map` + `lastIndexOf`: the build targets ES2022, which has no `findLastIndex`.
	const userIndex = prompt
		.map((message, index) => index < lastIndex && message.role === 'user')
		.lastIndexOf(true)

	return prompt.map((message, index) =>
		index === lastIndex || index === userIndex ? withMarker(message) : message
	)
}

function withMarker(message: PromptMessage): PromptMessage {
	switch (message.role) {
		case 'system':
		case 'user':
		case 'assistant':
			return {
				...message,
				providerOptions: withCacheControl(message.providerOptions)
			}
		case 'tool':
			return withMarkerOnLastResult(message)
	}
}

function withMarkerOnLastResult(message: ToolMessage): ToolMessage {
	const lastResult = message.content
		.map((part) => part.type === 'tool-result')
		.lastIndexOf(true)

	return {
		...message,
		content: message.content.map((part, index) =>
			index === lastResult
				? { ...part, providerOptions: withCacheControl(part.providerOptions) }
				: part
		)
	}
}

/** The options with the cache marker added, keeping what they already say per provider, such as reasoning details. */
export function withCacheControl(
	providerOptions: MessageProviderOptions
): NonNullable<MessageProviderOptions> {
	return {
		...providerOptions,
		anthropic: { ...providerOptions?.anthropic, ...CACHE_MARKER.anthropic },
		openrouter: { ...providerOptions?.openrouter, ...CACHE_MARKER.openrouter }
	}
}
