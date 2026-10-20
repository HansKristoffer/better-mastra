/**
 * Owns one conversation: the AI SDK `Chat`, the turn reducer around it, and
 * the effects the reducer asks for. It lives outside any framework, so every
 * screen that shows the thread shows the same running answer. The reducer,
 * not the chat's request status, decides when a user turn is over, and every
 * request is one of its effects, so a thread loaded from history never
 * continues on its own.
 *
 * Client actions the answer calls are carried out when its request ends, and
 * their results go back as the user turn's follow-up request, together with
 * an error for each server tool call the request left without a result.
 * Changes the answer leaves waiting go to the reducer: the AI SDK sends the
 * answers to its approvals once the reducer waits for them, and a resume goes
 * out as a request with `resume`.
 *
 * With `resume`, the server keeps a run going when the connection drops: a
 * dropped request reattaches to its stream once instead of failing, Stop
 * also tells the server to stop, and `resumeStream()` reattaches to a running
 * answer on mount, when the app comes back to the foreground and when the
 * network returns.
 */

import {
	type ChatInit,
	DefaultChatTransport,
	type FileUIPart,
	getToolName,
	isToolUIPart,
	lastAssistantMessageIsCompleteWithApprovalResponses,
	type UIMessage
} from 'ai'

import {
	type ClientAction,
	type ClientToolCall,
	type ClientToolDef,
	runClientAction,
	toClientToolDefs
} from './actions.js'
import { ObservableChat } from './chat.js'
import {
	type ClassifyChatError,
	classifyChatError,
	isConnectionLost,
	readErrorResponse
} from './errors.js'
import type { ChatFetch } from './fetch.js'
import {
	countShownParts,
	findStrandedToolCalls,
	isUserFacingPart,
	REPLY_SUGGESTIONS_PART,
	readReplySuggestions,
	STRANDED_TOOL_ERROR,
	selectRequestMessages,
	type ToolPart
} from './messages.js'
import { type PendingChange, readWaitingChanges } from './pending.js'
import {
	type ChangeMark,
	type ChatTurnEffect,
	type ChatTurnEvent,
	type ChatTurnState,
	initialChatTurnState,
	reduceChatTurn,
	type RunResume
} from './turn.js'

// TYPES

/** What a client renders from a session besides the messages. */
export interface ChatSessionSnapshot {
	readonly turn: ChatTurnState
	/** A message the composer gets back, numbered so each one is applied once. */
	readonly restoredDraft: RestoredDraft | undefined
	/** What became of each change that stopped waiting without an answer, by tool call id. */
	readonly changeMarks: ReadonlyMap<string, ChangeMark>
	/** The replies offered after the newest answer; empty once the user writes. */
	readonly replySuggestions: readonly string[]
}

export interface RestoredDraft {
	readonly text: string
	readonly sequence: number
}

/** Everything one request carries, before `prepareBody` shapes it. */
export interface ChatRequest {
	readonly threadId: string
	/** The messages `selectRequestMessages` picked. */
	readonly messages: UIMessage[]
	readonly trigger: 'submit-message' | 'regenerate-message'
	/** What a resumed suspended run continues with. */
	readonly resume: RunResume | undefined
	/** The client actions this request offers, as definitions. */
	readonly clientTools: readonly ClientToolDef[]
}

/** How a failed request is reported for analytics: counts and enums only. */
export interface ChatFailureReport {
	/** A refusal code, `network`, `server_error` for any other failed response, `stream_error` when the stream carried the failure. */
	readonly code: string
	/** Whether the session tries again on its own. */
	readonly retrying: boolean
}

/** A signal that the app may have missed a running answer: it came to the foreground, the network returned. */
export type ResumeSignal = (resume: () => void) => () => void

