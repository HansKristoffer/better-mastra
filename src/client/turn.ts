/**
 * The turn reducer: a pure reducer for one user turn, from the user's message
 * until the answer is finished, across every request it takes. The session
 * feeds it events and runs the effects it returns; every request the session
 * sends is one of those effects, except the answer to an approval, which the
 * AI SDK sends on its own and the reducer is told about. A thread loaded from
 * history never continues on its own.
 */

import type { FileUIPart } from 'ai'
import { typedSwitch, typedSwitchGroup } from 'hanzio'

import type { PendingChange } from './pending.js'

// CONSTANTS

/**
 * The most automatic follow-up requests one user turn may send: room for
 * several client actions in a row, while a model that keeps calling them
 * still stops. The server's own step budget still ends a runaway request.
 */
export const CHAT_FOLLOW_UP_BUDGET = 8

/** Before any user turn: nothing is running. */
export const initialChatTurnState: ChatTurnState = { kind: 'idle' }

const NO_EFFECTS: readonly ChatTurnEffect[] = []

// TYPES

/** What Apply on a suspended run sends: the run and the data it resumes with. */
export interface RunResume<TData = unknown> {
	readonly runId: string
	readonly data: TData
}

/** A refusal the chat route answered, as the session's `classifyError` reads it. */
export interface ChatRefusal {
	readonly code: string
	readonly canTryAgain: boolean
	/** The approval or suspended run the request answered no longer waits. */
	readonly expired?: boolean
}

/** The counters of the user turn that is running. */
export interface ChatUserTurn {
	/** Text the user sent while this user turn runs; it goes out as the next user turn when this one ends answered or stopped. */
	readonly queued: string | undefined
	/** Whether this user turn has used its one automatic retry. */
	readonly retried: boolean
	/** How many automatic follow-up requests this user turn has sent: client action results, approval answers and resumes. */
	readonly followUps: number
	/** The waiting changes the request in flight answers; an expired refusal marks them expired. */
	readonly answering: readonly PendingChange[]
	/** The suspended runs this user turn has resumed: each is resumed once. */
	readonly resumedRunIds: readonly string[]
	/** The resume the request in flight sends, so a retry of the request sends it again. */
	readonly resume: RunResume | undefined
	/**
	 * The session reattached to a stream nobody asked for here (mount,
	 * foreground, network back), from this state: until it shows something it
	 * ends quietly, back where it was.
	 */
	readonly watching: false | 'idle' | 'failed'
}

/** What a change card says once it no longer waits without being answered. */
export type ChangeMark =
	/** The user wrote a new message instead, so the server declined it. */
	| 'movedOn'
	/** The server no longer had it waiting when the user answered. */
	| 'expired'

/** Why a user turn ended without its answer. */
export type ChatTurnFailure =
	| { readonly kind: 'refused'; readonly refusal: ChatRefusal }
	| { readonly kind: 'server-error'; readonly status: number }
	| { readonly kind: 'connection-lost' }
	| { readonly kind: 'follow-up-budget-exhausted' }

export type ChatTurnState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'requesting'; readonly userTurn: ChatUserTurn }
	| { readonly kind: 'streaming'; readonly userTurn: ChatUserTurn }
	| { readonly kind: 'continuing'; readonly userTurn: ChatUserTurn }
	| { readonly kind: 'stopping'; readonly userTurn: ChatUserTurn }
	/** The answer left changes for the user to answer: approvals to confirm, suspended runs to resume. Stop is not offered. */
	| {
			readonly kind: 'waiting'
			readonly userTurn: ChatUserTurn
			readonly changes: readonly PendingChange[]
	  }
	| {
			readonly kind: 'failed'
			readonly failure: ChatTurnFailure
			/** The resume the failed request sent, which Try again sends again. */
			readonly resume?: RunResume
	  }

