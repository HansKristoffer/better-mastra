import type { AgentExecutionOptions, ToolsInput } from '@mastra/core/agent'
import type { InputProcessorOrWorkflow } from '@mastra/core/processors'
import type { LanguageModel, UIMessage } from 'ai'

/** The thread one turn runs on and the memory resource it belongs to. */
export interface ThreadKey {
	readonly threadId: string
	readonly resourceId: string
}

/** An AI SDK 7 model object, the only model kind the chat agent takes. */
export type LanguageModelObject = Extract<
	LanguageModel,
	{ readonly specificationVersion: 'v4' }
>

export type ProviderOptions = NonNullable<
	AgentExecutionOptions['providerOptions']
>

/**
 * What the model gets in one turn, decided by the app's `prepare` before the
 * agent runs. It is kept beside the run's request context in a WeakMap, so it
 * never reaches a run snapshot, a trace span or a score row.
 */
export interface ChatTurnPlan {
	/** The stable instructions: the one system message with a cache marker. */
	readonly instructions: string
	/** A second system message without a cache marker, for what changes per request. */
	readonly perRequestInstructions?: string
	/** Sent as a transient signal on the first step; the thread never stores it. */
	readonly signal?: string
	readonly model: LanguageModel
	/** The id analytics and usage report; defaults to the model's own id. */
	readonly modelId?: string
	readonly tools?: ToolsInput
	/** Tools without `execute` the client answers (`addToolOutput`). */
	readonly clientTools?: ToolsInput
	/** Each tool's tier by wire name, reported with its settle event. */
	readonly toolTiers?: Readonly<Record<string, string>>
	readonly maxSteps: number
	readonly maxOutputTokens?: number
	/** Set by the server; nothing a client sends reaches it. */
	readonly providerOptions?: ProviderOptions
	/** Per-turn input processors, ahead of the agent's own. */
	readonly inputProcessors?: readonly InputProcessorOrWorkflow[]
}

/** The minimum chat body: the AI SDK's messages, and a suspended run to resume. */
export interface ChatTurnBody {
	readonly messages: readonly UIMessage[]
	/** Resumes a suspended tool call (a change plan the user ticked). */
	readonly resume?: ChatResume
	readonly trigger?: 'submit-message' | 'regenerate-message'
}

export interface ChatResume {
	readonly runId: string
	readonly toolCallId?: string
	readonly data: Record<string, unknown>
}

/** The fixed codes every refusal carries. */
export const chatErrorCodes = [
	'invalid_request',
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

/** A built-in code, or an app's own code with its status. */
export type ChatRefusal =
	| ChatErrorCode
	| { readonly code: string; readonly status: number }

const plans = new WeakMap<object, ChatTurnPlan>()

/** Keeps the plan beside the request context it was prepared for. */
export function rememberTurnPlan(
	requestContext: object,
	plan: ChatTurnPlan
): void {
	plans.set(requestContext, plan)
}

/** The plan prepared for this request context; undefined for one no turn made, such as Mastra's probe at startup. */
export function findTurnPlan(requestContext: object): ChatTurnPlan | undefined {
	return plans.get(requestContext)
}
