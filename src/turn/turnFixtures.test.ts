/**
 * Doubles for the turn tests: a scripted mock model, a real Mastra instance
 * on `InMemoryStore` with the chat agent, an in-memory thread lock and a
 * recording sink, so whole turns run without a network.
 */

import { Mastra } from '@mastra/core/mastra'
import { InMemoryStore } from '@mastra/core/storage'
import { createTool } from '@mastra/core/tools'
import { Memory } from '@mastra/memory'
import {
	readUIMessageStream,
	simulateReadableStream,
	type UIMessage,
	type UIMessageChunk
} from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
	type ChatTurnBody,
	type ChatTurnDeps,
	type ChatTurnResult,
	createChatAgent,
	createReplySuggestionsAgent,
	defineRequestContext,
	runChatTurn,
	type ToolSettledEvent,
	type TurnFinishedEvent
} from './index.js'

type ModelStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
export type ModelStreamPart =
	ModelStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type ModelReply =
	readonly ModelStreamPart[] | (() => Promise<ModelStreamResult>)

export interface Scope {
	readonly userId: string
	readonly organizationId: string
}

export const SCOPE: Scope = { userId: 'user-1', organizationId: 'org-1' }
export const AGENT_ID = 'chat'
export const SUGGESTIONS_AGENT_ID = 'chat-suggestions'
export const LOOKUP_TOOL = 'lookupSpending'
export const DELETE_TOOL = 'deleteBudget'
export const ASK_TOOL = 'askQuestion'

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 }
}

export const requestContext = defineRequestContext(
	z.object({ userId: z.string(), organizationId: z.string() })
)

/** A model that answers each call with the next reply, repeating the last one. */
export function createScriptedModel(
	replies: readonly ModelReply[]
): MockLanguageModelV4 {
	let calls = 0

	return new MockLanguageModelV4({
		doStream: async () => {
			const reply = replies[Math.min(calls, replies.length - 1)] ?? []
			calls += 1

			return typeof reply === 'function'
				? reply()
				: { stream: simulateReadableStream({ chunks: [...reply] }) }
		}
	})
}

export function textReply(text: string): ModelStreamPart[] {
	return [
		{ type: 'stream-start', warnings: [] },
		{ type: 'text-start', id: 'text-1' },
		{ type: 'text-delta', id: 'text-1', delta: text },
		{ type: 'text-end', id: 'text-1' },
		finishPart('stop')
	]
}

