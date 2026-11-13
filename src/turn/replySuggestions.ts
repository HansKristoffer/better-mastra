/**
 * The replies offered above the input after an answer: a fast model reads the
 * user's message and the answer, and returns up to three short replies the
 * user can tap, or none. They stream on the answer's own stream after its
 * `finish` and after its thread lock is released, as the transient
 * `data-reply-suggestions` part, sent again each time the list grows. A
 * failed or slow call offers nothing and never fails the turn.
 */

import { Agent } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import type { LanguageModel, UIMessageChunk } from 'ai'
import { z } from 'zod'
import { timeoutSignal } from 'hanzio'

import {
	ANSWER_COMPLETE_PART,
	REPLY_SUGGESTION_MAX_LENGTH,
	REPLY_SUGGESTIONS_MAX,
	REPLY_SUGGESTIONS_PART,
	toReplySuggestions
} from '../protocol/index.js'
import { asAgentModel } from './agent.js'
import type { ChatTurnPlan, ProviderOptions } from './types.js'

export {
	ANSWER_COMPLETE_PART,
	REPLY_SUGGESTION_MAX_LENGTH,
	REPLY_SUGGESTIONS_MAX,
	REPLY_SUGGESTIONS_PART,
	toReplySuggestions
}

/** One id, so each new list replaces the one before it in the client. */
const REPLY_SUGGESTIONS_PART_ID = 'reply-suggestions'

export const replySuggestionsSchema = z.object({
	suggestions: z.array(z.string()).max(REPLY_SUGGESTIONS_MAX)
})

/**
 * The agent that writes the replies: no memory, no tools. `instructions` say
 * who the user talks to and what a useful reply is; the model is built per
 * call, so an environment without its key still starts.
 */
export function createReplySuggestionsAgent(input: {
	readonly id: string
	/** The agent's name in Studio and traces. Default the id. */
	readonly name?: string
	readonly instructions: string
	readonly model: () => LanguageModel
	/**
	 * The model's options on every call, as `resolveLlm()` returns them. Set
	 * the reasoning effort here: a model left at its provider's default may
	 * think for longer than the replies are worth waiting for.
	 */
	readonly providerOptions?: ChatTurnPlan['providerOptions']
}): Agent {
	return new Agent({
		id: input.id,
		name: input.name ?? input.id,
		instructions: input.instructions,
		model: () => asAgentModel(input.model()),
		maxRetries: 0,
		...(input.providerOptions && {
			// Mastra types each provider's options; the AI SDK's are the same record, untyped.
			defaultOptions: {
				providerOptions: input.providerOptions as ProviderOptions
			}
		})
	})
}

/** The one message the replies are written from. */
export function toReplySuggestionsMessage(
	question: string,
	answer: string
): string {
	return `User: ${question}\nAssistant: ${answer}`
}

/** Streams the replies into `send`, each chunk the whole list so far; sends nothing when the model offers none, fails or runs out of time. */
export async function sendReplySuggestions(input: {
	readonly mastra: Mastra
	readonly agentId: string
	readonly question: string
	readonly answer: string
	/** Values the cost reports read, such as the user id. */
	readonly requestContext?: RequestContext
	/** The turn's signal: the client stopping ends the call. */
	readonly signal: AbortSignal
	readonly timeoutMs?: number
	readonly send: (chunk: UIMessageChunk) => void
	readonly onError?: (error: unknown) => void
}): Promise<void> {
	const abortSignal = timeoutSignal(input.timeoutMs ?? 6_000, input.signal)

	try {
		const stream = await input.mastra.getAgentById(input.agentId).stream(
			[
				{
					role: 'user',
					content: toReplySuggestionsMessage(input.question, input.answer)
				}
			],
			{
				structuredOutput: { schema: replySuggestionsSchema },
				requestContext: input.requestContext ?? new RequestContext(),
				abortSignal,
				tracingOptions: { tags: ['surface:reply-suggestions'] }
			}
		)
		let sent = ''

		for await (const partial of stream.objectStream) {
			const replies = toReplySuggestions(partial.suggestions ?? [])
			const key = JSON.stringify(replies)

			if (replies.length > 0 && key !== sent) {
				sent = key
				input.send({
					type: REPLY_SUGGESTIONS_PART,
					id: REPLY_SUGGESTIONS_PART_ID,
					data: { suggestions: replies },
					transient: true
				})
			}
		}

		// A failed model call ends the stream rather than throwing.
		if (stream.error) throw stream.error
	} catch (error) {
		if (!abortSignal.aborted) input.onError?.(error)
	}
}