export interface ChatSessionOptions {
	/** The thread; the chat's id, and the `:threadId` of the stream and stop routes. */
	readonly threadId: string
	readonly transport: {
		/** The chat route. Reattaching reads `GET {api}/:threadId/stream`, Stop posts `POST {api}/:threadId/stop`. */
		readonly api: string
		/** Usually `createChatFetch(...)`. */
		readonly fetch?: ChatFetch
		readonly credentials?: RequestInit['credentials']
	}
	/** Messages to start with, such as the thread's stored page. */
	readonly messages?: UIMessage[]
	/** The JSON body of one request; the request as it is when left out. */
	readonly prepareBody?: (request: ChatRequest) => object | Promise<object>
	/** The client actions requests offer and the session carries out, read per request: the screen on top may change. */
	readonly clientActions?:
		| readonly ClientAction[]
		| (() => readonly ClientAction[])
	/** Reads a refusal from a response that is not OK. */
	readonly classifyError?: ClassifyChatError
	/** Which parts count as shown; observational memory's never do. */
	readonly isUserFacingPart?: (part: UIMessage['parts'][number]) => boolean
	/** The server keeps a run going when the connection drops, and serves its stream and stop routes. */
	readonly resume?: boolean
	/** When to reattach to a running answer, with `resume`. */
	readonly resumeOn?: readonly ResumeSignal[]
	/** A tool's result arrived on the live stream, once per call: refresh the app's data after a write. */
	readonly onToolResult?: (result: {
		readonly toolCallId: string
		readonly toolName: string
		readonly output: unknown
	}) => void
	readonly onFailure?: (report: ChatFailureReport) => void
	readonly onData?: ChatInit<UIMessage>['onData']
	readonly generateId?: () => string
}

/** The user's answer to one waiting approval. */
export interface ApprovalAnswer {
	readonly approvalId: string
	readonly approved: boolean
	/** What the model reads in place of the result when the user declines. */
	readonly reason?: string
}

export interface ChatSession {
	readonly threadId: string
	readonly chat: ObservableChat
	readonly getSnapshot: () => ChatSessionSnapshot
	readonly subscribe: (listener: () => void) => () => void
	/** Sends a message, or queues it while a user turn runs. A message with files cannot queue: false, and the composer keeps it. */
	readonly send: (
		text: string,
		options?: { readonly files?: readonly FileUIPart[] }
	) => boolean
	readonly stop: () => void
	readonly tryAgain: () => void
	/** Answers an approval the user turn waits for; any other approval is left alone. */
	readonly answerApproval: (answer: ApprovalAnswer) => void
	/** Resumes a suspended run the user turn waits for, once. */
	readonly resumeRun: (resume: RunResume) => void
	/** The composer has put the restored message in its input; it is not handed back again. */
	readonly clearRestoredDraft: (sequence: number) => void
	/**
	 * Replaces the chat's messages with the thread's stored page, only while
	 * no user turn runs. Its pending changes then wait for the user, and its
	 * tool results never count as new.
	 */
	readonly showStored: (page: {
		/** The page's messages, with `rebuildPendingApprovals` applied. */
		readonly messages: readonly UIMessage[]
		readonly pendingChanges: readonly PendingChange[]
	}) => void
	/** Reattaches to the thread's running answer, with `resume`, when nothing runs here. */
	readonly resumeStream: () => void
	/** A session that is not on screen stops its answer and sends nothing: a message it held goes back to its composer. */
	readonly setFocused: (focused: boolean) => void
	/** Stops the answer and every resume signal. */
	readonly dispose: () => void
}

/** How the AI SDK said one request ended. */
interface RequestEnd {
	readonly isAbort: boolean
	readonly isDisconnect: boolean
	readonly isError: boolean
	readonly error: Error | undefined
}

type RequestKind = 'send' | 'resume'

// CONSTANTS

/**
 * The status a failure gets when the response was OK and its stream carried
 * the server's error part: the server already retried before any answer text.
 */
const STREAM_FAILURE_STATUS = 200

const NO_CHANGE_MARKS: ReadonlyMap<string, ChangeMark> = new Map()

