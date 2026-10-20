/**
 * The replies offered above the input after an answer: a fast model reads the
 * user's message and the answer, and returns up to three short replies the
 * user can tap, or none. They stream on the answer's own stream after its
 * thread lock is released, as the transient `data-reply-suggestions` part,
 * sent again each time the list grows. A failed or slow call offers nothing
 * and never fails the turn.
 */

import { Agent } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import type { LanguageModel, UIMessageChunk } from 'ai'
import { z } from 'zod'

import { asAgentModel } from './agent.js'

/** The data part's type on the answer's stream. */
export const REPLY_SUGGESTIONS_PART = 'data-reply-suggestions'

export const REPLY_SUGGESTIONS_MAX = 3

/** The longest reply offered, in characters; a longer one is dropped. */
export const REPLY_SUGGESTION_MAX_LENGTH = 80

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
	readonly instructions: string
	readonly model: () => LanguageModel
}): Agent {
	return new Agent({
		id: input.id,
		name: input.id,
		instructions: input.instructions,
		model: () => asAgentModel(input.model()),
		maxRetries: 0
	})
}

/** The one message the replies are written from. */
export function toReplySuggestionsMessage(
	question: string,
	answer: string
): string {
	return `User: ${question}\nAssistant: ${answer}`
}

/** The replies worth offering from a model's list, in its order: trimmed, not too long, no repeats, at most three. */
export function toReplySuggestions(
	suggestions: readonly (string | undefined)[]
): readonly string[] {
	const replies: string[] = []

	for (const suggestion of suggestions) {
		const reply = suggestion?.trim() ?? ''
		const isOffered =
			reply.length > 0 &&
			reply.length <= REPLY_SUGGESTION_MAX_LENGTH &&
			!replies.some((offered) => offered.toLowerCase() === reply.toLowerCase())

		if (isOffered) replies.push(reply)
	}

	return replies.slice(0, REPLY_SUGGESTIONS_MAX)
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
	const abortSignal = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(input.timeoutMs ?? 6_000)
	])

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
