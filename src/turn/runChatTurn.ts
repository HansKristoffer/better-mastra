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
import type { UIMessage, UIMessageChunk } from 'ai'
import { once } from 'hanzio'

import {
	classifyTurnChanges,
	listPendingChanges,
	moveOnFromWaitingChanges,
	type PendingChange,
	type TurnChanges,
	withoutStaleAnswers
} from './changes.js'
import { chatErrorResponse, chatRefusal } from './errors.js'
import {
	createTurnObserver,
	type ToolSettledEvent,
	type TurnSummary
} from './observer.js'
import {
	ANSWER_COMPLETE_PART,
	sendReplySuggestions
} from './replySuggestions.js'
import {
	TURN_ERROR_SENTENCE,
	type TurnStreamEnding,
	USER_MESSAGE_PART,
	toUserFacingMessage,
	toUserFacingStream
} from './stream.js'
import type { RunUsage } from '../usage/stream.js'
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
	/**
	 * The run's usage, as `sinks.usage` got it; undefined when the run
	 * reported none before its stream closed, as a stopped run may not.
	 */
	readonly usage:
		Pick<TurnUsageEvent<TScope>, 'totalUsage' | 'steps'> | undefined
}

/**
 * The run's usage, in the shapes `readStreamTextUsage`, `llms.cost` and
 * `withUsage().meterStream` take.
 */
export interface TurnUsageEvent<TScope> {
	readonly scope: TScope
	readonly threadKey: ThreadKey
	readonly labels: TurnLabels
	readonly modelId: string
	readonly totalUsage: RunUsage | undefined
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
		/**
		 * The stored thread as the turn read it for its ownership check, so
		 * `prepare` need not read it again; null before its first turn. Its
		 * metadata holds the model arm. It was read just before the thread lock
		 * was claimed: what a turn that ended between that read and the claim
		 * wrote is not in it.
		 */
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
	onFirstText?(elapsedMs: number, scope: TScope, labels: TurnLabels): void
	/** The thread's title from its messages, written once; `false` writes none. */
	readonly deriveTitle?:
		false | ((messages: readonly UIMessage[]) => string | null)
	/**
	 * Replies offered after an answer, from this agent. They stream after the
	 * answer's `finish`, so the answer never waits for them: the chat session
	 * in `better-mastra/client` ends its turn at the answer and takes the
	 * replies as they arrive.
	 */
	readonly replySuggestions?: {
		readonly agentId: string
		readonly timeoutMs?: number
		readonly requestContext?: (scope: TScope) => AnyRequestContext
		/** Holds the answer's `finish` until the replies are in, for a client that stops reading at `finish`. Default false. */
		readonly holdFinish?: boolean
	}
	/** The only error text the client receives. */
	readonly errorSentence?: string
	/** The longest user message, in characters; a longer one is refused with `message_too_long`. Default 32,000. */
	readonly maxMessageLength?: number
	readonly sendReasoning?: boolean
	readonly logger?: ChatTurnLogger
	/**
	 * Attributes every error the turn logs carries, such as the user id.
	 * `scope` is undefined until the turn has resolved it.
	 */
	logAttributes?(
		request: ChatTurnRequest<TAuth, TBody>,
		scope: TScope | undefined
	): Record<string, unknown>
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
	const base = deps.logger ?? consoleLogger
	let scope: TScope | undefined
	const logger: ChatTurnLogger = deps.logAttributes
		? {
				error: (message, attributes) =>
					base.error(message, {
						...deps.logAttributes?.(request, scope),
						...attributes
					})
			}
		: base

	try {
		return await admitAndRun(request, deps, logger, (resolved) => {
			scope = resolved
		})
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
	logger: ChatTurnLogger,
	onScope: (scope: TScope) => void
): Promise<ChatTurnResult> {
	const startedAt = (deps.now ?? Date.now)()
	const messages = readMessages(request.body, deps.maxMessageLength ?? 32_000)

	if (messages === 'system') return refused('invalid_request')
	if (messages === 'too_long') return refused('message_too_long')

	const scope = await atStage('scope', () => deps.resolveScope(request))

	if (scope === undefined) return refused('forbidden')

	onScope(scope)

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
	const waiting = readWaitingChanges(turn, deps)
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
	const { changes, pending } = await classifyChanges(
		turn,
		waiting,
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
		onFirstText: (ms) => deps.onFirstText?.(ms, scope, labels),
		onToolSettled: (event) =>
			deps.sinks?.toolSettled?.({
				...event,
				scope,
				tier: plan.toolTiers?.[event.toolName],
				labels
			})
	})