const NO_REPLY_SUGGESTIONS: readonly string[] = []

const NO_ACTIONS: readonly ClientAction[] = []

// FUNCTIONS

/** A conversation for one thread. */
export function createChatSession(options: ChatSessionOptions): ChatSession {
	const { threadId } = options
	const classifyError = options.classifyError ?? classifyChatError
	const isUserFacing = options.isUserFacingPart ?? isUserFacingPart
	const resumable = options.resume === true
	const listeners = new Set<() => void>()
	let snapshot: ChatSessionSnapshot = {
		turn: initialChatTurnState,
		restoredDraft: undefined,
		changeMarks: NO_CHANGE_MARKS,
		replySuggestions: NO_REPLY_SUGGESTIONS
	}
	let focused = true
	/** Tool results already reported or loaded from history, by tool call id: each is reported once, as it arrives. */
	const knownResults = new Set<string>()
	/** Errors the session posted for stranded server calls; a follow-up carries them like client results. */
	const postedErrors = new Set<string>()
	/** The AI SDK sends the approval answers itself, without a promise to wait on, so its `onFinish` ends that request. */
	let sendsApprovalAnswers = false
	/** The client action calls of the request in flight, carried out once it ends. */
	let actionCalls: ClientToolCall[] = []
	/** Counts the requests, so actions of an earlier request never send a later turn's follow-up. */
	let requestCount = 0
	/** The parts the answer showed when the request started; only new ones count as shown. */
	let shownPartsBefore = 0
	/** Try again writes the answer again from the user's message, rather than going on with a failed one. */
	let startsOver = false
	/** Once the user writes, the replies still arriving come too late to show. */
	let offersReplies = true
	/** The resume the request in flight sends, read by the transport. */
	let pendingResume: RunResume | undefined
	let requestError: Error | undefined
	let requestEnd: RequestEnd | undefined

	const clientActions = (): readonly ClientAction[] => {
		const actions = options.clientActions

		return typeof actions === 'function' ? actions() : (actions ?? NO_ACTIONS)
	}
	const isClientAction = (toolName: string) =>
		clientActions().some((action) => action.name === toolName)
	const isClientResult = (part: ToolPart) =>
		postedErrors.has(part.toolCallId) || isClientAction(getToolName(part))

	const chat = new ObservableChat<UIMessage>({
		id: threadId,
		...(options.messages === undefined ? {} : { messages: options.messages }),
		...(options.generateId === undefined
			? {}
			: { generateId: options.generateId }),
		transport: new DefaultChatTransport<UIMessage>({
			api: options.transport.api,
			...(options.transport.fetch === undefined
				? {}
				: { fetch: options.transport.fetch as typeof fetch }),
			...(options.transport.credentials === undefined
				? {}
				: { credentials: options.transport.credentials }),
			// The server's stream route replays the run from its start.
			resumeStreamIsReplay: true,
			prepareSendMessagesRequest: async ({ messages, trigger }) => {
				const request: ChatRequest = {
					threadId,
					messages: selectRequestMessages(messages, { isClientResult }),
					trigger,
					resume: pendingResume,
					clientTools: toClientToolDefs(clientActions())
				}

				return { body: await (options.prepareBody ?? defaultBody)(request) }
			}
		}),
		onError: (error) => {
			requestError = error
		},
		onData: (part) => {
			options.onData?.(part)

			if (part.type !== REPLY_SUGGESTIONS_PART || !offersReplies) {
				return
			}

			const replies = readReplySuggestions(part.data)

			if (replies !== undefined) {
				publish({ ...snapshot, replySuggestions: replies })
			}
		},
		// Never awaits the action: the AI SDK runs this callback on the queue
		// `addToolOutput` waits on, so awaiting deadlocks the stream. The call
		// is carried out once the request ends.
		onToolCall: ({ toolCall }) => {
			if (isClientAction(toolCall.toolName)) {
				actionCalls.push({
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					input: toolCall.input
				})
			}
		},
		onFinish: ({ isAbort, isDisconnect, isError }) => {
			requestEnd = { isAbort, isDisconnect, isError, error: requestError }

			if (sendsApprovalAnswers) {
				sendsApprovalAnswers = false
				queueMicrotask(() => finishRequest('send'))
			}
		},
		// Once the user has answered every approval of the step, the AI SDK
		// sends the answers on its own, but only for a user turn that waits.
		sendAutomaticallyWhen: ({ messages }) =>
			lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) &&
			startApprovalRequest()
	})

	chat.subscribe(() => {
		if (countShownParts(chat.lastMessage, isUserFacing) > shownPartsBefore) {
			dispatch({ kind: 'content-shown' })
		}

		reportNewToolResults()
	})

	const unsubscribeSignals = resumable
		? (options.resumeOn ?? []).map((signal) => signal(() => resumeStream()))
		: []

	function dispatch(event: ChatTurnEvent): readonly ChatTurnEffect[] {
		const transition = reduceChatTurn(snapshot.turn, event)

		if (transition.state !== snapshot.turn) {
			publish({ ...snapshot, turn: transition.state })
		}

		for (const effect of transition.effects) {
			runEffect(effect)
		}

		return transition.effects
	}

	function runEffect(effect: ChatTurnEffect): void {
		switch (effect.kind) {
			case 'send-message':
				if (focused) {
					shownPartsBefore = 0
					startRequest('send', () =>
						chat.sendMessage(
							effect.files === undefined
								? { text: effect.text }
								: { text: effect.text, files: [...effect.files] }
						)
					)
				} else {
					restoreDraft(effect.text)
					endUnsentRequest()
				}
				return
			case 'request':
				if (focused) {
					startNextRequest()
				} else {
					endUnsentRequest()
				}
				return
			case 'resume-stream':
				startRequest('resume', () => chat.resumeStream())
				return
			case 'abort-request':
				void chat.stop()
				return
			case 'restore-draft':
				restoreDraft(effect.text)
				return
			case 'resume-run':
				if (focused) {
					sendResume(effect.resume)
				} else {
					endUnsentRequest()
				}
				return
			case 'mark-changes':
				markChanges(effect.mark, effect.changes)
				return
		}

		effect satisfies never
	}

	function restoreDraft(text: string): void {
		publish({
			...snapshot,
			restoredDraft: {
				text,
				sequence: (snapshot.restoredDraft?.sequence ?? 0) + 1
			}
		})
	}

	/**
	 * A request that goes on with the answer on screen when its trailing
	 * message holds the client's results (a follow-up, or a retry of one), and
	 * writes it again otherwise.
	 */
	function startNextRequest(): void {
		const continues =
			!startsOver &&
			selectRequestMessages(chat.messages, { isClientResult }).at(-1)?.role ===
				'assistant'

		shownPartsBefore = continues
			? countShownParts(chat.lastMessage, isUserFacing)
			: 0
		startRequest('send', () =>
			continues ? chat.sendMessage() : chat.regenerate()
		)
	}

	/** A resume goes on with the answer that shows the suspended run. */
	function sendResume(resume: RunResume): void {
		shownPartsBefore = countShownParts(chat.lastMessage, isUserFacing)
		startRequest('send', () => chat.sendMessage(), resume)
	}

	/**
	 * The AI SDK is about to send the user's answers to the approvals. The
	 * reducer counts the request; it goes out only when the user turn on screen
	 * waits for them.
	 */
	function startApprovalRequest(): boolean {
		if (!focused) {
			return false
		}

		const waited = snapshot.turn.kind === 'waiting'
		dispatch({ kind: 'approval-sent' })

		if (!waited || snapshot.turn.kind !== 'requesting') {
			return false
		}

		resetRequest()
		shownPartsBefore = countShownParts(chat.lastMessage, isUserFacing)
		sendsApprovalAnswers = true

		return true
	}

	function markChanges(
		mark: ChangeMark,
		changes: readonly PendingChange[]
	): void {
		const changeMarks = new Map(snapshot.changeMarks)

		for (const change of changes) {
			changeMarks.set(change.toolCallId, mark)
		}

		publish({ ...snapshot, changeMarks })
	}

	function reportNewToolResults(): void {
		for (const part of chat.lastMessage?.parts ?? []) {
			if (
				!isToolUIPart(part) ||
				part.state !== 'output-available' ||
				knownResults.has(part.toolCallId)
			) {
				continue
			}

			knownResults.add(part.toolCallId)

			const toolName = getToolName(part)

			if (!isClientAction(toolName)) {
				options.onToolResult?.({
					toolCallId: part.toolCallId,
					toolName,
					output: part.output
				})
			}
		}
	}

	/** Ends a user turn whose request was never sent, the way Stop would. */
	function endUnsentRequest(): void {
		dispatch({ kind: 'stop-pressed' })
		dispatch({ kind: 'request-finished', continues: false })
	}

	/** Runs one request and turns how it ended into the reducer's event once the AI SDK is done with it. */
	function startRequest(
		kind: RequestKind,
		request: () => Promise<void>,
		resume?: RunResume
	): void {
		resetRequest()
		pendingResume = resume

		void request().then(
			() => finishRequest(kind),
			(error: unknown) => finishRequest(kind, toError(error))
		)
	}

	function resetRequest(): void {
		takeReplySuggestions()
		offersReplies = true
		pendingResume = undefined
		requestError = undefined
		requestEnd = undefined
		actionCalls = []
		requestCount += 1
	}

	/**
	 * Changes the answer leaves waiting come first: the user answers them, and
	 * a client action called beside one waits with the step.
	 */
	function finishRequest(kind: RequestKind, rejection?: Error): void {
		const end = endOf(kind, rejection)

		if (end === 'nothing-to-resume') {
			dispatch({ kind: 'nothing-to-resume' })

			return
		}

		const isAnswered = !end.isAbort && !end.isError
		const calls = isAnswered ? actionCalls : []
		const waiting =
			isAnswered && chat.lastMessage?.role === 'assistant'
				? readWaitingChanges(chat.lastMessage)
				: []

		actionCalls = []

		if (waiting.length > 0) {
			dispatch({ kind: 'changes-waiting', changes: waiting })

			return
		}

		const stranded = isAnswered
			? findStrandedToolCalls(chat.lastMessage, isClientAction)
			: []

		if (calls.length > 0 || stranded.length > 0) {
			dispatch({ kind: 'request-finished', continues: true })

			// Stop or a focus change ended the user turn as its request ended.
			if (snapshot.turn.kind === 'continuing') {
				void carryOut(calls, stranded, requestCount)
			}

			return
		}

		const event = toTurnEvent(end)
		const effects = dispatch(event)
		const code = failureCodeOf(event, end)

		if (code !== undefined) {
			options.onFailure?.({
				code,
				retrying: effects.some(
					(effect) =>
						effect.kind === 'request' ||
						effect.kind === 'resume-stream' ||
						effect.kind === 'resume-run'
				)
			})
		}
	}

	/**
	 * How the request ended. A request the AI SDK never started (Stop while
	 * the message was being prepared) still settles the reducer; a reattach
	 * that found no stream ends without `onFinish`.
	 */
	function endOf(
		kind: RequestKind,
		rejection: Error | undefined
	): RequestEnd | 'nothing-to-resume' {
		if (rejection !== undefined) {
			return {
				isAbort: false,
				isDisconnect: false,
				isError: true,
				error: rejection
			}
		}

		if (requestEnd !== undefined) {
			return requestEnd
		}

		if (requestError !== undefined) {
			return {
				isAbort: false,
				isDisconnect: false,
				isError: true,
				error: requestError
			}
		}

		return kind === 'resume'
			? 'nothing-to-resume'
			: { isAbort: true, isDisconnect: false, isError: false, error: undefined }
	}

	function toTurnEvent(end: RequestEnd): ChatTurnEvent {
		if (end.isAbort || !end.isError) {
			return { kind: 'request-finished', continues: false }
		}

		const response = readErrorResponse(end.error)

		if (response !== undefined) {
			return {
				kind: 'error-response',
				status: response.status,
				refusal: classifyError(response)
			}
		}

		return isConnectionLost(end.error, end)
			? { kind: 'connection-lost', resumable }
			: {
					kind: 'error-response',
					status: STREAM_FAILURE_STATUS,
					refusal: undefined
				}
	}

	/**
	 * Carries out what the answer asked for, posts every result and an error
	 * for each stranded server call, then lets the reducer send the follow-up,
	 * unless the user turn has moved on meanwhile. One at a time, so a repeat
	 * in the same batch sees the call before it.
	 */
	async function carryOut(
		calls: readonly ClientToolCall[],
		stranded: readonly {
			readonly toolCallId: string
			readonly toolName: string
		}[],
		request: number
	): Promise<void> {
		for (const call of stranded) {
			postedErrors.add(call.toolCallId)
			await settle(
				chat.addToolOutput({
					state: 'output-error',
					tool: call.toolName,
					toolCallId: call.toolCallId,
					errorText: STRANDED_TOOL_ERROR
				})
			)
		}

		for (const call of calls) {
			await settle(runClientAction(chat, clientActions(), call))
		}

		if (request === requestCount && snapshot.turn.kind === 'continuing') {
			dispatch({ kind: 'follow-up-ready' })
		}
	}

	function takeReplySuggestions(): void {
		offersReplies = false

		if (snapshot.replySuggestions.length > 0) {
			publish({ ...snapshot, replySuggestions: NO_REPLY_SUGGESTIONS })
		}
	}

	function publish(next: ChatSessionSnapshot): void {
		snapshot = next

		for (const listener of listeners) {
			listener()
		}
	}

	/** Stop pressed: the request is aborted, and a server that keeps runs going is told to stop. */
	function stop(): void {
		const effects = dispatch({ kind: 'stop-pressed' })

		if (
			resumable &&
			effects.some((effect) => effect.kind === 'abort-request')
		) {
			void postStop()
		}
	}

	async function postStop(): Promise<void> {
		const send =
			options.transport.fetch ??
			((input, init) => globalThis.fetch(input, init))
		const url = `${options.transport.api.replace(/\/$/, '')}/${encodeURIComponent(threadId)}/stop`

		try {
			await send(url, {
				method: 'POST',
				...(options.transport.credentials === undefined
					? {}
					: { credentials: options.transport.credentials })
			})
		} catch {
			// The run ends on its own; Stop already ended the turn here.
		}
	}

	function resumeStream(): void {
		if (
			!resumable ||
			!focused ||
			chat.status === 'submitted' ||
			chat.status === 'streaming'
		) {
			return
		}

		const before = snapshot.turn
		dispatch({ kind: 'stream-watched' })

		if (snapshot.turn !== before) {
			startRequest('resume', () => chat.resumeStream())
		}
	}

	return {
		threadId,
		chat,
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		send: (text, sendOptions) => {
			const before = snapshot.turn
			const files = sendOptions?.files ?? []

			if (text.trim() !== '' || files.length > 0) {
				takeReplySuggestions()
			}

			const effects = dispatch(
				files.length === 0
					? { kind: 'message-submitted', text }
					: { kind: 'message-submitted', text, files }
			)

			return snapshot.turn !== before || effects.length > 0
		},
		stop,
		tryAgain: () => {
			startsOver = true
			dispatch({ kind: 'try-again-pressed' })
			startsOver = false
		},
		answerApproval: ({ approvalId, approved, reason }) => {
			const turn = snapshot.turn
			const waits =
				turn.kind === 'waiting' &&
				turn.changes.some(
					(change) =>
						change.kind === 'approval' && change.approvalId === approvalId
				)

			if (waits) {
				void chat.addToolApprovalResponse({
					id: approvalId,
					approved,
					...(reason === undefined ? {} : { reason })
				})
			}
		},
		resumeRun: (resume) => {
			dispatch({ kind: 'resume-pressed', resume })
		},
		clearRestoredDraft: (sequence) => {
			if (snapshot.restoredDraft?.sequence === sequence) {
				publish({ ...snapshot, restoredDraft: undefined })
			}
		},
		// A failed turn keeps its messages: Try again sends them again.
		showStored: ({ messages, pendingChanges }) => {
			if (snapshot.turn.kind !== 'idle') {
				return
			}

			for (const part of messages.flatMap((message) => message.parts)) {
				if (isToolUIPart(part)) {
					knownResults.add(part.toolCallId)
				}
			}

			chat.messages = [...messages]

			const last = messages.at(-1)
			const waiting = (
				last?.role === 'assistant' ? readWaitingChanges(last) : []
			).filter((change) =>
				pendingChanges.some(
					(pending) =>
						pending.kind === change.kind &&
						pending.runId === change.runId &&
						pending.toolCallId === change.toolCallId
				)
			)

			if (waiting.length > 0) {
				dispatch({ kind: 'changes-waiting', changes: waiting })
			}
		},
		resumeStream,
		setFocused: (isFocused) => {
			focused = isFocused

			if (!isFocused) {
				stop()
			}
		},
		dispose: () => {
			for (const unsubscribe of unsubscribeSignals) {
				unsubscribe()
			}

			void chat.stop()
		}
	}
}

