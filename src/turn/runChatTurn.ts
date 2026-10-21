/**
 * Everything in one chat request after authentication, as ports: the scope
 * and its thread, the gate, the thread lock and the usage limit, the turn
 * preparation, what the request does with the changes waiting in the thread,
 * Mastra's chat stream and what of it reaches the client, and the turn's
 * events. Every refusal is a fixed error code; no raw error ever reaches the
 * client. A failure is logged with the stage it happened in.
 */

import { handleChatStream } from '@mastra/ai-sdk'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraMemory, StorageThreadType } from '@mastra/core/memory'
import {
	MASTRA_RESOURCE_ID_KEY,
	MASTRA_THREAD_ID_KEY,
	type RequestContext
} from '@mastra/core/request-context'
import { isToolUIPart, type UIMessage, type UIMessageChunk } from 'ai'

import {
	classifyTurnChanges,
	listPendingChanges,
	moveOnFromWaitingChanges,
	type PendingChange,
	type TurnChanges
} from './changes.js'
import { chatErrorResponse, chatRefusal } from './errors.js'
import {
	createTurnObserver,
	type ToolSettledEvent,
	type TurnSummary
} from './observer.js'
import { sendReplySuggestions } from './replySuggestions.js'
import {
	TURN_ERROR_SENTENCE,
	type TurnStreamEnding,
	USER_MESSAGE_PART,
	toUserFacingMessage,
	toUserFacingStream
} from './stream.js'
import { deriveThreadTitle, persistThreadMetadata } from './title.js'
import {
	type AnyRequestContext,
	type ChatRefusal,
	type ChatTurnBody,
	type ChatTurnPlan,
	rememberTurnPlan,
	type ThreadKey
} from './types.js'

export interface ChatTurnRequest<TAuth, TBody extends ChatTurnBody> {
	readonly auth: TAuth
	readonly body: TBody
	readonly headers: Headers
	/**
	 * Ends the run. The request's own signal binds the run to the connection;
	 * with resumable streams the route passes its own abort instead.
	 */
	readonly signal: AbortSignal
}

export type ChatTurnResult =
	| {
			readonly kind: 'refused'
			readonly code: string
			readonly status: number
			readonly response: Response
	  }
	| {
			readonly kind: 'stream'
			readonly threadKey: ThreadKey
			readonly stream: ReadableStream<UIMessageChunk>
	  }

/** What `prepare` returns for one turn. */
export interface PreparedChatTurn {
	/** The run's request context, typed or not; `defineRequestContext().create()` builds one. */
	readonly requestContext: AnyRequestContext
	readonly plan: ChatTurnPlan
	/** The messages Mastra gets, when the app transforms them (attachments). */
	readonly messages?: readonly UIMessage[]
	readonly tracingOptions?: {
		readonly tags?: readonly string[]
		readonly metadata?: Readonly<Record<string, unknown>>
	}
	/** Values the thread keeps from this turn (its model arm, its prompt version), written over the stored ones when the turn closes. */
	readonly threadMetadata?: Readonly<Record<string, unknown>>
	/** Labels every event of the turn carries, such as the model arm and the prompt version. */
	readonly labels?: Readonly<Record<string, string | number | boolean | null>>
}

export type TurnLabels = NonNullable<PreparedChatTurn['labels']>

export interface TurnFinishedEvent<TScope> extends TurnSummary {
	readonly scope: TScope
	readonly threadKey: ThreadKey
	readonly labels: TurnLabels
	readonly modelId: string
	readonly durationMs: number
	readonly ending: TurnStreamEnding
	/** The user's new message; empty when the request continues a turn. */
	readonly newMessageText: string
	/** Everything the answer wrote. Keep it out of analytics. */
	readonly answerText: string
}

export interface TurnUsageEvent<TScope> {
	readonly scope: TScope
	readonly threadKey: ThreadKey
	readonly labels: TurnLabels
	readonly modelId: string
	readonly totalUsage: unknown
	readonly steps: readonly unknown[]
}

/** Where a turn reports to; each sink is fire and forget and must not throw. */
export interface ChatTurnSinks<TScope> {
	toolSettled?(
		event: ToolSettledEvent & {
			readonly scope: TScope
			readonly tier: string | undefined
			readonly labels: TurnLabels
		}
	): void
	turnFinished?(event: TurnFinishedEvent<TScope>): void
	usage?(event: TurnUsageEvent<TScope>): void
	/**
	 * An answered turn, after its thread is written, for live scoring in the
	 * background. Sample here (`Math.random() < share`); it must not throw.
	 */
	scoreTurn?(event: TurnFinishedEvent<TScope>): void
}

