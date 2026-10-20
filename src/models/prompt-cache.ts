// Prompt cache markers for Claude, on Anthropic's own API (`anthropic`
// provider options) or through OpenRouter (`openrouter`). Claude caches tools,
// then the system prompt, then the messages, up to each marker; a change
// before a marker rebuilds everything after it. The markers exist only in the
// model call: a stored thread never carries one.

import type {
	LanguageModelV4,
	LanguageModelV4Message,
	LanguageModelV4Middleware,
	LanguageModelV4Prompt,
	SharedV4ProviderOptions
} from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'
import { isRecord } from './route.js'

/** Which provider-options key carries the cache marker. */
export type CacheProvider = 'anthropic' | 'openrouter'

type ToolMessage = Extract<LanguageModelV4Message, { role: 'tool' }>

/** Anthropic's ephemeral cache marker, as `provider` reads it from a message or a part. */
export function cacheMarker(provider: CacheProvider) {
	return { [provider]: { cacheControl: { type: 'ephemeral' } } } as const
}

/**
 * Provider options that mark a system message as per-turn context: it
 * changes from turn to turn (page state, the date, available actions) and so
 * must not sit before the cached history. Providers ignore the key.
 */
export const PER_TURN_SYSTEM_MESSAGE_OPTIONS = {
	betterMastra: { perTurn: true }
} as const

/** A system message marked as per-turn context (see `movePerTurnContext`). */
export function perTurnSystemMessage(content: string) {
	return {
		role: 'system' as const,
		content,
		providerOptions: PER_TURN_SYSTEM_MESSAGE_OPTIONS
	}
}

function isPerTurnSystemMessage(message: LanguageModelV4Message) {
	const options = message.providerOptions?.betterMastra
	return (
		message.role === 'system' && isRecord(options) && options.perTurn === true
	)
}

function withCacheControl(
	providerOptions: SharedV4ProviderOptions | undefined,
	provider: CacheProvider
): SharedV4ProviderOptions {
	return {
		...providerOptions,
		// Keeps what the options already say, such as OpenRouter's reasoning details.
		[provider]: {
			...providerOptions?.[provider],
			...cacheMarker(provider)[provider]
		}
	}
}

/**
 * Keeps a conversation's history cached when its per-turn context changes.
 * With the per-turn part in the system prompt, every new turn wrote the whole
 * thread history to the cache again. Here each marked system message moves
 * right after the newest user message - the same place for every step of the
 * turn, so the steps still read it from cache - and that user message gets a
 * cache marker, so the next turn reads the history up to it.
 *
 * Pure; a prompt without a marked message, or without a user message, is
 * returned as it was.
 */
export function movePerTurnContext(
	prompt: LanguageModelV4Prompt,
	provider: CacheProvider = 'anthropic'
): LanguageModelV4Prompt {
	const perTurn = prompt.filter(isPerTurnSystemMessage)
	const lastUser = prompt.map((message) => message.role).lastIndexOf('user')
	if (perTurn.length === 0 || lastUser === -1) return prompt

	const moved: LanguageModelV4Prompt = []
	prompt.forEach((message, index) => {
		if (isPerTurnSystemMessage(message)) return
		if (index !== lastUser) {
			moved.push(message)
			return
		}
		moved.push({
			...message,
			providerOptions: withCacheControl(message.providerOptions, provider)
		})
		for (const system of perTurn) {
			const { betterMastra: _, ...providerOptions } =
				system.providerOptions ?? {}
			moved.push({ ...system, providerOptions })
		}
	})
	return moved
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
	prompt: LanguageModelV4Prompt,
	provider: CacheProvider = 'openrouter'
): LanguageModelV4Prompt {
	const lastIndex = prompt.length - 1
	const userIndex = prompt
		.slice(0, lastIndex)
		.map((message) => message.role)
		.lastIndexOf('user')

	return prompt.map((message, index) =>
		index === lastIndex || index === userIndex
			? withMarker(message, provider)
			: message
	)
}

function withMarker(
	message: LanguageModelV4Message,
	provider: CacheProvider
): LanguageModelV4Message {
	if (message.role === 'tool') return withMarkerOnLastResult(message, provider)
	return {
		...message,
		providerOptions: withCacheControl(message.providerOptions, provider)
	} as LanguageModelV4Message
}

function withMarkerOnLastResult(
	message: ToolMessage,
	provider: CacheProvider
): ToolMessage {
	const lastResult = message.content
		.map((part) => part.type)
		.lastIndexOf('tool-result')

	return {
		...message,
		content: message.content.map((part, index) =>
			index === lastResult
				? {
						...part,
						providerOptions: withCacheControl(part.providerOptions, provider)
					}
				: part
		)
	}
}

/**
 * Moves per-turn context behind the newest user message on every call, and
 * with `conversation` also marks the conversation for the cache (Anthropic's
 * own API has request-level automatic caching instead).
 */
export function promptCacheMiddleware(input: {
	provider: CacheProvider
	conversation?: boolean
}): LanguageModelV4Middleware {
	return {
		specificationVersion: 'v4',
		transformParams: async ({ params }) => {
			const moved = movePerTurnContext(params.prompt, input.provider)
			return {
				...params,
				prompt: input.conversation
					? markConversationForCache(moved, input.provider)
					: moved
			}
		}
	}
}

/** The model with per-turn context moved and the conversation marked on every call. */
export function withPromptCache(
	model: LanguageModelV4,
	provider: CacheProvider = 'openrouter'
) {
	return wrapLanguageModel({
		model,
		middleware: promptCacheMiddleware({ provider, conversation: true })
	})
}
