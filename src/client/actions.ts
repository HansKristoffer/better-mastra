/**
 * Client actions: tools the app carries out itself (open a screen, fill a
 * form), whose definitions go along with each request and whose results go
 * back as the turn's follow-up. A call reaches the app as the model wrote
 * it, without the server's input validation, so the app parses it here.
 */

import type { UIMessage } from 'ai'
import { getToolName, isToolUIPart } from 'ai'
import { z } from 'zod'

import { currentUserTurn } from './messages.js'

// TYPES

type MessagePart = UIMessage['parts'][number]

/** Where the call sits, for an action with its own policy on repeats or shared steps. */
export interface ClientActionContext {
	readonly toolCallId: string
	/** The chat's messages when the call arrived; the call is in the last one. */
	readonly messages: readonly UIMessage[]
	/** The parts of the model step that made the call, the call and any server tool beside it included. */
	readonly step: readonly MessagePart[]
}

/** A tool that runs in the client. The server never interprets its name. */
export interface ClientAction<TName extends string = string> {
	readonly name: TName
	readonly description: string
	readonly inputSchema: z.ZodType
	readonly requiresApproval?: boolean
	/** Runs the action on the model's raw input. Throw to report a failure: the model reads it as an error it can act on. */
	readonly run: (
		input: unknown,
		context: ClientActionContext
	) => Promise<unknown>
	/**
	 * A call the user turn already made with the same input. Its result is
	 * posted as the call's output; throw to post an error. Default: an error
	 * with `CLIENT_ACTION_REPEATED`.
	 */
	readonly onRepeat?: (
		input: unknown,
		context: ClientActionContext
	) => Promise<unknown>
}

/** A client action as a request carries it, for the server to offer the model. */
export interface ClientToolDef {
	readonly name: string
	readonly description: string
	readonly jsonSchema: unknown
	readonly requiresApproval?: boolean
}

/** A tool call the stream handed to the client. */
export interface ClientToolCall {
	readonly toolCallId: string
	readonly toolName: string
	readonly input: unknown
}

/** The part of the AI SDK `Chat` a client action needs. */
export type ClientActionChat = {
	readonly messages: UIMessage[]
	readonly addToolOutput: (
		options:
			| { tool: string; toolCallId: string; output: unknown }
			| {
					state: 'output-error'
					tool: string
					toolCallId: string
					errorText: string
			  }
	) => void | PromiseLike<void>
}

type SchemaDef = {
	readonly type: string
	readonly innerType?: z.ZodType
	readonly element?: z.ZodType
	readonly valueType?: z.ZodType
	readonly in?: z.ZodType
	readonly options?: readonly z.ZodType[]
	readonly getter?: () => z.ZodType
}

// CONSTANTS

/** What the model reads when an action throws something that is not an Error. */
export const CLIENT_ACTION_FAILED = 'The action failed.'

/** What the model reads when the app cannot read the call's input. */
export const CLIENT_ACTION_INVALID_INPUT =
	'The app could not read this input. Call the action again with input that fits its schema.'

/** What the model reads for a call it already made with the same input in this turn. */
export const CLIENT_ACTION_REPEATED =
	'Already done with these values in this turn. Do not call it again; tell the user what changed.'

// FUNCTIONS

/**
 * A client action whose handler gets its input parsed, with the model's
 * `null`s taken out where the schema means "may be left out". With
 * `resultSummary`, the output is `{ summary, data }`, for a result the data
 * alone would leave the model guessing about.
 */
export function defineClientAction<
	const TName extends string,
	TSchema extends z.ZodType,
	TOutput
>(action: {
	readonly name: TName
	readonly description: string
	readonly inputSchema: TSchema
	readonly requiresApproval?: boolean
	readonly resultSummary?: string
	readonly handler: (
		input: z.output<TSchema>,
		context: ClientActionContext
	) => Promise<TOutput>
	readonly onRepeat?: ClientAction['onRepeat']
}): ClientAction<TName> {
	return {
		name: action.name,
		description: action.description,
		inputSchema: action.inputSchema,
		...(action.requiresApproval === undefined
			? {}
			: { requiresApproval: action.requiresApproval }),
		...(action.onRepeat === undefined ? {} : { onRepeat: action.onRepeat }),
		run: async (input, context) => {
			const parsed = action.inputSchema.safeParse(
				normalizeModelNulls(action.inputSchema, input ?? {})
			)

			if (!parsed.success) {
				throw new Error(CLIENT_ACTION_INVALID_INPUT)
			}

			const data = await action.handler(parsed.data, context)

			return action.resultSummary === undefined
				? data
				: { summary: action.resultSummary, data }
		}
	}
}

/**
 * Model arguments with `null` taken out wherever the schema means "may be
 * left out", at any depth. An OpenAI model behind Mastra's schema layer
 * fills every field it leaves alone with `null`; a `null` stays only where
 * the schema itself accepts it. Unions try each member and keep the first
 * reading that parses.
 */