/** The part of a turn that failed, for the log. */
export type ChatTurnStage =
	| 'scope'
	| 'gate'
	| 'thread_lock'
	| 'usage_limit'
	| 'preparation'
	| 'thread'
	| 'tool'
	| 'model'

export interface ChatTurnLogger {
	error(message: string, attributes: Record<string, unknown>): void
}

export interface ChatTurnDeps<TAuth, TBody extends ChatTurnBody, TScope> {
	readonly mastra: Mastra
	readonly agentId: string
	/** The agent's memory: thread ownership and titles. */
	readonly memory: MastraMemory
	/** Who asks, from the authenticated request; undefined refuses with `forbidden`. */
	resolveScope(
		request: ChatTurnRequest<TAuth, TBody>
	): Promise<TScope | undefined>
	/** The thread and memory resource of the scope, e.g. `user:workspace` or `organization:user`. */
	deriveThreadKey(scope: TScope, body: TBody): ThreadKey
	/** Access and consent; a refusal ends the turn before the lock. */
	gate?(scope: TScope, body: TBody): Promise<ChatRefusal | undefined>
	/** One turn per thread: the release, or null when another turn holds it. */
	lock?(threadKey: ThreadKey): Promise<(() => Promise<void>) | null>
	/** The usage limit, after the lock. */
	admit?(scope: TScope): Promise<ChatRefusal | undefined>
	/** Instructions, model and tools for this turn. */
	prepare(input: {
		readonly scope: TScope
		readonly body: TBody
		/**
		 * The body's messages as the turn hands them to Mastra: user-facing
		 * parts only, a client tool's error as a result the model can read.
		 * Return transformed ones as `messages` (attachments).
		 */
		readonly messages: readonly UIMessage[]
		readonly threadKey: ThreadKey
		/** The stored thread; null before its first turn. Its metadata holds the model arm. */
		readonly thread: StorageThreadType | null
		readonly signal: AbortSignal
	}): Promise<PreparedChatTurn>
	/**
	 * Waiting approvals and suspended tool calls: a request may answer only its
	 * own, and a new message declines them first. `false` skips the check.
	 */
	readonly pendingChanges?:
		| false
		| {
				/** What a suspended tool resumes with when the user moved on. Default `{ kind: 'movedOn' }`. */
				readonly movedOnData?: (
					change: PendingChange
				) => Record<string, unknown>
		  }
	readonly sinks?: ChatTurnSinks<TScope>
	onFirstText?(elapsedMs: number, scope: TScope): void
	/** The thread's title from its messages, written once; `false` writes none. */
	readonly deriveTitle?:
		| false
		| ((messages: readonly UIMessage[]) => string | null)
	/** Replies offered after an answer, from this agent. */
	readonly replySuggestions?: {
		readonly agentId: string
		readonly timeoutMs?: number
		readonly requestContext?: (scope: TScope) => AnyRequestContext
	}
	/** The only error text the client receives. */
	readonly errorSentence?: string
	/** The longest user message, in characters. Default 4,000. */
	readonly maxMessageLength?: number
	readonly sendReasoning?: boolean
	readonly logger?: ChatTurnLogger
	readonly now?: () => number
}

/** How far back a regenerated answer's user message is looked for. */
const RECENT_MESSAGES = 50

class ChatTurnStageError extends Error {
	constructor(
		readonly stage: ChatTurnStage,
		readonly failure: unknown
	) {
		super(`The chat turn failed at ${stage}.`)
	}
}

const consoleLogger: ChatTurnLogger = {
	// biome-ignore lint/suspicious/noConsole: the default logger, which apps replace.
	error: (message, attributes) => console.error(message, attributes)
}

/** Everything after authentication for one chat request: the stream, or a refusal. */
export async function runChatTurn<TAuth, TBody extends ChatTurnBody, TScope>(
	request: ChatTurnRequest<TAuth, TBody>,
	deps: ChatTurnDeps<TAuth, TBody, TScope>
): Promise<ChatTurnResult> {
	const logger = deps.logger ?? consoleLogger

	try {
		return await admitAndRun(request, deps, logger)
	} catch (error) {
		const staged = error instanceof ChatTurnStageError ? error : undefined

		logger.error('[better-mastra] the turn failed before its stream started', {
			stage: staged?.stage ?? 'unknown',
			error: staged?.failure ?? error
		})

		return refused('temporarily_unavailable')
	}
}

