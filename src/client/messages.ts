/**
 * Message helpers every client shares: which messages one request sends,
 * which parts reach the user, the stored thread merged with the live one,
 * tool calls a request left without a result, and the reply suggestions an
 * answer offers.
 */

import {
	getToolName,
	isReasoningUIPart,
	isTextUIPart,
	isToolUIPart,
	type UIMessage
} from 'ai'

import { readSuspendedRun } from './pending.js'

// TYPES

type MessagePart = UIMessage['parts'][number]

/** A tool call in a message, from a typed tool or a dynamic one. */
export type ToolPart = Extract<MessagePart, { readonly toolCallId: string }>

/** One block a message draws, in the order of its parts. */
export type MessageBlock =
	| {
			readonly kind: 'text'
			readonly key: string
			readonly text: string
			/** The AI SDK is still writing this text. */
			readonly streaming: boolean
	  }
	/** Neighbouring tool parts: the cards of one step sit in one place between the texts. */
	| {
			readonly kind: 'tools'
			readonly key: string
			readonly parts: readonly ToolPart[]
	  }

export interface RequestMessageOptions {
	/** Whether a tool part holds a result the client produced: a client action's result, or an error it posted. */
	readonly isClientResult?: (part: ToolPart) => boolean
}

// CONSTANTS

const OBSERVATIONAL_MEMORY_PART_PREFIX = 'data-om-'

/** The transient data part a server streams after an answer: up to three replies the user can tap to send. */
export const REPLY_SUGGESTIONS_PART = 'data-reply-suggestions'

export const REPLY_SUGGESTIONS_MAX = 3

/** The longest reply offered, in characters; a longer one is dropped. */
export const REPLY_SUGGESTION_MAX_LENGTH = 80

/**
 * What the model reads for a server tool call a request left without a
 * result: Mastra drops a server result when a client action shares its step.
 */
export const STRANDED_TOOL_ERROR =
	'This tool call was interrupted because it ran in the same step as a client action. Call the tool again on its own to get the result.'

// FUNCTIONS

/** Whether a message part may reach the user: observational memory's `data-om-*` bookkeeping parts may not. */
export function isUserFacingPart(part: { readonly type: string }): boolean {
	return !part.type.startsWith(OBSERVATIONAL_MEMORY_PART_PREFIX)
}

/** The message with only its user-facing parts. */
export function toUserFacingMessage<M extends UIMessage>(message: M): M {
	return { ...message, parts: message.parts.filter(isUserFacingPart) }
}

/**
 * The blocks one message draws: its non-blank texts and its runs of tool
 * parts. Every other part, and every part observational memory adds, draws
 * nothing here; a client draws the data parts it knows itself.
 */
export function toMessageBlocks(message: UIMessage): MessageBlock[] {
	const blocks: MessageBlock[] = []

	for (const [index, part] of message.parts.entries()) {
		const key = `${message.id}:${index}`
		const previous = blocks.at(-1)

		if (!isUserFacingPart(part)) {
			continue
		}

		if (isTextUIPart(part) && part.text.trim() !== '') {
			blocks.push({
				kind: 'text',
				key,
				text: part.text,
				streaming: part.state === 'streaming'
			})
		} else if (isToolUIPart(part)) {
			if (previous?.kind === 'tools') {
				blocks[blocks.length - 1] = {
					...previous,
					parts: [...previous.parts, part]
				}
			} else {
				blocks.push({ kind: 'tools', key, parts: [part] })
			}
		}
	}

	return blocks
}

/**
 * The messages one request sends. Observational memory supplies the thread's
 * history, so a new user turn sends only the user's new message. When the
 * trailing assistant message carries results the client produced (client
 * action results, approval answers), the messages of the current user turn,
 * ending with that message. To resume a suspended run, the trailing assistant
 * message alone: Mastra resumes the run from its snapshot.
 */
export function selectRequestMessages(
	messages: readonly UIMessage[],
	options: RequestMessageOptions = {}
): UIMessage[] {
	const lastMessage = messages.at(-1)

	if (lastMessage === undefined) {
		return []
	}

	switch (lastMessage.role) {
		case 'user':
			return [lastMessage]
		case 'assistant':
			if (
				lastMessage.parts.some((part) => readSuspendedRun(part) !== undefined)
			) {
				return [lastMessage]
			}

			return carriesClientResults(lastMessage, options)
				? currentUserTurn(messages)
				: lastUserMessage(messages)
		case 'system':
			return lastUserMessage(messages)
	}
}

/** From the last user message to the end; the trailing message alone when there is no user message. */
export function currentUserTurn(messages: readonly UIMessage[]): UIMessage[] {
	const lastUserIndex = lastIndexOfUser(messages)

	if (lastUserIndex !== -1) {
		return messages.slice(lastUserIndex)
	}

	const trailing = messages.at(-1)

	return trailing === undefined ? [] : [trailing]
}

/** Which parts an answer resumes after: Mastra stores the continuation as a message of its own. */
export type ResumePointOptions = {
	/** Default `isToolResultPart`: after any tool's result. */
	readonly isResumePoint?: (part: MessagePart) => boolean
}

/** A tool call with its output or error, the default resume point. */
export function isToolResultPart(part: MessagePart): boolean {
	return (
		isToolUIPart(part) &&
		(part.state === 'output-available' || part.state === 'output-error')
	)
}

/**
 * Joins an assistant message into the assistant message before it when that
 * one ends at a resume point. Mastra stores the text a run wrote after
 * resuming from a client tool's result as a new message, while the client
 * streamed it into the message that holds the call; joining keeps that
 * message and its id.
 */
