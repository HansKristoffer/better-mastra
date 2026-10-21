/**
 * The chat agent: a thin Mastra adapter over the turn plan. Its instructions,
 * tools, model and default options are functions of the request context that
 * only read the plan `runChatTurn` (or any caller of `rememberTurnPlan`)
 * stored, so "what does the model get" has one answer. A run ends right after
 * any tool in `stopAfterTools`.
 */

import { Agent, type AgentExecutionOptions } from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import type {
	ErrorProcessorOrWorkflow,
	InputProcessorOrWorkflow
} from '@mastra/core/processors'
import type { LanguageModel } from 'ai'
import type { z } from 'zod'

import {
	RetryBeforeAnswerText,
	ToolCallBudgetStop,
	TurnSignals
} from './processors.js'
import { CACHE_MARKER, withConversationCache } from './promptCache.js'
import {
	type ChatTurnPlan,
	findTurnPlan,
	type LanguageModelObject,
	type ProviderOptions
} from './types.js'

export interface CreateChatAgentOptions {
	readonly id: string
	readonly name?: string
	readonly description?: string
	/** Omit for single-shot agents with no thread to remember. */
	readonly memory?: MastraMemory
	/** Checked by Mastra before any model call. */
	readonly requestContextSchema?: z.ZodType
	/** Tools after which the run ends: a question card, a handoff. */
	readonly stopAfterTools?: readonly string[]
	/** Extra input processors, after the budget stop and the signals. */
	readonly processors?: readonly InputProcessorOrWorkflow[]
	readonly errorProcessors?: readonly ErrorProcessorOrWorkflow[]
	/** A whole run; keep it below the server's shutdown drain. Default 80 s. */
	readonly turnTimeoutMs?: number
	/** How long one model call may take to send content. Default 20 s. */
	readonly firstChunkTimeoutMs?: number
	/** Model calls one turn may repeat after a provider failure. Default 2. */
	readonly maxProcessorRetries?: number
	/** Tool calls per step of the plan's budget before the run stops. Default 3. */
	readonly toolCallsPerStep?: number
}

/**
 * A stop condition in the step shape Mastra's loop passes, which the AI SDK 7's
 * own `hasToolCall` does not type.
 */
type StopCondition = (options: {
	readonly steps: readonly {
		readonly toolCalls?: readonly { readonly toolName: string }[]
	}[]
}) => boolean

const UNPREPARED_INSTRUCTIONS = 'This agent runs only in a prepared chat turn.'

/**
 * The model Mastra gets when it resolves the agent without a prepared turn (its
 * probe at startup): environments without a model key still start, and it
 * fails if anything calls it.
 */
const UNPREPARED_MODEL: LanguageModelObject = {
	specificationVersion: 'v4',
	provider: 'better-mastra',
	modelId: 'unprepared-turn',
	supportedUrls: {},
	doGenerate: rejectUnpreparedTurn,
	doStream: rejectUnpreparedTurn
}

export function createChatAgent(options: CreateChatAgentOptions): Agent {
	const stopAfterTools = options.stopAfterTools ?? []
	const timeout = {
		totalMs: options.turnTimeoutMs ?? 80_000,
		firstChunkMs: options.firstChunkTimeoutMs ?? 20_000
	}
	const staticProcessors: InputProcessorOrWorkflow[] = [
		new ToolCallBudgetStop(options.toolCallsPerStep),
		new TurnSignals(),
		...(options.processors ?? [])
	]

	return new Agent({
		id: options.id,
		name: options.name ?? options.id,
		...(options.description && { description: options.description }),
		...(options.memory && { memory: options.memory }),
		...(options.requestContextSchema && {
			requestContextSchema: options.requestContextSchema
		}),
		// One retry layer: Mastra's error processors, never the model call.
		maxRetries: 0,
		maxProcessorRetries: options.maxProcessorRetries ?? 2,
		instructions: ({ requestContext }) => instructionsFor(requestContext),
		tools: ({ requestContext }) => findTurnPlan(requestContext)?.tools ?? {},
		model: ({ requestContext }) => modelFor(findTurnPlan(requestContext)),
		defaultOptions: ({ requestContext }) =>
			defaultOptionsFor(findTurnPlan(requestContext), stopAfterTools, timeout),
		inputProcessors: ({ requestContext }) => [
			...(findTurnPlan(requestContext)?.inputProcessors ?? []),
			...staticProcessors
		],
		errorProcessors: [
			new RetryBeforeAnswerText(),
			...(options.errorProcessors ?? [])
		]
	})
}

/** An AI SDK 7 model object; Mastra's agent types refuse strings and older specifications. */
export function asAgentModel(model: LanguageModel): LanguageModelObject {
	if (typeof model === 'string' || model.specificationVersion !== 'v4') {
		throw new Error('The chat agent needs an AI SDK 7 language model object.')
	}

	return model
}

/** The stable instructions carry the cache marker; the per-request part follows without one. */
function instructionsFor(requestContext: object) {
	const plan = findTurnPlan(requestContext)

	if (!plan) {
		return UNPREPARED_INSTRUCTIONS
	}

	const stable = {
		role: 'system' as const,
		content: plan.instructions,
		providerOptions: CACHE_MARKER
	}

	return plan.perRequestInstructions
		? [
				stable,
				{ role: 'system' as const, content: plan.perRequestInstructions }
			]
		: stable
}

function modelFor(plan: ChatTurnPlan | undefined): LanguageModelObject {
	return plan
		? withConversationCache(asAgentModel(plan.model))
		: UNPREPARED_MODEL
}

function defaultOptionsFor(
	plan: ChatTurnPlan | undefined,
	stopAfterTools: readonly string[],
	timeout: { readonly totalMs: number; readonly firstChunkMs: number }
): AgentExecutionOptions<undefined> {
	const options: AgentExecutionOptions<undefined> = {
		// Mastra streams signals to the client unless they are hidden.
		hideSignals: ['reactive', 'system-reminder'],
		// While a suspended tool is in the history it rewrites the system message on every call.
		autoResumeSuspendedTools: false,
		...(stopAfterTools.length > 0 && {
			stopWhen: stopAfterToolCall(stopAfterTools)
		})
	}

	if (!plan) {
		return options
	}

	return {
		...options,
		maxSteps: plan.maxSteps,
		// Mastra types each provider's options; the AI SDK's are the same record, untyped.
		...(plan.providerOptions && {
			providerOptions: plan.providerOptions as ProviderOptions
		}),
		...(plan.clientTools && { clientTools: plan.clientTools }),
		modelSettings: {
			...(plan.maxOutputTokens && { maxOutputTokens: plan.maxOutputTokens }),
			timeout
		}
	}
}

/** Ends the run after the step that called one of the tools, as the AI SDK's `hasToolCall` does. */
function stopAfterToolCall(toolNames: readonly string[]): StopCondition {
	return ({ steps }) =>
		steps
			.at(-1)
			?.toolCalls?.some((call) => toolNames.includes(call.toolName)) ?? false
}

function rejectUnpreparedTurn(): Promise<never> {
	return Promise.reject(
		new Error('The chat agent ran without a prepared turn plan.')
	)
}
