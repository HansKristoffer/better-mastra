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

/** `@mastra/ai-sdk` names an approval `<runId>::<toolCallId>` and reads its answer back by that id. */
export const APPROVAL_ID_SEPARATOR = '::'

/** The tripwire reason of an answer the tool call budget stopped (`readStopReason`). */
export const TOOL_CALL_BUDGET_STOP_REASON = 'tool_call_budget'

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
	'temporarily_unavailable'
] as const
export type ChatErrorCode = (typeof chatErrorCodes)[number]

// OUTCOMES

/**
 * How a turn ended, as `sinks.turnFinished` reports it. `stopped` is the
 * user's Stop or a dropped connection; `interrupted` is the server ending it,
 * a newer turn on the thread or a shutdown (`TurnAbortReason`).
 */
export const turnOutcomes = [
	'answered',
	'stopped',
	'interrupted',
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
