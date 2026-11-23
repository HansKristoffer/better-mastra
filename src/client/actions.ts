/**
 * Client actions: tools the app carries out itself (open a screen, fill a
 * form), whose definitions go along with each request and whose results go
 * back as the turn's follow-up. A call reaches the app as the model wrote
 * it, without the server's input validation, so the app parses it here.
 */

import type { UIMessage } from 'ai'
import { getToolName, isToolUIPart } from 'ai'
import {
	isRecord,
	stableStringify,
	typedSwitch,
	typedSwitchGroup
} from 'hanzio'
import { z } from 'zod'

import {
	CLIENT_ACTION_DISPATCHER_TOOL,
	type ClientToolDef
} from '../protocol/index.js'
import { compactJsonSchema } from '../protocol/jsonSchema.js'
import { currentUserTurn } from './messages.js'

export { CLIENT_ACTION_DISPATCHER_TOOL, type ClientToolDef }

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
	schema: z.core.$ZodType,
	value: unknown
): unknown {
	const def = (schema as z.core.$ZodTypes)._zod.def

	return typedSwitch(
		def,
		'type',
		{
			...typedSwitchGroup(
				def,
				'type',
				['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch'],
				(wrapper) =>
					value == null ? value : normalizeModelNulls(wrapper.innerType, value)
			),
			pipe: (pipe) => normalizeModelNulls(pipe.in, value),
			lazy: (lazy) => normalizeModelNulls(lazy.getter(), value),
			array: (array) =>
				Array.isArray(value)
					? value.map((item) => normalizeModelNulls(array.element, item))
					: value,
			record: (record) => {
				const { valueType } = record

				if (!isRecord(value)) {
					return value
				}

				return Object.fromEntries(
					Object.entries(value).flatMap(([key, item]) =>
						item === null && !z.safeParse(valueType, null).success
							? []
							: [[key, normalizeModelNulls(valueType, item)]]
					)
				)
			},
			union: (union) => {
				for (const option of union.options) {
					const normalized = normalizeModelNulls(option, value)

					if (z.safeParse(option, normalized).success) {
						return normalized
					}
				}

				return value
			},
			object: (object) => {
				if (!isRecord(value) || !(schema instanceof z.ZodObject)) {
					return value
				}

				const { shape } = object

				return Object.fromEntries(
					Object.entries(value).flatMap(([key, item]) => {
						const field = shape[key]

						if (field === undefined) {
							return [[key, item]]
						}

						const leaveOut =
							item === null &&
							z.safeParse(field, undefined).success &&
							!z.safeParse(field, null).success

						return leaveOut ? [] : [[key, normalizeModelNulls(field, item)]]
					})
				)
			}
		},
		() => value
	)
}

/** What the model reads when a queued client action's screen closed before it could run. */
export const CLIENT_ACTION_UNAVAILABLE =
	'That page action is no longer available because the user navigated away from the screen.'

const clientToolSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>()

function toCompactClientJsonSchema(schema: z.ZodType): Record<string, unknown> {
	let cached = clientToolSchemaCache.get(schema)
	if (!cached) {
		cached = compactJsonSchema(
			z.toJSONSchema(schema, {
				io: 'input',
				unrepresentable: 'any'
			}) as Record<string, unknown>
		)
		clientToolSchemaCache.set(schema, cached)
	}
	return cached
}

/** The definitions a request carries, for the server to offer the model as client tools. Memoized per schema and compacted. */
export function toClientToolDefs(
	actions: readonly ClientAction[]
): ClientToolDef[] {
	return actions.map((action) => ({
		name: action.name,
		description: action.description,
		jsonSchema: toCompactClientJsonSchema(action.inputSchema),
		...(action.requiresApproval === undefined
			? {}
			: { requiresApproval: action.requiresApproval })
	}))
}

/**
 * Carries out the client action a tool call names (including calls wrapped in
 * `CLIENT_ACTION_DISPATCHER_TOOL` `{ action, input }`) and posts its result on
 * the chat; null when no action has that name (a server tool: its result
 * arrives on the stream). A call the user turn already made with the same input
 * (`null`s aside) is refused instead of carried out again, unless the action
 * has its own `onRepeat`.
 *
 * Never await it inside the chat's `onToolCall`: the AI SDK runs that callback
 * on the queue `addToolOutput` waits on, so awaiting deadlocks the stream.
 */
export function runClientAction(
	chat: ClientActionChat,
	actions: readonly ClientAction[],
	toolCall: ClientToolCall,
	options: { readonly dispatcherTool?: string | false } = {}
): Promise<void> | null {
	const dispatcher =
		options.dispatcherTool === false
			? undefined
			: (options.dispatcherTool ?? CLIENT_ACTION_DISPATCHER_TOOL)
	const isDispatched =
		dispatcher !== undefined && toolCall.toolName === dispatcher

	let targetName = toolCall.toolName
	let targetInput = toolCall.input
	if (isDispatched) {
		if (
			!isRecord(toolCall.input) ||
			typeof toolCall.input.action !== 'string'
		) {
			return Promise.resolve(
				chat.addToolOutput({
					state: 'output-error',
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
					errorText: CLIENT_ACTION_INVALID_INPUT
				})
			)
		}
		targetName = toolCall.input.action
		targetInput = toolCall.input.input ?? {}
	}

	const action = actions.find((candidate) => candidate.name === targetName)

	if (action === undefined) {
		if (isDispatched) {
			return Promise.resolve(
				chat.addToolOutput({
					state: 'output-error',
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
					errorText: CLIENT_ACTION_UNAVAILABLE
				})
			)
		}
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
		const repeated = isRepeatInTurn(
			chat.messages,
			action,
			toolCall,
			targetInput,
			dispatcher
		)

		if (repeated && action.onRepeat === undefined) {
			await fail(CLIENT_ACTION_REPEATED)

			return
		}

		try {
			const output = await (repeated && action.onRepeat
				? action.onRepeat(targetInput, context)
				: action.run(targetInput, context))

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
	toolCall: ClientToolCall,
	targetInput: unknown,
	dispatcher: string | undefined
): boolean {
	const key = callKey(action, targetInput)

	return currentUserTurn(messages).some((message) =>
		message.parts.some((part) => {
			if (
				!isToolUIPart(part) ||
				part.toolCallId === toolCall.toolCallId ||
				part.state !== 'output-available'
			) {
				return false
			}
			const partName = getToolName(part)
			if (partName === action.name) {
				return callKey(action, part.input) === key
			}
			if (
				dispatcher !== undefined &&
				partName === dispatcher &&
				isRecord(part.input) &&
				part.input.action === action.name
			) {
				return callKey(action, part.input.input ?? {}) === key
			}
			return false
		})
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
	return stableStringify(normalizeModelNulls(action.inputSchema, input ?? {}))
}