export type ChatTurnEvent =
	| {
			readonly kind: 'message-submitted'
			readonly text: string
			readonly files?: readonly FileUIPart[]
	  }
	| { readonly kind: 'content-shown' }
	| { readonly kind: 'request-finished'; readonly continues: boolean }
	| {
			readonly kind: 'error-response'
			readonly status: number
			/** Undefined for a response the chat route did not refuse, such as a proxy's 502. */
			readonly refusal: ChatRefusal | undefined
	  }
	/** `resumable`: the server keeps the run going, so the stream can be reattached instead of sent again. */
	| { readonly kind: 'connection-lost'; readonly resumable: boolean }
	| { readonly kind: 'follow-up-ready' }
	| { readonly kind: 'stop-pressed' }
	| { readonly kind: 'try-again-pressed' }
	/** The user asked for the newest answer written again. */
	| { readonly kind: 'regenerate-pressed' }
	/**
	 * Changes wait for the user: the request ended answered with them in its
	 * last assistant message, or a thread loaded from history shows them.
	 */
	| {
			readonly kind: 'changes-waiting'
			readonly changes: readonly PendingChange[]
	  }
	/** The AI SDK started the request that carries the user's answers to the waiting approvals. */
	| { readonly kind: 'approval-sent' }
	/** The user pressed Apply on a waiting suspended run. */
	| { readonly kind: 'resume-pressed'; readonly resume: RunResume }
	/** The session reattached to the thread's running stream on its own. */
	| { readonly kind: 'stream-watched' }
	/** A reattach found no running stream. */
	| { readonly kind: 'nothing-to-resume' }

export type ChatTurnEffect =
	| {
			readonly kind: 'send-message'
			readonly text: string
			readonly files?: readonly FileUIPart[]
	  }
	| { readonly kind: 'request' }
	/** Reattaches to the run the server keeps going after the connection dropped. */
	| { readonly kind: 'resume-stream' }
	| { readonly kind: 'abort-request' }
	| { readonly kind: 'restore-draft'; readonly text: string }
	/** Sends a request with `resume`, which continues the answer of the suspended run. */
	| { readonly kind: 'resume-run'; readonly resume: RunResume }
	/** Tells the cards of these changes what became of them. */
	| {
			readonly kind: 'mark-changes'
			readonly mark: ChangeMark
			readonly changes: readonly PendingChange[]
	  }

export interface ChatTurnTransition {
	readonly state: ChatTurnState
	readonly effects: readonly ChatTurnEffect[]
}

type UserTurnState = Extract<ChatTurnState, { userTurn: unknown }>

// FUNCTIONS

/**
 * A pure reducer for one user turn; the session runs its effects. An event
 * that does not apply returns the given state object and no effect, and the
 * input is never changed.
 */
export function reduceChatTurn(
	state: ChatTurnState,
	event: ChatTurnEvent
): ChatTurnTransition {
	if (event.kind === 'message-submitted' && isBlank(event)) {
		return unchanged(state)
	}

	return typedSwitch(state, 'kind', {
		idle: (idle) => reduceIdle(idle, event),
		requesting: (requesting) => reduceRequesting(requesting, event),
		streaming: (streaming) => reduceStreaming(streaming, event),
		continuing: (continuing) => reduceContinuing(continuing, event),
		stopping: (stopping) => reduceStopping(stopping, event),
		waiting: (waiting) => reduceWaiting(waiting, event),
		failed: (failed) => reduceFailed(failed, event)
	})
}

/** Whether Try again is offered for a failure. The reducer ignores Try again when it is not. */
export function canTryAgain(failure: ChatTurnFailure): boolean {
	return typedSwitch(failure, 'kind', {
		refused: (refused) => refused.refusal.canTryAgain,
		'server-error': () => true,
		'connection-lost': () => true,
		'follow-up-budget-exhausted': () => false
	})
}

/** Whether a user turn is running: Stop is offered and a new message queues. */
export function isChatTurnBusy(state: ChatTurnState): boolean {
	return typedSwitch(state.kind, {
		...typedSwitchGroup(
			state.kind,
			['requesting', 'streaming', 'continuing', 'stopping'],
			() => true
		),
		...typedSwitchGroup(state.kind, ['idle', 'waiting', 'failed'], () => false)
	})
}