export function toolCallReply(
	toolName: string,
	input: Record<string, unknown>,
	toolCallId = 'call-1'
): ModelStreamPart[] {
	return [
		{ type: 'stream-start', warnings: [] },
		{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
		finishPart('tool-calls')
	]
}

/** A stream that sends the parts and then fails with the error. */
export function failingReply(error: unknown): () => Promise<ModelStreamResult> {
	return async () => ({
		stream: new ReadableStream<ModelStreamPart>({
			start(controller) {
				controller.enqueue({ type: 'error', error })
				controller.close()
			}
		})
	})
}

function finishPart(reason: 'stop' | 'tool-calls'): ModelStreamPart {
	return {
		type: 'finish',
		finishReason: { unified: reason, raw: reason },
		usage: USAGE
	}
}

export function userMessage(text: string, id = crypto.randomUUID()): UIMessage {
	return { id, role: 'user', parts: [{ type: 'text', text }] }
}

/** The turn's chunks and the message the client builds from them. */
export async function readTurn(result: ChatTurnResult) {
	if (result.kind !== 'stream') {
		throw new Error(`The turn was refused: ${result.code}`)
	}

	const [forChunks, forMessage] = result.stream.tee()
	const chunks: UIMessageChunk[] = []
	let message: UIMessage | undefined

	await Promise.all([
		(async () => {
			for await (const chunk of forChunks) chunks.push(chunk)
		})(),
		(async () => {
			for await (const built of readUIMessageStream({ stream: forMessage })) {
				message = built
			}
		})()
	])

	return { chunks, message }
}

/**
 * A whole turn harness: the chat agent on a real Mastra instance with
 * in-memory storage, a lookup tool, a tool that needs approval and a question
 * tool that ends the run, with ports that record what the turn did.
 */
export function createHarness(
	options: {
		readonly replies?: readonly ModelReply[]
		readonly suggestions?: readonly ModelReply[]
		readonly maxSteps?: number
		readonly overrides?: Partial<ChatTurnDeps<string, ChatTurnBody, Scope>>
	} = {}
) {
	const storage = new InMemoryStore()
	const memory = new Memory({ storage, options: { lastMessages: 20 } })
	const model = createScriptedModel(options.replies ?? [textReply('Hej!')])
	const lookup = createTool({
		id: LOOKUP_TOOL,
		description: 'Looks up spending.',
		inputSchema: z.object({ category: z.string() }),
		execute: async () => ({ spent: 1_250 })
	})
	const deleteBudget = createTool({
		id: DELETE_TOOL,
		description: 'Deletes the budget.',
		inputSchema: z.object({ budgetId: z.string() }),
		requireApproval: true,
		execute: async () => ({ deleted: true })
	})
	const ask = createTool({
		id: ASK_TOOL,
		description: 'Asks the user a question.',
		inputSchema: z.object({ question: z.string() }),
		execute: async () => ({ asked: true })
	})
	const mastra = new Mastra({
		storage,
		logger: false,
		agents: {
			[AGENT_ID]: createChatAgent({
				id: AGENT_ID,
				memory,
				requestContextSchema: requestContext.schema,
				stopAfterTools: [ASK_TOOL]
			}),
			[SUGGESTIONS_AGENT_ID]: createReplySuggestionsAgent({
				id: SUGGESTIONS_AGENT_ID,
				instructions: 'Write replies.',
				model: () =>
					createScriptedModel(
						options.suggestions ?? [textReply('{"suggestions":[]}')]
					)
			})
		}
	})
	const held = new Set<string>()
	const releases: string[] = []
	const finished: TurnFinishedEvent<Scope>[] = []
	const settled: ToolSettledEvent[] = []
	const errors: unknown[] = []

	const deps: ChatTurnDeps<string, ChatTurnBody, Scope> = {
		mastra,
		agentId: AGENT_ID,
		memory,
		resolveScope: async ({ auth }) => (auth === 'user-1' ? SCOPE : undefined),
		deriveThreadKey: (scope) => ({
			threadId: `thread:${scope.organizationId}:${scope.userId}`,
			resourceId: `${scope.organizationId}:${scope.userId}`
		}),
		lock: async ({ threadId }) => {
			if (held.has(threadId)) return null
			held.add(threadId)

			return async () => {
				releases.push(threadId)
				held.delete(threadId)
			}
		},
		prepare: async ({ scope, threadKey }) => ({
			requestContext: requestContext.create(scope, threadKey),
			plan: {
				instructions: 'Stable instructions.',
				signal: 'Now on the budget page.',
				model,
				modelId: 'test-model',
				tools: {
					[LOOKUP_TOOL]: lookup,
					[DELETE_TOOL]: deleteBudget,
					[ASK_TOOL]: ask
				},
				toolTiers: { [LOOKUP_TOOL]: 'read', [DELETE_TOOL]: 'approval' },
				maxSteps: options.maxSteps ?? 4
			}
		}),
		sinks: {
			turnFinished: (event) => finished.push(event),
			toolSettled: (event) => settled.push(event)
		},
		logger: { error: (_message, attributes) => errors.push(attributes.error) },
		...options.overrides
	}

	const run = (
		body: ChatTurnBody,
		input: { readonly auth?: string; readonly signal?: AbortSignal } = {}
	) =>
		runChatTurn(
			{
				auth: input.auth ?? 'user-1',
				body,
				headers: new Headers(),
				signal: input.signal ?? new AbortController().signal
			},
			deps
		)

	return {
		mastra,
		memory,
		model,
		deps,
		run,
		held,
		releases,
		finished,
		settled,
		errors,
		threadKey: deps.deriveThreadKey(SCOPE, { messages: [] })
	}
}