/** Sends a turn result as an HTTP response; the route adds the SSE heartbeat. */
export function refused(refusal: ChatRefusal): ChatTurnResult {
	const { code, status } = chatRefusal(refusal)

	return { kind: 'refused', code, status, response: chatErrorResponse(refusal) }
}

async function admitAndRun<TAuth, TBody extends ChatTurnBody, TScope>(
	request: ChatTurnRequest<TAuth, TBody>,
	deps: ChatTurnDeps<TAuth, TBody, TScope>,
	logger: ChatTurnLogger
): Promise<ChatTurnResult> {
	const startedAt = (deps.now ?? Date.now)()
	const messages = readMessages(request.body, deps.maxMessageLength ?? 4_000)

	if (!messages) return refused('invalid_request')

	const scope = await atStage('scope', () => deps.resolveScope(request))

	if (scope === undefined) return refused('forbidden')

	const gateRefusal = await atStage('gate', async () =>
		deps.gate?.(scope, request.body)
	)

	if (gateRefusal) return refused(gateRefusal)

	const threadKey = deps.deriveThreadKey(scope, request.body)

	const thread = await atStage('thread', () =>
		deps.memory.getThreadById({ threadId: threadKey.threadId })
	)

	// A thread that exists must belong to the turn's resource; one that does not yet is the caller's to create.
	if (thread && thread.resourceId !== threadKey.resourceId) {
		return refused('forbidden')
	}

	const lock = await atStage('thread_lock', async () =>
		deps.lock ? deps.lock(threadKey) : async () => {}
	)

	if (!lock) return refused('turn_in_progress')

	const release = releaseOnce(lock, logger)

	try {
		const usageRefusal = await atStage('usage_limit', async () =>
			deps.admit?.(scope)
		)

		if (usageRefusal) {
			await release()
			return refused(usageRefusal)
		}

		return await startTurn(
			{ request, scope, threadKey, thread, messages, startedAt, release },
			deps,
			logger
		)
	} catch (error) {
		await release()
		throw error
	}
}

interface AdmittedTurn<TAuth, TBody extends ChatTurnBody, TScope> {
	readonly request: ChatTurnRequest<TAuth, TBody>
	readonly scope: TScope
	readonly threadKey: ThreadKey
	readonly thread: StorageThreadType | null
	readonly messages: UIMessage[]
	readonly startedAt: number
	readonly release: () => Promise<void>
}