/**
 * Only a message from the user starts anything: a thread loaded from history
 * never continues on its own. Its waiting changes wait for the user, and a
 * request the AI SDK starts by itself is stopped.
 */
function reduceIdle(
	state: Extract<ChatTurnState, { kind: 'idle' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => startUserTurn(message),
		'changes-waiting': (waiting) => waitForUser(newUserTurn(), waiting.changes),
		'approval-sent': () => refuseUnaskedRequest(state),
		'stream-watched': () => watchStream('idle'),
		'regenerate-pressed': () => regenerate(),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'request-finished',
				'error-response',
				'connection-lost',
				'follow-up-ready',
				'stop-pressed',
				'try-again-pressed',
				'resume-pressed',
				'nothing-to-resume'
			],
			() => unchanged(state)
		)
	})
}

function reduceRequesting(
	state: Extract<ChatTurnState, { kind: 'requesting' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	const { userTurn } = state

	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => queueMessage(state, message),
		'content-shown': (): ChatTurnTransition => ({
			state: {
				kind: 'streaming',
				userTurn: { ...userTurn, watching: false }
			},
			effects: NO_EFFECTS
		}),
		'request-finished': (finished) =>
			finishRequest(userTurn, finished.continues),
		'changes-waiting': (waiting) => waitForUser(userTurn, waiting.changes),
		'connection-lost': (lost) => {
			if (userTurn.watching !== false) {
				return stopWatching(userTurn)
			}

			return userTurn.retried
				? failUserTurn(userTurn, { kind: 'connection-lost' })
				: retryRequest(state, lost.resumable)
		},
		'error-response': (response) =>
			userTurn.watching === false
				? failUserTurn(userTurn, failureOf(response))
				: stopWatching(userTurn),
		'nothing-to-resume': () =>
			userTurn.watching === false
				? failUserTurn(userTurn, { kind: 'connection-lost' })
				: stopWatching(userTurn),
		'stop-pressed': () => abortRequest(userTurn),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'follow-up-ready',
				'try-again-pressed',
				'regenerate-pressed',
				'approval-sent',
				'resume-pressed',
				'stream-watched'
			],
			() => unchanged(state)
		)
	})
}

/**
 * As while requesting, except that part of the answer is on screen: a lost
 * connection fails at once unless the stream can be reattached.
 */
function reduceStreaming(
	state: Extract<ChatTurnState, { kind: 'streaming' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	const { userTurn } = state

	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => queueMessage(state, message),
		'request-finished': (finished) =>
			finishRequest(userTurn, finished.continues),
		'changes-waiting': (waiting) => waitForUser(userTurn, waiting.changes),
		'connection-lost': (lost) =>
			lost.resumable && !userTurn.retried
				? retryRequest(state, true)
				: failUserTurn(userTurn, { kind: 'connection-lost' }),
		'nothing-to-resume': () =>
			failUserTurn(userTurn, { kind: 'connection-lost' }),
		'error-response': (response) => failUserTurn(userTurn, failureOf(response)),
		'stop-pressed': () => abortRequest(userTurn),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'follow-up-ready',
				'try-again-pressed',
				'regenerate-pressed',
				'approval-sent',
				'resume-pressed',
				'stream-watched'
			],
			() => unchanged(state)
		)
	})
}

/** Between two requests, while the session carries out client actions. No request is in flight. */
function reduceContinuing(
	state: Extract<ChatTurnState, { kind: 'continuing' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	const { userTurn } = state

	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => queueMessage(state, message),
		'follow-up-ready': () =>
			userTurn.followUps < CHAT_FOLLOW_UP_BUDGET
				? sendFollowUp(userTurn)
				: failUserTurn(userTurn, { kind: 'follow-up-budget-exhausted' }),
		'stop-pressed': () => endUserTurn(userTurn),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'request-finished',
				'error-response',
				'connection-lost',
				'try-again-pressed',
				'regenerate-pressed',
				'changes-waiting',
				'approval-sent',
				'resume-pressed',
				'stream-watched',
				'nothing-to-resume'
			],
			() => unchanged(state)
		)
	})
}