	// What `onError` saw, oldest first, until the chunk it made passes: a
	// tool's error is the model's to read and `sinks.toolSettled` reports it;
	// only an `error` chunk is the turn failing.
	const reportedErrors: unknown[] = []
	let usage: TurnFinishedEvent<TScope>['usage']
	const observeErrors = (chunk: UIMessageChunk) => {
		if (chunk.type === 'tool-output-error') {
			reportedErrors.shift()
			return
		}
		if (chunk.type !== 'error' || reportedErrors.length === 0) return

		const error = reportedErrors.shift()
		observer.failed(error)
		logger.error('[better-mastra] the turn reported an error', {
			stage: 'model' satisfies ChatTurnStage,
			error
		})
	}

	const started = await handleChatStream({
		mastra: deps.mastra,
		agentId: deps.agentId,
		version: 'v7',
		sendReasoning: deps.sendReasoning ?? false,
		params: {
			// Built field by field: Mastra hands every params field it does not
			// know to the agent ahead of its defaults, so nothing else of the body
			// may reach it.
			messages: (pending
				? withoutStaleAnswers(prepared.messages ?? turn.messages, pending)
				: [...(prepared.messages ?? turn.messages)]) as never[],
			memory,
			requestContext,
			abortSignal: request.signal,
			...(request.body.trigger && { trigger: request.body.trigger }),
			...(resume && { runId: resume.runId, resumeData: resume.data }),
			...(prepared.tracingOptions && {
				tracingOptions: prepared.tracingOptions as never
			}),
			onFinish: (event: {
				totalUsage: RunUsage | undefined
				steps: readonly unknown[]
			}) => {
				usage = { totalUsage: event.totalUsage, steps: event.steps }
				deps.sinks?.usage?.({ scope, threadKey, labels, modelId, ...usage })
			}
		},
		// Called for a tool's error too, right before its `tool-output-error`
		// chunk: `observeErrors` decides which it was once the chunk passes.
		onError: (error) => {
			reportedErrors.push(error)

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
			...observer.summary({ ending, ...stopOf(request.signal) }),
			scope,
			threadKey,
			labels,
			modelId,
			durationMs: elapsedMs(),
			ending,
			newMessageText,
			answerText: observer.writtenText(),
			usage
		}

		deps.sinks?.turnFinished?.(finished)

		const title = deriveTitle === false ? null : deriveTitle(turn.messages)

		// Nothing to write means no read either: a thread that has its title
		// and already holds the turn's values, or a turn that gives neither.
		if (needsThreadMetadata(turn.thread, title, prepared.threadMetadata)) {
			// Awaited: the client refreshes its thread list when the stream closes.
			await persistThreadMetadata({
				memory: deps.memory,
				key: threadKey,
				title,
				...(prepared.threadMetadata && { metadata: prepared.threadMetadata })
			}).catch((error: unknown) =>
				logger.error('[better-mastra] the thread metadata was not written', {
					error
				})
			)
		}

		if (finished.outcome === 'answered') deps.sinks?.scoreTurn?.(finished)
	}

	const suggestions = deps.replySuggestions
	// Replies follow an answer that ended normally and leaves nothing to answer on a card.
	const epilogue =
		suggestions &&
		(async (send: (chunk: UIMessageChunk) => void) => {
			const { outcome } = observer.summary({
				ending: 'finished',
				...stopOf(request.signal)
			})
			const answer = observer.answerToFollow()
			const question = newMessageText.trim()

			if (outcome !== 'answered' || !answer || question.length === 0) return

			send({ type: ANSWER_COMPLETE_PART, data: {}, transient: true })
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
			observe: (chunk) => {
				observeErrors(chunk)
				observer.observe(chunk)
			},
			...(newMessage && {
				afterStart: {
					type: USER_MESSAGE_PART,
					data: { message: newMessage },
					transient: true
				} as UIMessageChunk
			}),
			close,
			...(epilogue && { epilogue }),
			...(suggestions?.holdFinish && { holdFinish: true }),
			...(deps.errorSentence && { errorSentence: deps.errorSentence }),
			onInternalError: (error) =>
				logger.error('[better-mastra] the turn stream failed', { error })
		})
	}
}

