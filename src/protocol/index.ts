/**
 * The chat's wire contract, for the server and the client alike: the part
 * names a turn streams, the refusal codes, the stop reasons, the turn
 * outcomes and the schemas of a request body. It imports only `zod` and the
 * AI SDK's types, so a schema file shared with a browser or React Native
 * bundle can import it. `/turn`, `/client` and `/tools` re-export from here.
 */

import type { UIMessage } from 'ai'
import { z } from 'zod'

// PARTS

/** The transient data part a turn streams right after its start: the user's message, for a client that reattaches before the thread stores it. */
export const USER_MESSAGE_PART = 'data-user-message'

/** The transient data part a server streams after an answer: up to three replies the user can tap to send. */
export const REPLY_SUGGESTIONS_PART = 'data-reply-suggestions'

/** The transient data part a server streams before the replies: the answer is complete and stored, and only the replies follow on its stream. */
export const ANSWER_COMPLETE_PART = 'data-answer-complete'

/** The part a run that a processor stopped ends with; its `reason` says why. */
export const TRIPWIRE_PART = 'data-tripwire'

/** Observational memory stores its own bookkeeping as `data-om-*` parts. */
const OBSERVATIONAL_MEMORY_PART_PREFIX = 'data-om-'

/** Whether a message part or stream chunk may reach the user: observational memory's `data-om-*` bookkeeping may not. */
export function isUserFacingPart(part: { readonly type: string }): boolean {
	return !part.type.startsWith(OBSERVATIONAL_MEMORY_PART_PREFIX)
}

/** The message with only its user-facing parts. */
export function toUserFacingMessage<M extends UIMessage>(message: M): M {
	return { ...message, parts: message.parts.filter(isUserFacingPart) }
}

export const REPLY_SUGGESTIONS_MAX = 3

/** The longest reply offered, in characters; a longer one is dropped. */
export const REPLY_SUGGESTION_MAX_LENGTH = 80

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

/** Default tool name for the cache-stable single-tool client action dispatcher. */
export const CLIENT_ACTION_DISPATCHER_TOOL = 'run_page_action'

/** `@mastra/ai-sdk` names an approval `<runId>::<toolCallId>` and reads its answer back by that id. */
export const APPROVAL_ID_SEPARATOR = '::'

/** The tripwire reason of an answer the tool call budget stopped (`readStopReason`). */
export const TOOL_CALL_BUDGET_STOP_REASON = 'tool_call_budget'

/** The tripwire reason of an answer stopped because its spend passed the plan's `costBudget.maxUsd`. */
export const COST_BUDGET_STOP_REASON = 'cost_budget'

// REFUSALS

/** The fixed codes every refusal carries. */
export const chatErrorCodes = [
	'invalid_request',
	'message_too_long',
	'unauthenticated',
	'forbidden',
	'unavailable',
	'consent_required',
	'not_found',
	'turn_in_progress',
	'change_expired',
	'usage_limited',
	'user_paused',
	'temporarily_unavailable'
] as const
export type ChatErrorCode = (typeof chatErrorCodes)[number]

/** The HTTP status each built-in code is answered with. */
export const chatErrorStatuses: Readonly<Record<ChatErrorCode, number>> = {
	invalid_request: 400,
	message_too_long: 413,
	unauthenticated: 401,
	forbidden: 403,
	unavailable: 403,
	consent_required: 403,
	not_found: 404,
	turn_in_progress: 409,
	change_expired: 409,
	usage_limited: 429,
	user_paused: 429,
	temporarily_unavailable: 503
}

/** A refusal in an app's own code, as `gate`, `admit` and `refusals` take it. */
export interface ChatErrorRefusal<TCode extends string = string> {
	readonly code: TCode
	readonly status: number
	readonly retryAfterSeconds?: number
}

/** An app's refusal codes: the built-in ones it keeps, and its own. */
export interface ChatErrors<TCode extends string> {
	/** Every code a client can receive, for a schema or an exhaustive switch. */
	readonly codes: readonly TCode[]
	status(code: TCode): number
	/** A refusal for `gate` or `admit`, in one of the app's codes. */
	refusal(
		code: TCode,
		options?: { readonly retryAfterSeconds?: number }
	): ChatErrorRefusal<TCode>
	/**
	 * The built-in refusals the app answers under a code of its own, for
	 * `runChatTurn`'s and `createChatRoute`'s `refusals`.
	 */
	readonly refusals: Partial<Record<ChatErrorCode, ChatErrorRefusal<TCode>>>
	/** Map from renamed built-in code to the app's wire code, used by `createChatErrorClassifier`. */
	readonly rename: Readonly<Partial<Record<ChatErrorCode, TCode>>>
	/** The `{ error }` body of every refusal, for the client to parse. */
	readonly bodySchema: z.ZodType<{
		error: TCode
		retryAfterSeconds?: number | undefined
	}>
}