/** Stop was pressed: however the request in flight settles, the user turn ends. */
function reduceStopping(
	state: Extract<ChatTurnState, { kind: 'stopping' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => queueMessage(state, message),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'request-finished',
				'connection-lost',
				'error-response',
				'changes-waiting',
				'nothing-to-resume'
			],
			() => endUserTurn(state.userTurn)
		),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'follow-up-ready',
				'stop-pressed',
				'try-again-pressed',
				'regenerate-pressed',
				'approval-sent',
				'resume-pressed',
				'stream-watched'
			],
			() => unchanged(state)
		)
	})
}

/**
 * The answer waits for the user, with no request in flight. Their answers to
 * the approvals and a resume go on with the same user turn; a message they
 * write goes out at once, because the server declines what waits, and the
 * waiting cards learn that the user moved on.
 */
function reduceWaiting(
	state: Extract<ChatTurnState, { kind: 'waiting' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => moveOn(state.changes, message),
		'approval-sent': () => sendApprovalAnswers(state),
		'resume-pressed': (pressed) => resumeRun(state, pressed.resume),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'request-finished',
				'error-response',
				'connection-lost',
				'follow-up-ready',
				'stop-pressed',
				'try-again-pressed',
				'regenerate-pressed',
				'changes-waiting',
				'stream-watched',
				'nothing-to-resume'
			],
			() => unchanged(state)
		)
	})
}

function reduceFailed(
	state: Extract<ChatTurnState, { kind: 'failed' }>,
	event: ChatTurnEvent
): ChatTurnTransition {
	return typedSwitch(event, 'kind', {
		'message-submitted': (message) => startUserTurn(message),
		'try-again-pressed': () =>
			canTryAgain(state.failure) ? tryAgain(state.resume) : unchanged(state),
		'regenerate-pressed': () => regenerate(),
		'changes-waiting': (waiting) => waitForUser(newUserTurn(), waiting.changes),
		'approval-sent': () => refuseUnaskedRequest(state),
		// Only a dropped connection leaves a run on the server to reattach to.
		'stream-watched': () =>
			state.failure.kind === 'connection-lost'
				? watchStream('failed')
				: unchanged(state),
		...typedSwitchGroup(
			event,
			'kind',
			[
				'content-shown',
				'request-finished',
				'error-response',
				'connection-lost',
				'follow-up-ready',
				'stop-pressed',
				'resume-pressed',
				'nothing-to-resume'
			],
			() => unchanged(state)
		)
	})
}

function isBlank(event: Extract<ChatTurnEvent, { kind: 'message-submitted' }>) {
	return event.text.trim() === '' && (event.files?.length ?? 0) === 0
}

function startUserTurn(
	message: Extract<ChatTurnEvent, { kind: 'message-submitted' }>
): ChatTurnTransition {
	return {
		state: { kind: 'requesting', userTurn: newUserTurn() },
		effects: [
			message.files === undefined || message.files.length === 0
				? { kind: 'send-message', text: message.text.trim() }
				: {
						kind: 'send-message',
						text: message.text.trim(),
						files: message.files
					}
		]
	}
}

/** A new user turn that writes the newest answer again from the user's message. */
function regenerate(): ChatTurnTransition {
	return {
		state: { kind: 'requesting', userTurn: newUserTurn() },
		effects: [{ kind: 'request' }]
	}
}

function watchStream(from: 'idle' | 'failed'): ChatTurnTransition {
	return {
		state: {
			kind: 'requesting',
			userTurn: { ...newUserTurn(), retried: true, watching: from }
		},
		effects: NO_EFFECTS
	}
}

