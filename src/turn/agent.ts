/**
 * The chat agent: a thin Mastra adapter over the turn plan. Its instructions,
 * tools, model and default options are functions of the request context that
 * only read the plan `runChatTurn` (or any caller of `rememberTurnPlan`)
 * stored, so "what does the model get" has one answer. A run ends right after
 * any tool in `stopAfterTools`.
 */

import {
	Agent,
	type AgentExecutionOptions,
	type ToolsInput
} from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import {
	type ErrorProcessorOrWorkflow,
	type InputProcessorOrWorkflow,
	type OutputProcessorOrWorkflow,
	PrefillErrorHandler,
	type ProcessInputStepResult
} from '@mastra/core/processors'
import type { LanguageModel } from 'ai'
import type { z } from 'zod'

import { compactTool } from '../tools/toolInputSchema.js'
import {
	RetryBeforeAnswerText,
	ToolCallBudgetStop,
	TurnSignals
} from './processors.js'
import {
	cacheMarkerFor,
	type PromptCacheTtl,
	withConversationCache
} from './promptCache.js'
import {
	type ChatTurnPlan,
	findTurnPlan,
	type LanguageModelObject,
	MAX_CACHED_INSTRUCTION_BLOCKS,
	type ProviderOptions,
	stableInstructionBlocks
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
	/** Output processors of every turn, after the plan's own. */
	readonly outputProcessors?: readonly OutputProcessorOrWorkflow[]
	readonly errorProcessors?: readonly ErrorProcessorOrWorkflow[]
	/** A whole run; keep it below the server's shutdown drain. Default 80 s. */
	readonly turnTimeoutMs?: number
	/** How long one model call may take to send content. Default 20 s. */
	readonly firstChunkTimeoutMs?: number
	/** Model calls one turn may repeat after a provider failure. Default 2. */
	readonly maxProcessorRetries?: number
	/** Tool calls per step of the plan's budget before the run stops. Default 3. */
	readonly toolCallsPerStep?: number
	/**
	 * Strips verbose Zod/oRPC string format regexes from tool JSON schemas
	 * before sending to the model (keeping runtime validation untouched).
	 * Defaults to `true`; pass `false` to send tool schemas unmodified.
	 */
	readonly compactToolSchemas?: boolean
	/**
	 * Includes Mastra's `PrefillErrorHandler` so Anthropic accepts continuation
	 * turns ending with assistant messages (tool results / approvals). Defaults
	 * to `true`; pass `false` to omit it.
	 */
	readonly prefillErrorHandler?: boolean
	/**
	 * Concurrent tool executions per step. Defaults to `{ limit: 10, strategy: 'called' }`
	 * so batches of read tools run in parallel even when approval/suspend tools
	 * are registered on the agent, while any step calling an approval/suspend
	 * tool still runs sequentially.
	 */
	readonly toolCallConcurrency?: AgentExecutionOptions['toolCallConcurrency']
}

const DEFAULT_TOOL_CALL_CONCURRENCY: NonNullable<
	AgentExecutionOptions['toolCallConcurrency']