/**
 * The refusal codes of one app: its own codes with their HTTP statuses, added
 * to the built-in ones, and the built-in ones it answers under another name.
 * A renamed built-in code never reaches the client, so it is not in `codes`.
 *
 * ```ts
 * export const chatErrors = defineChatErrors({
 *   codes: { workspace_forbidden: 403, chat_model_forbidden: 403 },
 *   rename: { forbidden: 'workspace_forbidden', not_found: 'workspace_forbidden' }
 * })
 * ```
 */
export function defineChatErrors<
	const TOwn extends Readonly<Record<string, number>>,
	const TRename extends Partial<Record<ChatErrorCode, keyof TOwn & string>> =
		Record<never, never>
>(definition: {
	readonly codes: TOwn
	readonly rename?: TRename
}): ChatErrors<Exclude<ChatErrorCode, keyof TRename> | (keyof TOwn & string)> {
	type Code = Exclude<ChatErrorCode, keyof TRename> | (keyof TOwn & string)

	const rename: Partial<Record<ChatErrorCode, string>> = definition.rename ?? {}
	const statuses: Record<string, number> = {
		...chatErrorStatuses,
		...definition.codes
	}
	const codeSet = new Set<string>([
		...chatErrorCodes.filter((code) => rename[code] === undefined),
		...Object.keys(definition.codes)
	])
	const codes = [...codeSet] as Code[]
	const status = (code: string) => {
		const found = statuses[code]

		if (found === undefined) throw new Error(`Unknown chat error code ${code}.`)

		return found
	}

	return {
		codes,
		status,
		refusal: (code, options) => ({
			code,
			status: status(code),
			...(options?.retryAfterSeconds !== undefined && {
				retryAfterSeconds: options.retryAfterSeconds
			})
		}),
		refusals: Object.fromEntries(
			Object.entries(rename).map(([builtIn, own]) => [
				builtIn,
				{ code: own as Code, status: status(own) }
			])
		),
		rename: rename as Readonly<Partial<Record<ChatErrorCode, Code>>>,
		bodySchema: z.object({
			error: z.enum(codes as [Code, ...Code[]]),
			retryAfterSeconds: z.number().optional()
		}) as unknown as ChatErrors<Code>['bodySchema']
	}
}

// OUTCOMES

/**
 * How a turn ended, as `sinks.turnFinished` reports it. `truncated` is the
 * model reaching its output-token limit (the stream's `finish` says
 * `finishReason: 'length'`): the answer is cut off, and a tool call it was
 * still writing never ran. `stopped` is the user's Stop or a dropped
 * connection; `interrupted` is the server ending it, a newer turn on the
 * thread or a shutdown (`TurnAbortReason`). `declined` is a message
 * screening turned away: the user got a short reply and nothing was stored.
 */
export const turnOutcomes = [
	'answered',
	'truncated',
	'stopped',
	'interrupted',
	'declined',
	'budget_stop',
	'timeout',
	'error'
] as const
export type TurnOutcome = (typeof turnOutcomes)[number]

// SCHEMAS

/**
 * A client action's definition as the client sends it. The name must be one
 * every provider takes as a tool name (Anthropic, OpenAI and Gemini): a name
 * with a space or a dot fails the whole model request.
 */
export const clientToolDefSchema = z.object({
	name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
	description: z.string().min(1).max(2_000),
	/** The action's input as JSON Schema, so the model sees typed parameters. */
	jsonSchema: z.record(z.string(), z.unknown()),
	requiresApproval: z.boolean().optional()
})

export type ClientToolDef = z.infer<typeof clientToolDefSchema>

const uiMessageShape = z.looseObject({
	id: z.string(),
	role: z.enum(['user', 'assistant', 'system']),
	parts: z.array(z.looseObject({ type: z.string() }))
})

/** An AI SDK UI message, checked for its shape only: the turn reads its parts itself. */
export const uiMessageSchema = z.custom<UIMessage>(
	(value) => uiMessageShape.safeParse(value).success,
	{ message: 'Expected a UI message' }
)

/** What a suspended tool call resumes with. */
export const chatResumeSchema = z.object({
	runId: z.string().min(1),
	toolCallId: z.string().min(1).optional(),
	data: z.record(z.string(), z.unknown())
})

/**
 * The body `createChatSession` sends by default. Extend it with the app's
 * own fields (`chatTurnBodySchema.extend({ pageContext })`) and parse with it
 * in `createChatRoute`'s `parseBody`.
 */
export const chatTurnBodySchema = z.object({
	threadId: z.string().min(1).max(200),
	messages: z.array(uiMessageSchema),
	trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
	resume: chatResumeSchema.optional(),
	clientTools: z.array(clientToolDefSchema).max(64).optional()
})

export type ChatTurnBodyInput = z.infer<typeof chatTurnBodySchema>

// CHANGE PLANS

/** The transient data part a turn streams after its answer when it proposed a change plan: `{ plan: ChangePlanView }`. */
export const CHANGE_PLAN_PART = 'data-change-plan'

/**
 * Where a change plan is: `draft` while its turn adds steps, `proposed` once
 * the turn answered and the user may confirm it, `applying` while one runner
 * holds it, then `applied`, `failed` (stopped at a step; applying again
 * resumes there) or `discarded`. `applied` and `discarded` are final.
 */