/**
 * Whether the turn has a title or a metadata value the thread, as read when
 * the turn started, does not hold yet. A thread that did not exist then needs
 * whatever the turn gives.
 */
function needsThreadMetadata(
	thread: StorageThreadType | null,
	title: string | null,
	metadata: Readonly<Record<string, unknown>> | undefined
): boolean {
	const needsTitle = Boolean(title) && !thread?.title?.trim()

	return (
		needsTitle ||
		Object.entries(metadata ?? {}).some(
			([key, value]) => thread?.metadata?.[key] !== value
		)
	)
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

/**
 * The changes waiting in the thread, read while the turn is prepared; both
 * only read. A thread never written has none, so its first turn reads
 * nothing. Undefined when the app keeps no waiting changes.
 */
function readWaitingChanges<TAuth, TBody extends ChatTurnBody, TScope>(
	turn: AdmittedTurn<TAuth, TBody, TScope>,
	deps: ChatTurnDeps<TAuth, TBody, TScope>
): Promise<readonly PendingChange[]> | undefined {
	if (deps.pendingChanges === false) return undefined

	if (turn.thread === null) return Promise.resolve([])

	const read = atStage('thread', () =>
		listPendingChanges(deps.mastra.getAgentById(deps.agentId), turn.threadKey)
	)
	// A failed preparation leaves it unawaited; awaiting it later still throws.
	read.catch(() => {})

	return read
}

async function classifyChanges<TAuth, TBody extends ChatTurnBody, TScope>(
	turn: AdmittedTurn<TAuth, TBody, TScope>,
	waiting: Promise<readonly PendingChange[]> | undefined,
	requestContext: RequestContext,
	memory: { readonly thread: string; readonly resource: string },
	deps: ChatTurnDeps<TAuth, TBody, TScope>,
	logger: ChatTurnLogger
): Promise<{
	readonly changes: TurnChanges
	/** The changes waiting in the thread; undefined when the app keeps none. */
	readonly pending: readonly PendingChange[] | undefined
}> {
	const { body, signal } = turn.request

	if (waiting === undefined) {
		return {
			changes: body.resume
				? { kind: 'resume', resume: body.resume }
				: { kind: 'continuation' },
			pending: undefined
		}
	}

	const pending = await waiting
	const changes = classifyTurnChanges(
		{ messages: turn.messages, resume: body.resume },
		pending
	)

	if (changes.kind === 'newMessage' && changes.waiting.length > 0) {
		const { movedOnData } = deps.pendingChanges || {}

		await atStage('tool', () =>
			moveOnFromWaitingChanges(changes.waiting, {
				agent: deps.mastra.getAgentById(deps.agentId),
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

	return { changes, pending }
}

/**
 * The messages the turn hands to Mastra, or why the body is refused: a system
 * message, which a client must never send, or a user message over the
 * maximum length. Observational memory's parts a client sent back are
 * dropped. A client tool's error reaches the model as Mastra's `error-text`
 * result.
 */
function readMessages(
	body: ChatTurnBody,
	maxMessageLength: number
): UIMessage[] | 'system' | 'too_long' {
	if (body.messages.some((message) => message.role === 'system'))
		return 'system'

	const isTooLong = body.messages.some(
		(message) =>
			message.role === 'user' && textOf(message).length > maxMessageLength
	)

	return isTooLong ? 'too_long' : body.messages.map(toUserFacingMessage)
}

function textOf(message: UIMessage | undefined): string {
	return (message?.parts ?? [])
		.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join('')
}

/** Who ended an aborted run: the server (`TurnAbortReason` `superseded` or `shutdown`) or the user, whose Stop or disconnect any other abort is. */
function stopOf(signal: AbortSignal): {
	readonly userStopped: boolean
	readonly interrupted: boolean
} {
	const interrupted =
		signal.aborted &&
		(signal.reason === 'superseded' || signal.reason === 'shutdown')

	return { userStopped: signal.aborted && !interrupted, interrupted }
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
	return once(() =>
		release().catch((error: unknown) =>
			logger.error('[better-mastra] the thread lock release failed', { error })
		)
	)
}