> = {
	limit: 10,
	strategy: 'called'
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
	const compactTools = options.compactToolSchemas !== false
	const defaultConcurrency =
		options.toolCallConcurrency ?? DEFAULT_TOOL_CALL_CONCURRENCY
	const timeout = {
		totalMs: options.turnTimeoutMs ?? 80_000,
		firstChunkMs: options.firstChunkTimeoutMs ?? 20_000
	}
	const extraErrorProcessors = options.errorProcessors ?? []
	const hasPrefillHandler = extraErrorProcessors.some(
		(processor) =>
			processor instanceof PrefillErrorHandler ||
			('id' in processor && processor.id === 'prefill-error-handler')
	)
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
		tools: ({ requestContext }) =>
			normalizeTools(findTurnPlan(requestContext)?.tools, compactTools),
		model: ({ requestContext }) => modelFor(findTurnPlan(requestContext)),
		defaultOptions: ({ requestContext }) =>
			defaultOptionsFor(
				findTurnPlan(requestContext),
				stopAfterTools,
				timeout,
				compactTools,
				defaultConcurrency
			),
		inputProcessors: ({ requestContext }) => [
			...(findTurnPlan(requestContext)?.inputProcessors ?? []),
			...staticProcessors
		],
		outputProcessors: ({ requestContext }) => [
			...(findTurnPlan(requestContext)?.outputProcessors ?? []),
			...(options.outputProcessors ?? [])
		],
		errorProcessors: [
			...(options.prefillErrorHandler !== false && !hasPrefillHandler
				? [new PrefillErrorHandler()]
				: []),
			new RetryBeforeAnswerText(),
			...extraErrorProcessors
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

/**
 * A model as a processor's `processInputStep` returns it to replace the
 * step's model, with the conversation cache markers the chat agent puts on
 * the plan's own model.
 */
export function asStepModel(
	model: LanguageModel
): NonNullable<ProcessInputStepResult['model']> {
	// Mastra runs an AI SDK 7 model here; its step result types `doGenerate`
	// as returning a stream result, which no such model's does.
	return withConversationCache(asAgentModel(model)) as unknown as NonNullable<
		ProcessInputStepResult['model']
	>
}

function resolveCacheTtls(cacheTtl: ChatTurnPlan['cacheTtl']): {
	readonly instructions: PromptCacheTtl
	readonly conversation: PromptCacheTtl
} {
	if (typeof cacheTtl === 'string') {
		return { instructions: cacheTtl, conversation: cacheTtl }
	}
	const conversation = cacheTtl?.conversation ?? '5m'
	// Anthropic requires longest-TTL-first: a 1h conversation tail requires 1h instructions.
	const instructions =
		conversation === '1h' ? '1h' : (cacheTtl?.instructions ?? '5m')
	return { instructions, conversation }
}

/**
 * One system message per stable block, the last two with the cache marker (a
 * string plan is one block, marked); the per-request part follows without one.
 */
function instructionsFor(requestContext: object) {
	const plan = findTurnPlan(requestContext)

	if (!plan) {
		return UNPREPARED_INSTRUCTIONS
	}

	const marker = cacheMarkerFor(resolveCacheTtls(plan.cacheTtl).instructions)
	const blocks = stableInstructionBlocks(plan.instructions)
	const firstMarked = blocks.length - MAX_CACHED_INSTRUCTION_BLOCKS
	const stable = blocks.map((content, index) => ({
		role: 'system' as const,
		content,
		...(index >= firstMarked && { providerOptions: marker })
	}))
	const messages = plan.perRequestInstructions
		? [
				...stable,
				{ role: 'system' as const, content: plan.perRequestInstructions }
			]
		: stable

	// A list whose blocks are all empty leaves the agent without instructions.
	return messages.length === 1 ? messages[0]! : messages.length ? messages : ''
}

function modelFor(plan: ChatTurnPlan | undefined): LanguageModelObject {
	if (!plan) return UNPREPARED_MODEL
	const { conversation } = resolveCacheTtls(plan.cacheTtl)
	return withConversationCache(asAgentModel(plan.model), { ttl: conversation })
}

/**
 * Sorts tool keys deterministically so the prompt cache prefix never jitters
 * across requests or replicas, and compacts tool schemas when enabled.
 */
function normalizeTools(
	tools: ToolsInput | undefined,
	compactTools: boolean
): ToolsInput {
	if (!tools) return {}

	const sorted: ToolsInput = {}
	for (const key of Object.keys(tools).sort()) {
		const tool = tools[key]
		if (!tool) continue
		sorted[key] = compactTools ? compactTool(tool as never) : tool
	}
	return sorted
}

function defaultOptionsFor(
	plan: ChatTurnPlan | undefined,
	stopAfterTools: readonly string[],
	timeout: { readonly totalMs: number; readonly firstChunkMs: number },
	compactTools: boolean,
	defaultConcurrency: NonNullable<AgentExecutionOptions['toolCallConcurrency']>
): AgentExecutionOptions<undefined> {
	const options: AgentExecutionOptions<undefined> = {
		// Mastra streams signals to the client unless they are hidden.
		hideSignals: ['reactive', 'system-reminder'],
		// While a suspended tool is in the history it rewrites the system message on every call.
		autoResumeSuspendedTools: false,
		toolCallConcurrency: plan?.toolCallConcurrency ?? defaultConcurrency,
		...(stopAfterTools.length > 0 && {
			stopWhen: stopAfterToolCall(stopAfterTools)
		})
	}

	if (!plan) {
		return options
	}

	const openAiCache =
		plan.promptCacheKey !== undefined || plan.promptCacheRetention !== undefined
			? {
					...(plan.promptCacheKey !== undefined && {
						promptCacheKey: plan.promptCacheKey
					}),
					...(plan.promptCacheRetention !== undefined && {
						promptCacheRetention: plan.promptCacheRetention
					})
				}
			: undefined
	const mergedProviderOptions = openAiCache
		? ({
				...plan.providerOptions,
				openai: {
					...openAiCache,
					...(plan.providerOptions?.openai as
						Record<string, unknown> | undefined)
				}
			} as ProviderOptions)
		: (plan.providerOptions as ProviderOptions | undefined)

	return {
		...options,
		maxSteps: plan.maxSteps,
		// Mastra types each provider's options; the AI SDK's are the same record, untyped.
		...(mergedProviderOptions && {
			providerOptions: mergedProviderOptions
		}),
		...(plan.clientTools && {
			clientTools: normalizeTools(plan.clientTools, compactTools)
		}),
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