/** The sessions of an app session by key (a thread, a workspace), created on first use and shared by every screen. */
export interface ChatSessions {
	/** The key's session, created the first time it is asked for. */
	readonly get: (key: string) => ChatSession
	/** Makes this the session on screen: every other one stops and sends nothing until it is on screen again. */
	readonly focus: (key: string) => void
	/** Stops the key's session and forgets it; the next screen that asks gets a new one. */
	readonly forget: (key: string) => void
	/** Stops and forgets every session, as on sign-out. */
	readonly clear: () => void
}

export function createChatSessions(
	create: (key: string) => ChatSession
): ChatSessions {
	const sessions = new Map<string, ChatSession>()

	return {
		get: (key) => {
			let session = sessions.get(key)

			if (session === undefined) {
				session = create(key)
				sessions.set(key, session)
			}

			return session
		},
		focus: (key) => {
			for (const [sessionKey, session] of sessions) {
				session.setFocused(sessionKey === key)
			}
		},
		forget: (key) => {
			sessions.get(key)?.dispose()
			sessions.delete(key)
		},
		clear: () => {
			for (const session of sessions.values()) {
				session.dispose()
			}

			sessions.clear()
		}
	}
}

/** The request as the body, with `resume` and `clientTools` only when there are any. */
function defaultBody(request: ChatRequest): object {
	return {
		threadId: request.threadId,
		messages: request.messages,
		trigger: request.trigger,
		...(request.resume === undefined ? {} : { resume: request.resume }),
		...(request.clientTools.length === 0
			? {}
			: { clientTools: request.clientTools })
	}
}

function failureCodeOf(
	event: ChatTurnEvent,
	end: RequestEnd
): string | undefined {
	switch (event.kind) {
		case 'connection-lost':
			return 'network'
		case 'error-response':
			if (event.refusal !== undefined) {
				return event.refusal.code
			}

			return readErrorResponse(end.error) === undefined
				? 'stream_error'
				: 'server_error'
		default:
			return undefined
	}
}

/** Waits for a result to be posted; one that fails to post still lets the turn go on. */
async function settle(posting: void | PromiseLike<void> | null): Promise<void> {
	try {
		await posting
	} catch {
		// The server reads the call as unanswered.
	}
}

function toError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason))
}