export const changePlanStatuses = [
	'draft',
	'proposed',
	'applying',
	'applied',
	'failed',
	'discarded'
] as const
export type ChangePlanStatus = (typeof changePlanStatuses)[number]

export const changePlanStepStatuses = ['pending', 'applied', 'failed'] as const
export type ChangePlanStepStatus = (typeof changePlanStepStatuses)[number]

/**
 * Why a step was not applied: its guard refused it (`refused`, with the
 * guard's sentence), a target no longer holds the value the plan saw
 * (`changed_since`), the stored snapshot is missing or unreadable
 * (`snapshot_unreadable`), the tool is gone (`unknown_tool`), a read or a
 * write failed, or another runner took the plan over (`lease_lost`).
 */
export const changePlanErrorCodes = [
	'refused',
	'changed_since',
	'snapshot_unreadable',
	'unknown_tool',
	'read_failed',
	'write_failed',
	'lease_lost'
] as const
export type ChangePlanErrorCode = (typeof changePlanErrorCodes)[number]

/** Why a plan could not be applied or discarded at all. */
export const changePlanRefusalCodes = [
	'not_found',
	'not_ready',
	'in_progress',
	'closed'
] as const
export type ChangePlanRefusalCode = (typeof changePlanRefusalCodes)[number]

/** The HTTP status of each refusal. */
export const changePlanRefusalStatuses: Readonly<
	Record<ChangePlanRefusalCode, number>
> = { not_found: 404, not_ready: 409, in_progress: 409, closed: 409 }

/** One target of a step as the confirm card shows it. */
export const changePlanChangeSchema = z.object({
	label: z.string().optional(),
	target: z.unknown(),
	before: z.unknown(),
	after: z.unknown()
})
export type ChangePlanChangeView = z.infer<typeof changePlanChangeSchema>

export const changePlanStepErrorSchema = z.object({
	code: z.enum(changePlanErrorCodes),
	message: z.string()
})

/** One step: its tool, what it changes, and for a bulk step a count with the first rows. */
export const changePlanStepSchema = z.object({
	index: z.number().int(),
	tool: z.string(),
	title: z.string(),
	status: z.enum(changePlanStepStatuses),
	/** How many targets the step changes. */
	count: z.number().int(),
	/** The first targets, all of them when `count` is no larger. */
	sample: z.array(changePlanChangeSchema),
	error: changePlanStepErrorSchema.optional()
})
export type ChangePlanStepView = z.infer<typeof changePlanStepSchema>

/** A change plan as the client sees it. */
export const changePlanSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	status: z.enum(changePlanStatuses),
	steps: z.array(changePlanStepSchema),
	createdAt: z.string(),
	updatedAt: z.string()
})
export type ChangePlanView = z.infer<typeof changePlanSchema>

/** One line of the apply route's NDJSON stream. */
export const changePlanProgressSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('step-started'), index: z.number().int() }),
	z.object({ type: z.literal('step-applied'), index: z.number().int() }),
	z.object({
		type: z.literal('step-failed'),
		index: z.number().int(),
		error: changePlanStepErrorSchema
	}),
	z.object({ type: z.literal('finished'), plan: changePlanSchema })
])
export type ChangePlanProgress = z.infer<typeof changePlanProgressSchema>

/** The `{ error }` body of a refused apply or discard. */
export const changePlanRefusalSchema = z.object({
	error: z.enum(changePlanRefusalCodes)
})

/**
 * What a plan-tier tool returns, so a client finds the plan in a stored
 * thread as well as on the live stream.
 */
export const changePlanStepOutputSchema = z.object({
	changePlan: z.object({
		planId: z.string(),
		step: changePlanStepSchema
	})
})
export type ChangePlanStepOutput = z.infer<typeof changePlanStepOutputSchema>

// TURN DATASETS

/** The transient data part a display tool streams for each dataset it shows: `{ dataset: TurnDatasetView }`. */
export const TURN_DATASET_PART = 'data-turn-dataset'

/** One column of a dataset; `type` is the app's own hint for its renderer, such as `currency`. */
export const turnDatasetColumnSchema = z.object({
	key: z.string(),
	label: z.string().optional(),
	type: z.string().optional()
})
export type TurnDatasetColumn = z.infer<typeof turnDatasetColumnSchema>

/** The rows a data tool registered, as the client renders them. */
export const turnDatasetSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	title: z.string().optional(),
	columns: z.array(turnDatasetColumnSchema),
	rows: z.array(z.record(z.string(), z.unknown())),
	createdAt: z.string()
})
export type TurnDatasetView = z.infer<typeof turnDatasetSchema>

// SCREENING

/** What message screening decides: answer it, or decline it as off topic or abusive. */
export const screeningVerdicts = ['allowed', 'off_topic', 'abusive'] as const
export type ScreeningVerdictKind = (typeof screeningVerdicts)[number]

/** The transient data part a declined message's reply carries: `{ verdict }`, so a client can mark the message. */
export const MESSAGE_DECLINED_PART = 'data-message-declined'
