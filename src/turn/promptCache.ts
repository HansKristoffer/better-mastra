/**
 * Prompt cache markers: one on the stable instructions, and on every model
 * call two more on the conversation, so a tool hop reads the steps before it
 * from the provider's cache and the next turn reads the conversation up to the
 * user's message. The conversation markers exist only in the call; the stored
 * thread never carries one.
 */

import { type LanguageModelMiddleware, wrapLanguageModel } from 'ai'
import { typedSwitch, typedSwitchGroup } from 'hanzio'

import type { LanguageModelObject } from './types.js'

type ModelCallPrompt = Parameters<
	NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params']['prompt']

type PromptMessage = ModelCallPrompt[number]

type ToolMessage = Extract<PromptMessage, { readonly role: 'tool' }>

type MessageProviderOptions = PromptMessage['providerOptions']

/** Cache lifetime for Anthropic/OpenRouter prompt cache breakpoints (`'5m'` default, `'1h'` extended). */
export type PromptCacheTtl = '5m' | '1h'

/**
 * Anthropic's ephemeral cache marker (5-minute TTL), under the keys Anthropic
 * and OpenRouter read it from; every other provider ignores both and caches by prefix.
 */
export const CACHE_MARKER = {
	anthropic: { cacheControl: { type: 'ephemeral' } },
	openrouter: { cacheControl: { type: 'ephemeral' } }
} as const

/** Extended 1-hour Anthropic/OpenRouter ephemeral cache marker for shared instruction/tool prefixes. */
export const CACHE_MARKER_1H = {
	anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
	openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } }
} as const

/** Returns the cache marker for the requested TTL (`'5m'` default or `'1h'`). */
export function cacheMarkerFor(
	ttl: PromptCacheTtl = '5m'
): typeof CACHE_MARKER | typeof CACHE_MARKER_1H {
	return ttl === '1h' ? CACHE_MARKER_1H : CACHE_MARKER
}

const wrappedModels5m = new WeakMap<LanguageModelObject, LanguageModelObject>()
const wrappedModels1h = new WeakMap<LanguageModelObject, LanguageModelObject>()

/** The model with the conversation markers added to the prompt of every call it makes. Memoized per `(model, ttl)`. */
export function withConversationCache(
	model: LanguageModelObject,
	options: { readonly ttl?: PromptCacheTtl } = {}
): LanguageModelObject {
	const ttl = options.ttl ?? '5m'
	const cache = ttl === '1h' ? wrappedModels1h : wrappedModels5m
	const cached = cache.get(model)
	if (cached) return cached

	const wrapped = wrapLanguageModel({
		model,
		middleware: {
			transformParams: async ({ params }) => ({
				...params,
				prompt: markConversationForCache(params.prompt, ttl)
			})
		}
	})
	cache.set(model, wrapped)
	return wrapped
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
	prompt: ModelCallPrompt,
	ttl: PromptCacheTtl = '5m'
): ModelCallPrompt {
	const lastIndex = prompt.length - 1
	// `map` + `lastIndexOf`: the build targets ES2022, which has no `findLastIndex`.
	const userIndex = prompt
		.map((message, index) => index < lastIndex && message.role === 'user')
		.lastIndexOf(true)

	return prompt.map((message, index) =>
		index === lastIndex || index === userIndex
			? withMarker(message, ttl)
			: message
	)
}

function withMarker(
	message: PromptMessage,
	ttl: PromptCacheTtl
): PromptMessage {
	return typedSwitch(message, 'role', {
		...typedSwitchGroup(
			message,
			'role',
			['system', 'user', 'assistant'],
			(other): PromptMessage => ({
				...other,
				providerOptions: withCacheControl(other.providerOptions, ttl)
			})
		),
		tool: (tool) => withMarkerOnLastResult(tool, ttl)
	})
}

function withMarkerOnLastResult(
	message: ToolMessage,
	ttl: PromptCacheTtl
): ToolMessage {
	const lastResult = message.content
		.map((part) => part.type === 'tool-result')
		.lastIndexOf(true)

	return {
		...message,
		content: message.content.map((part, index) =>
			index === lastResult
				? {
						...part,
						providerOptions: withCacheControl(part.providerOptions, ttl)
					}
				: part
		)
	}
}

/** The options with the cache marker added, keeping what they already say per provider, such as reasoning details. */
export function withCacheControl(
	providerOptions: MessageProviderOptions,
	ttl: PromptCacheTtl = '5m'
): NonNullable<MessageProviderOptions> {
	const marker = cacheMarkerFor(ttl)

	return {
		...providerOptions,
		anthropic: { ...providerOptions?.anthropic, ...marker.anthropic },
		openrouter: { ...providerOptions?.openrouter, ...marker.openrouter }
	}
}