export function joinResumedAnswers<M extends UIMessage>(
	messages: readonly M[],
	options: ResumePointOptions = {}
): M[] {
	const isResumePoint = options.isResumePoint ?? isToolResultPart

	return messages.reduce<M[]>((joined, message) => {
		const previous = joined.at(-1)
		const lastPart = previous?.parts.at(-1)
		const resumesPrevious =
			message.role === 'assistant' &&
			previous?.role === 'assistant' &&
			lastPart !== undefined &&
			isResumePoint(lastPart)

		if (previous !== undefined && resumesPrevious) {
			joined[joined.length - 1] = {
				...previous,
				parts: [...previous.parts, ...message.parts]
			}
		} else {
			joined.push(message)
		}

		return joined
	}, [])
}

/**
 * The stored messages, oldest first, then the live ones. A message in both
 * shows once, as the live copy, which is the one still changing. An answer
 * resumed after a client action's result shows as one answer (see
 * `joinResumedAnswers`).
 */
export function mergeThreadMessages<M extends UIMessage>(
	stored: readonly M[],
	live: readonly M[],
	options: ResumePointOptions = {}
): M[] {
	const liveIds = new Set(live.map((message) => message.id))

	return joinResumedAnswers(
		[...stored.filter((message) => !liveIds.has(message.id)), ...live],
		options
	)
}

/**
 * Server tool calls a request left at `input-available`: Mastra drops a
 * server result when a client action shares its step. The session answers
 * them with `STRANDED_TOOL_ERROR`, so the follow-up goes on instead of
 * hanging.
 */
export function findStrandedToolCalls(
	message: UIMessage | undefined,
	isClientAction: (toolName: string) => boolean
): { readonly toolCallId: string; readonly toolName: string }[] {
	if (message?.role !== 'assistant') {
		return []
	}

	const suspended = new Set(
		message.parts.flatMap((part) => readSuspendedRun(part)?.toolCallId ?? [])
	)

	return message.parts.flatMap((part) => {
		if (
			!isToolUIPart(part) ||
			part.state !== 'input-available' ||
			part.providerExecuted === true ||
			suspended.has(part.toolCallId)
		) {
			return []
		}

		const toolName = getToolName(part)

		return isClientAction(toolName)
			? []
			: [{ toolCallId: part.toolCallId, toolName }]
	})
}

/**
 * Whether the newest answer's latest step puts something on screen: answer
 * text, a running tool card, or shown reasoning. A step with only finished
 * tools or hidden reasoning is the model working out of sight, and a
 * "Thinking…" indicator has to cover that gap.
 */
export function isShowingProgress(
	messages: readonly UIMessage[],
	options: { readonly reasoningVisible?: boolean } = {}
): boolean {
	const newest = messages.at(-1)

	if (newest?.role !== 'assistant') {
		return false
	}

	for (let index = newest.parts.length - 1; index >= 0; index -= 1) {
		const part = newest.parts[index]

		if (part === undefined || part.type === 'step-start') {
			return false
		}

		if (isTextUIPart(part) && part.text.length > 0) {
			return true
		}

		if (isToolUIPart(part)) {
			return (
				part.state === 'input-streaming' || part.state === 'input-available'
			)
		}

		if (
			options.reasoningVisible &&
			isReasoningUIPart(part) &&
			part.state === 'streaming'
		) {
			return true
		}
	}

	return false
}

/**
 * How many parts of an answer are on screen: answer text that is not blank,
 * and every tool part. Reasoning is not shown, and observational memory's
 * parts never are.
 */
export function countShownParts(
	message: UIMessage | undefined,
	isUserFacing: (part: MessagePart) => boolean = isUserFacingPart
): number {
	if (message?.role !== 'assistant') {
		return 0
	}

	return message.parts.filter(
		(part) =>
			isUserFacing(part) &&
			((isTextUIPart(part) && part.text.trim() !== '') || isToolUIPart(part))
	).length
}

/**
 * The replies a reply-suggestions data part carries, trimmed, without empty,
 * too long or repeated ones, at most three; undefined when the data is not a
 * reply list.
 */
export function readReplySuggestions(
	data: unknown
): readonly string[] | undefined {
	const suggestions = (data as { suggestions?: unknown } | null)?.suggestions

	if (!Array.isArray(suggestions)) {
		return undefined
	}

	return toReplySuggestions(
		suggestions.map((suggestion) =>
			typeof suggestion === 'string' ? suggestion : undefined
		)
	)
}

/** The replies worth offering from a model's list, in its order. */
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

		if (isOffered) {
			replies.push(reply)
		}
	}

	return replies.slice(0, REPLY_SUGGESTIONS_MAX)
}

function carriesClientResults(
	message: UIMessage,
	options: RequestMessageOptions
): boolean {
	return message.parts.some(
		(part) =>
			isToolUIPart(part) &&
			(part.state === 'approval-responded' ||
				((part.state === 'output-available' || part.state === 'output-error') &&
					options.isClientResult?.(part) === true))
	)
}

function lastUserMessage(messages: readonly UIMessage[]): UIMessage[] {
	const message = messages[lastIndexOfUser(messages)]

	return message === undefined ? [] : [message]
}

/** `findLastIndex`, which the ES2022 build target lacks. */
function lastIndexOfUser(messages: readonly UIMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === 'user') {
			return index
		}
	}

	return -1
}