/** A reattach that showed nothing ends where it started, or with the user's queued message. */
function stopWatching(userTurn: ChatUserTurn): ChatTurnTransition {
	return userTurn.watching === 'failed' && userTurn.queued === undefined
		? {
				state: { kind: 'failed', failure: { kind: 'connection-lost' } },
				effects: NO_EFFECTS
			}
		: endUserTurn(userTurn)
}

function tryAgain(resume: RunResume | undefined): ChatTurnTransition {
	const userTurn =
		resume === undefined
			? newUserTurn()
			: { ...newUserTurn(), resume, resumedRunIds: [resume.runId] }

	return {
		state: { kind: 'requesting', userTurn },
		effects: [requestEffectOf(userTurn)]
	}
}

function newUserTurn(): ChatUserTurn {
	return {
		queued: undefined,
		retried: false,
		followUps: 0,
		answering: [],
		resumedRunIds: [],
		resume: undefined,
		watching: false
	}
}

/**
 * A message typed mid-turn waits for the user turn to end; a second one joins
 * it, so one message goes out. Files cannot wait: such a message is refused
 * and stays in the composer.
 */
function queueMessage(
	state: UserTurnState,
	message: Extract<ChatTurnEvent, { kind: 'message-submitted' }>
): ChatTurnTransition {
	if ((message.files?.length ?? 0) > 0) {
		return unchanged(state)
	}

	const { queued } = state.userTurn
	const trimmed = message.text.trim()

	return {
		state: {
			...state,
			userTurn: {
				...state.userTurn,
				queued: queued === undefined ? trimmed : `${queued}\n\n${trimmed}`
			}
		},
		effects: NO_EFFECTS
	}
}

function finishRequest(
	userTurn: ChatUserTurn,
	continues: boolean
): ChatTurnTransition {
	return continues
		? {
				state: {
					kind: 'continuing',
					userTurn: {
						...userTurn,
						answering: [],
						resume: undefined,
						watching: false
					}
				},
				effects: NO_EFFECTS
			}
		: endUserTurn(userTurn)
}

/** The request ended with changes waiting; a message the user wrote meanwhile goes out now, and the server declines them. */
function waitForUser(
	userTurn: ChatUserTurn,
	changes: readonly PendingChange[]
): ChatTurnTransition {
	if (userTurn.queued !== undefined) {
		return moveOn(changes, { kind: 'message-submitted', text: userTurn.queued })
	}

	return {
		state: {
			kind: 'waiting',
			userTurn: {
				...userTurn,
				answering: [],
				resume: undefined,
				watching: false
			},
			changes
		},
		effects: NO_EFFECTS
	}
}

/** The user wrote instead of answering: the message starts a new user turn, and the waiting cards say the user moved on. */
function moveOn(
	changes: readonly PendingChange[],
	message: Extract<ChatTurnEvent, { kind: 'message-submitted' }>
): ChatTurnTransition {
	const next = startUserTurn(message)

	return {
		state: next.state,
		effects: [...next.effects, ...markChanges('movedOn', changes)]
	}
}

/** The AI SDK sends the answers on its own; the reducer counts the request, and stops it past the budget. */
function sendApprovalAnswers(
	state: Extract<ChatTurnState, { kind: 'waiting' }>
): ChatTurnTransition {
	const { userTurn } = state

	if (userTurn.followUps >= CHAT_FOLLOW_UP_BUDGET) {
		const failed = failUserTurn(userTurn, {
			kind: 'follow-up-budget-exhausted'
		})

		return {
			state: failed.state,
			effects: [{ kind: 'abort-request' }, ...failed.effects]
		}
	}

	return {
		state: {
			kind: 'requesting',
			userTurn: {
				...userTurn,
				followUps: userTurn.followUps + 1,
				answering: state.changes.filter((change) => change.kind === 'approval')
			}
		},
		effects: NO_EFFECTS
	}
}