export function normalizeModelNulls(
	schema: z.ZodType,
	value: unknown
): unknown {
	const def = schema._zod.def as unknown as SchemaDef

	switch (def.type) {
		case 'optional':
		case 'nullable':
		case 'default':
		case 'prefault':
		case 'readonly':
		case 'catch':
			return value == null || def.innerType === undefined
				? value
				: normalizeModelNulls(def.innerType, value)
		case 'pipe':
			return def.in === undefined ? value : normalizeModelNulls(def.in, value)
		case 'lazy':
			return def.getter === undefined
				? value
				: normalizeModelNulls(def.getter(), value)
		case 'array': {
			const element = def.element

			return Array.isArray(value) && element !== undefined
				? value.map((item) => normalizeModelNulls(element, item))
				: value
		}
		case 'record': {
			const valueType = def.valueType

			if (!isPlainObject(value) || valueType === undefined) {
				return value
			}

			return Object.fromEntries(
				Object.entries(value).flatMap(([key, item]) =>
					item === null && !valueType.safeParse(null).success
						? []
						: [[key, normalizeModelNulls(valueType, item)]]
				)
			)
		}
		case 'union': {
			for (const option of def.options ?? []) {
				const normalized = normalizeModelNulls(option, value)

				if (option.safeParse(normalized).success) {
					return normalized
				}
			}

			return value
		}
		case 'object': {
			if (!isPlainObject(value) || !(schema instanceof z.ZodObject)) {
				return value
			}

			const shape = schema.shape as Record<string, z.ZodType>

			return Object.fromEntries(
				Object.entries(value).flatMap(([key, item]) => {
					const field = shape[key]

					if (field === undefined) {
						return [[key, item]]
					}

					const leaveOut =
						item === null &&
						field.safeParse(undefined).success &&
						!field.safeParse(null).success

					return leaveOut ? [] : [[key, normalizeModelNulls(field, item)]]
				})
			)
		}
		default:
			return value
	}
}

/** The definitions a request carries, for the server to offer the model as client tools. */
export function toClientToolDefs(
	actions: readonly ClientAction[]
): ClientToolDef[] {
	return actions.map((action) => ({
		name: action.name,
		description: action.description,
		jsonSchema: z.toJSONSchema(action.inputSchema, {
			io: 'input',
			unrepresentable: 'any'
		}),
		...(action.requiresApproval === undefined
			? {}
			: { requiresApproval: action.requiresApproval })
	}))
}

/**
 * Carries out the client action a tool call names and posts its result on the
 * chat; null when no action has that name (a server tool: its result arrives
 * on the stream). A call the user turn already made with the same input
 * (`null`s aside) is refused instead of carried out again, unless the action
 * has its own `onRepeat`.
 *
 * Never await it inside the chat's `onToolCall`: the AI SDK runs that callback
 * on the queue `addToolOutput` waits on, so awaiting deadlocks the stream.
 */
export function runClientAction(
	chat: ClientActionChat,
	actions: readonly ClientAction[],
	toolCall: ClientToolCall
): Promise<void> | null {
	const action = actions.find(
		(candidate) => candidate.name === toolCall.toolName
	)

	if (action === undefined) {
		return null
	}

	const fail = (errorText: string) =>
		chat.addToolOutput({
			state: 'output-error',
			tool: toolCall.toolName,
			toolCallId: toolCall.toolCallId,
			errorText
		})

	const context: ClientActionContext = {
		toolCallId: toolCall.toolCallId,
		messages: chat.messages,
		step: stepOf(chat.messages, toolCall.toolCallId)
	}

	return (async () => {
		const repeated = isRepeatInTurn(chat.messages, action, toolCall)

		if (repeated && action.onRepeat === undefined) {
			await fail(CLIENT_ACTION_REPEATED)

			return
		}

		try {
			const output = await (repeated && action.onRepeat
				? action.onRepeat(toolCall.input, context)
				: action.run(toolCall.input, context))

			await chat.addToolOutput({
				tool: toolCall.toolName,
				toolCallId: toolCall.toolCallId,
				output
			})
		} catch (error) {
			await fail(error instanceof Error ? error.message : CLIENT_ACTION_FAILED)
		}
	})()
}

/**
 * The same action with the same input already ran in this user turn. Running
 * it again changes nothing and only feeds a model that is circling.
 */
function isRepeatInTurn(
	messages: readonly UIMessage[],
	action: ClientAction,
	toolCall: ClientToolCall
): boolean {
	const key = callKey(action, toolCall.input)

	return currentUserTurn(messages).some((message) =>
		message.parts.some(
			(part) =>
				isToolUIPart(part) &&
				part.toolCallId !== toolCall.toolCallId &&
				part.state === 'output-available' &&
				getToolName(part) === action.name &&
				callKey(action, part.input) === key
		)
	)
}

/** The parts between the `step-start` before the call and the next one; none when the call is not in the last message. */
function stepOf(
	messages: readonly UIMessage[],
	toolCallId: string
): MessagePart[] {
	const parts = messages.at(-1)?.parts ?? []
	const at = parts.findIndex(
		(part) => isToolUIPart(part) && part.toolCallId === toolCallId
	)

	if (at === -1) {
		return []
	}

	// The tsconfig lib predates `findLastIndex`.
	const start = parts
		.slice(0, at)
		.map((part) => part.type)
		.lastIndexOf('step-start')
	const end = parts.findIndex(
		(part, index) => index > at && part.type === 'step-start'
	)

	return parts.slice(start + 1, end === -1 ? undefined : end)
}

/** The input with the model's nulls left out, so the same call matches however the model wrote it. */
function callKey(action: ClientAction, input: unknown): string {
	return JSON.stringify(normalizeModelNulls(action.inputSchema, input ?? {}))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