/** Preparation, the waiting changes, then Mastra's stream. A failure here releases the lock. */
async function startTurn<TAuth, TBody extends ChatTurnBody, TScope>(
	turn: AdmittedTurn<TAuth, TBody, TScope>,
	deps: ChatTurnDeps<TAuth, TBody, TScope>,
	logger: ChatTurnLogger
): Promise<ChatTurnResult> {
	const { request, scope, threadKey } = turn
	const prepared = await atStage('preparation', () =>
		deps.prepare({
			scope,
			body: request.body,
			messages: turn.messages,
			threadKey,
			thread: turn.thread,
			signal: request.signal
		})
	)
	const { requestContext, plan } = prepared
	const labels = prepared.labels ?? {}

	// The reserved keys force every memory operation in the run onto this thread.
	requestContext.setRaw(MASTRA_THREAD_ID_KEY, threadKey.threadId)
	requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, threadKey.resourceId)
	rememberTurnPlan(requestContext, plan)

	const memory = { thread: threadKey.threadId, resource: threadKey.resourceId }
	const changes = await classifyChanges(
		turn,
		requestContext,
		memory,
		deps,
		logger
	)

	if (changes.kind === 'expired') {
		await turn.release()
		return refused('change_expired')
	}

	if (request.body.trigger === 'regenerate-message') {
		await atStage('thread', () =>
			forgetAnswerAfter(deps.memory, threadKey, turn.messages.at(-1))
		)
	}

	const modelId =
		plan.modelId ??
		(typeof plan.model === 'string' ? plan.model : plan.model.modelId)
	const resume = changes.kind === 'resume' ? changes.resume : undefined
	const elapsedMs = () => (deps.now ?? Date.now)() - turn.startedAt
	const observer = createTurnObserver({
		elapsedMs,
		onFirstText: (ms) => deps.onFirstText?.(ms, scope),
		onToolSettled: (event) =>
			deps.sinks?.toolSettled?.({
				...event,
				scope,
				tier: plan.toolTiers?.[event.toolName],
				labels
			})
	})

	const started = await handleChatStream({
		mastra: deps.mastra,
		agentId: deps.agentId,
		version: 'v7',
		sendReasoning: deps.sendReasoning ?? false,
		params: {
			// Built field by field: Mastra hands every params field it does not
			// know to the agent ahead of its defaults, so nothing else of the body
			// may reach it.
			messages: [...(prepared.messages ?? turn.messages)] as never[],
			memory,
			requestContext,
			abortSignal: request.signal,
			...(request.body.trigger && { trigger: request.body.trigger }),
			...(resume && { runId: resume.runId, resumeData: resume.data }),
			...(prepared.tracingOptions && {
				tracingOptions: prepared.tracingOptions as never
			}),
			onFinish: (event: { totalUsage: unknown; steps: readonly unknown[] }) =>
				deps.sinks?.usage?.({
					scope,
					threadKey,
					labels,
					modelId,
					totalUsage: event.totalUsage,
					steps: event.steps
				})
		},
		onError: (error) => {
			observer.failed(error)
			logger.error('[better-mastra] the turn reported an error', {
				stage: 'model' satisfies ChatTurnStage,
				error
			})

			return deps.errorSentence ?? TURN_ERROR_SENTENCE
		}
	}).then(
		(stream) => stream as unknown as ReadableStream<UIMessageChunk>,
		(error: unknown) => {
			// A resume loads the run before the stream starts: a snapshot that is
			// gone, or a tool that no longer resumes it, fails here.
			if (resume === undefined) throw new ChatTurnStageError('model', error)

			logger.error('[better-mastra] a suspended tool call could not resume', {
				error
			})
			return undefined
		}
	)

	if (!started) {
		await turn.release()
		return refused('change_expired')
	}

	const newMessage =
		turn.messages.at(-1)?.role === 'user' ? turn.messages.at(-1) : undefined
	const newMessageText = newMessage ? textOf(newMessage) : ''
	const deriveTitle = deps.deriveTitle ?? deriveThreadTitle

	const close = async (ending: TurnStreamEnding) => {
		await turn.release()

		const finished: TurnFinishedEvent<TScope> = {
			...observer.summary({ ending, userStopped: request.signal.aborted }),
			scope,
			threadKey,
			labels,
			modelId,
			durationMs: elapsedMs(),
			ending,
			newMessageText,
			answerText: observer.writtenText()
		}

		deps.sinks?.turnFinished?.(finished)

		// Awaited: the client refreshes its thread list when the stream closes.
		await persistThreadMetadata({
			memory: deps.memory,
			key: threadKey,
			title: deriveTitle === false ? null : deriveTitle(turn.messages),
			...(prepared.threadMetadata && { metadata: prepared.threadMetadata })
		}).catch((error: unknown) =>
			logger.error('[better-mastra] the thread metadata was not written', {
				error
			})
		)

		if (finished.outcome === 'answered') deps.sinks?.scoreTurn?.(finished)
	}

	const suggestions = deps.replySuggestions
	// Replies follow an answer that ended normally and leaves nothing to answer on a card.
	const epilogue =
		suggestions &&
		(async (send: (chunk: UIMessageChunk) => void) => {
			const { outcome } = observer.summary({
				ending: 'finished',
				userStopped: request.signal.aborted
			})
			const answer = observer.answerToFollow()
			const question = newMessageText.trim()

			if (outcome !== 'answered' || !answer || question.length === 0) return

			await sendReplySuggestions({
				mastra: deps.mastra,
				agentId: suggestions.agentId,
				question,
				answer,
				signal: request.signal,
				send,
				...(suggestions.timeoutMs && { timeoutMs: suggestions.timeoutMs }),
				...(suggestions.requestContext && {
					requestContext: suggestions.requestContext(scope)
				}),
				onError: (error) =>
					logger.error('[better-mastra] the reply suggestions failed', {
						error
					})
			})
		})

	return {
		kind: 'stream',
		threadKey,
		stream: toUserFacingStream(started, {
			observe: (chunk) => observer.observe(chunk),
			...(newMessage && {
				afterStart: {
					type: USER_MESSAGE_PART,
					data: { message: newMessage },
					transient: true
				} as UIMessageChunk
			}),
			close,
			...(epilogue && { epilogue }),
			...(deps.errorSentence && { errorSentence: deps.errorSentence }),
			onInternalError: (error) =>
				logger.error('[better-mastra] the turn stream failed', { error })
		})
	}
}