/** A resume goes out once per suspended run, for a run that waits, within the budget. */
function resumeRun(
	state: Extract<ChatTurnState, { kind: 'waiting' }>,
	resume: RunResume
): ChatTurnTransition {
	const { userTurn } = state
	const run = state.changes.find(
		(change) => change.kind === 'suspended' && change.runId === resume.runId
	)

	if (run === undefined || userTurn.resumedRunIds.includes(resume.runId)) {
		return unchanged(state)
	}

	if (userTurn.followUps >= CHAT_FOLLOW_UP_BUDGET) {
		return failUserTurn(userTurn, { kind: 'follow-up-budget-exhausted' })
	}

	return {
		state: {
			kind: 'requesting',
			userTurn: {
				...userTurn,
				followUps: userTurn.followUps + 1,
				answering: [run],
				resumedRunIds: [...userTurn.resumedRunIds, resume.runId],
				resume
			}
		},
		effects: [{ kind: 'resume-run', resume }]
	}
}

/** A request nobody asked for, such as the AI SDK answering approvals of a thread loaded from history. */
function refuseUnaskedRequest(state: ChatTurnState): ChatTurnTransition {
	return { state, effects: [{ kind: 'abort-request' }] }
}

function markChanges(
	mark: ChangeMark,
	changes: readonly PendingChange[]
): readonly ChatTurnEffect[] {
	return changes.length === 0
		? NO_EFFECTS
		: [{ kind: 'mark-changes', mark, changes }]
}

/**
 * The one automatic retry: the stream reattached when the server keeps the
 * run going, the request sent again otherwise.
 */
function retryRequest(
	state: UserTurnState,
	resumable: boolean
): ChatTurnTransition {
	return {
		state: { ...state, userTurn: { ...state.userTurn, retried: true } },
		effects: [
			resumable ? { kind: 'resume-stream' } : requestEffectOf(state.userTurn)
		]
	} as ChatTurnTransition
}

/** The request again: with its resume when it sent one, so the suspended run still resumes. */
function requestEffectOf(userTurn: ChatUserTurn): ChatTurnEffect {
	return userTurn.resume === undefined
		? { kind: 'request' }
		: { kind: 'resume-run', resume: userTurn.resume }
}

function sendFollowUp(userTurn: ChatUserTurn): ChatTurnTransition {
	return {
		state: {
			kind: 'requesting',
			userTurn: { ...userTurn, followUps: userTurn.followUps + 1 }
		},
		effects: [{ kind: 'request' }]
	}
}

function abortRequest(userTurn: ChatUserTurn): ChatTurnTransition {
	return {
		state: { kind: 'stopping', userTurn },
		effects: [{ kind: 'abort-request' }]
	}
}

/** The user turn ended answered or stopped: a queued message goes out as the next user turn. */
function endUserTurn(userTurn: ChatUserTurn): ChatTurnTransition {
	return userTurn.queued === undefined
		? { state: initialChatTurnState, effects: NO_EFFECTS }
		: startUserTurn({ kind: 'message-submitted', text: userTurn.queued })
}

/**
 * Nothing goes out behind a failure: a queued message goes back to the
 * composer. An expired refusal marks what the request answered expired.
 */
function failUserTurn(
	userTurn: ChatUserTurn,
	failure: ChatTurnFailure
): ChatTurnTransition {
	const isExpired =
		failure.kind === 'refused' && failure.refusal.expired === true
	const draft: readonly ChatTurnEffect[] =
		userTurn.queued === undefined
			? NO_EFFECTS
			: [{ kind: 'restore-draft', text: userTurn.queued }]
	const canResendResume = userTurn.resume !== undefined && !isExpired

	return {
		state: canResendResume
			? { kind: 'failed', failure, resume: userTurn.resume }
			: { kind: 'failed', failure },
		effects: isExpired
			? [...draft, ...markChanges('expired', userTurn.answering)]
			: draft
	}
}

function failureOf(
	event: Extract<ChatTurnEvent, { kind: 'error-response' }>
): ChatTurnFailure {
	return event.refusal === undefined
		? { kind: 'server-error', status: event.status }
		: { kind: 'refused', refusal: event.refusal }
}

function unchanged(state: ChatTurnState): ChatTurnTransition {
	return { state, effects: NO_EFFECTS }
}