/**
 * The client sends only the message the answer is written again for; the
 * thread still holds the answer it replaces, which the model would read and
 * the thread would keep beside the new one.
 */
async function forgetAnswerAfter(
	memory: MastraMemory,
	threadKey: ThreadKey,
	message: UIMessage | undefined
): Promise<void> {
	if (message?.role !== 'user') return

	// ponytail: the newest page only; an answer longer than it keeps its older messages.
	const { messages: stored } = await memory.recall({
		threadId: threadKey.threadId,
		resourceId: threadKey.resourceId,
		perPage: RECENT_MESSAGES,
		hideSignals: false,
		includeTotal: false
	})
	const index = stored.findIndex(
		(storedMessage) => storedMessage.id === message.id
	)
	const answer = index === -1 ? [] : stored.slice(index + 1)

	if (answer.length > 0) {
		await memory.deleteMessages(answer.map((storedMessage) => storedMessage.id))
	}
}

async function classifyChanges<TAuth, TBody extends ChatTurnBody, TScope>(
	turn: AdmittedTurn<TAuth, TBody, TScope>,
	requestContext: RequestContext,
	memory: { readonly thread: string; readonly resource: string },
	deps: ChatTurnDeps<TAuth, TBody, TScope>,
	logger: ChatTurnLogger
): Promise<TurnChanges> {
	const { body, signal } = turn.request

	if (deps.pendingChanges === false) {
		return body.resume
			? { kind: 'resume', resume: body.resume }
			: { kind: 'continuation' }
	}

	const agent = deps.mastra.getAgentById(deps.agentId)
	const pending = await atStage('thread', () =>
		listPendingChanges(agent, turn.threadKey)
	)
	const changes = classifyTurnChanges(
		{ messages: turn.messages, resume: body.resume },
		pending
	)

	if (changes.kind === 'newMessage' && changes.waiting.length > 0) {
		const { movedOnData } = deps.pendingChanges ?? {}

		await atStage('tool', () =>
			moveOnFromWaitingChanges(changes.waiting, {
				agent,
				memory,
				requestContext,
				signal,
				...(movedOnData && { movedOnData }),
				onError: (error, change) =>
					logger.error('[better-mastra] a waiting change was not declined', {
						runId: change.runId,
						kind: change.kind,
						error
					})
			})
		)
	}

	return changes
}

/**
 * The messages the turn hands to Mastra, or undefined for a body a client must
 * never send: a system message, or a user message over the maximum length.
 * Observational memory's parts a client sent back are dropped, and a client
 * tool's error becomes a result the model can read.
 */
function readMessages(
	body: ChatTurnBody,
	maxMessageLength: number
): UIMessage[] | undefined {
	const isRefused = body.messages.some(
		(message) =>
			message.role === 'system' ||
			(message.role === 'user' && textOf(message).length > maxMessageLength)
	)

	return isRefused
		? undefined
		: body.messages.map((message) =>
				clientToolErrorsAsResults(toUserFacingMessage(message))
			)
}

/**
 * Mastra builds the model's history from tool calls with a result only, so an
 * `output-error` call vanished with its error, and a step that reasoned right
 * before it ended in a bare thinking block, which Anthropic rejects.
 */
export function clientToolErrorsAsResults(message: UIMessage): UIMessage {
	if (message.role !== 'assistant') return message

	return {
		...message,
		parts: message.parts.map((part) =>
			isToolUIPart(part) && part.state === 'output-error'
				? ({
						...part,
						state: 'output-available',
						output: { error: part.errorText || 'The tool failed.' },
						errorText: undefined
					} as unknown as typeof part)
				: part
		)
	}
}

function textOf(message: UIMessage | undefined): string {
	return (message?.parts ?? [])
		.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join('')
}

async function atStage<T>(
	stage: ChatTurnStage,
	work: () => Promise<T>
): Promise<T> {
	try {
		return await work()
	} catch (error) {
		throw error instanceof ChatTurnStageError
			? error
			: new ChatTurnStageError(stage, error)
	}
}

/** The lock's release, run at most once and never throwing: a failed release is logged and the lock expires on its own. */
function releaseOnce(
	release: () => Promise<void>,
	logger: ChatTurnLogger
): () => Promise<void> {
	let released: Promise<void> | undefined

	return () => {
		released ??= release().catch((error: unknown) =>
			logger.error('[better-mastra] the thread lock release failed', { error })
		)

		return released
	}
}
