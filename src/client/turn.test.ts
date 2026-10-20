import { describe, expect, test } from 'bun:test'

import type { PendingChange } from './pending'
import {
	CHAT_FOLLOW_UP_BUDGET,
	type ChatTurnEvent,
	type ChatTurnState,
	type ChatUserTurn,
	canTryAgain,
	initialChatTurnState,
	reduceChatTurn
} from './turn'

const NEW_USER_TURN: ChatUserTurn = {
	queued: undefined,
	retried: false,
	followUps: 0,
	answering: [],
	resumedRunIds: [],
	resume: undefined,
	watching: false
}

const WAITING_APPROVAL: PendingChange = {
	kind: 'approval',
	runId: 'run-1',
	toolCallId: 'call-1',
	toolName: 'updateGoal',
	approvalId: 'run-1::call-1'
}

const WAITING_RUN: PendingChange = {
	kind: 'suspended',
	runId: 'run-2',
	toolCallId: 'call-2',
	toolName: 'proposeChangePlan',
	payload: { changes: [] }
}

const WAITING: ChatTurnState = {
	kind: 'waiting',
	userTurn: NEW_USER_TURN,
	changes: [WAITING_APPROVAL, WAITING_RUN]
}

const REFUSED_IN_PROGRESS = { code: 'turn_in_progress', canTryAgain: true }

const ALL_EVENTS: readonly ChatTurnEvent[] = [
	{ kind: 'message-submitted', text: 'Hvad har jeg brugt på mad?' },
	{ kind: 'content-shown' },
	{ kind: 'request-finished', continues: false },
	{ kind: 'request-finished', continues: true },
	{ kind: 'error-response', status: 409, refusal: REFUSED_IN_PROGRESS },
	{ kind: 'connection-lost', resumable: false },
	{ kind: 'connection-lost', resumable: true },
	{ kind: 'follow-up-ready' },
	{ kind: 'stop-pressed' },
	{ kind: 'try-again-pressed' },
	{ kind: 'changes-waiting', changes: [WAITING_APPROVAL] },
	{ kind: 'approval-sent' },
	{ kind: 'resume-pressed', resume: { runId: 'run-2', data: { ticked: [] } } },
	{ kind: 'stream-watched' },
	{ kind: 'nothing-to-resume' }
]

const ALL_STATES: readonly ChatTurnState[] = [
	initialChatTurnState,
	{ kind: 'requesting', userTurn: NEW_USER_TURN },
	{ kind: 'streaming', userTurn: { ...NEW_USER_TURN, queued: 'Og i maj?' } },
	{ kind: 'continuing', userTurn: { ...NEW_USER_TURN, followUps: 2 } },
	{ kind: 'stopping', userTurn: { ...NEW_USER_TURN, retried: true } },
	WAITING,
	{ kind: 'failed', failure: { kind: 'connection-lost' } }
]

function replay(state: ChatTurnState, events: readonly ChatTurnEvent[]) {
	return events.reduce(
		(current, event) => {
			const next = reduceChatTurn(current.state, event)

			return {
				state: next.state,
				effects: [...current.effects, ...next.effects]
			}
		},
		{ state, effects: [] as unknown[] }
	)
}

describe('reduceChatTurn', () => {
	test('starts a user turn with the trimmed message and ignores blank text in every state', () => {
		expect(
			reduceChatTurn(initialChatTurnState, {
				kind: 'message-submitted',
				text: '  Hej  '
			})
		).toEqual({
			state: { kind: 'requesting', userTurn: NEW_USER_TURN },
			effects: [{ kind: 'send-message', text: 'Hej' }]
		})

		for (const state of ALL_STATES) {
			const blank = reduceChatTurn(state, {
				kind: 'message-submitted',
				text: ' \n '
			})

			expect(blank.state).toBe(state)
			expect(blank.effects).toEqual([])
		}
	})

	test.each<[string, ChatTurnEvent]>([
		['finishes', { kind: 'request-finished', continues: false }],
		['loses its connection', { kind: 'connection-lost', resumable: false }],
		[
			'returns an error',
			{ kind: 'error-response', status: 500, refusal: undefined }
		]
	])(
		'aborts on Stop and ends the user turn when the request %s',
		(_case, settled) => {
			const streaming: ChatTurnState = {
				kind: 'streaming',
				userTurn: NEW_USER_TURN
			}
			const stopped = reduceChatTurn(streaming, { kind: 'stop-pressed' })

			expect(stopped).toEqual({
				state: { kind: 'stopping', userTurn: NEW_USER_TURN },
				effects: [{ kind: 'abort-request' }]
			})
			expect(reduceChatTurn(stopped.state, settled)).toEqual({
				state: { kind: 'idle' },
				effects: []
			})
		}
	)

	test('ends the user turn at once on Stop between two requests, without aborting', () => {
		const continuing: ChatTurnState = {
			kind: 'continuing',
			userTurn: { ...NEW_USER_TURN, followUps: 1 }
		}

		expect(reduceChatTurn(continuing, { kind: 'stop-pressed' })).toEqual({
			state: { kind: 'idle' },
			effects: []
		})
	})

	test('queues messages typed mid-turn as one and sends them as the next user turn', () => {
		const { state: queued, effects } = replay(
			{ kind: 'requesting', userTurn: NEW_USER_TURN },
			[
				{ kind: 'message-submitted', text: 'Og i maj?' },
				{ kind: 'content-shown' },
				{ kind: 'message-submitted', text: 'Og i juni?' }
			]
		)

		expect(effects).toEqual([])
		expect(queued).toEqual({
			kind: 'streaming',
			userTurn: expect.objectContaining({ queued: 'Og i maj?\n\nOg i juni?' })
		})
		expect(
			reduceChatTurn(queued, { kind: 'request-finished', continues: false })
		).toEqual({
			state: { kind: 'requesting', userTurn: NEW_USER_TURN },
			effects: [{ kind: 'send-message', text: 'Og i maj?\n\nOg i juni?' }]
		})
	})

	test('refuses to queue a message with files, so the composer keeps them', () => {
		const streaming: ChatTurnState = {
			kind: 'streaming',
			userTurn: NEW_USER_TURN
		}
		const file = {
			type: 'file' as const,
			mediaType: 'image/png',
			url: 'data:,'
		}
		const sent = reduceChatTurn(streaming, {
			kind: 'message-submitted',
			text: 'Se her',
			files: [file]
		})

		expect(sent.state).toBe(streaming)
		expect(
			reduceChatTurn(initialChatTurnState, {
				kind: 'message-submitted',
				text: '',
				files: [file]
			}).effects
		).toEqual([{ kind: 'send-message', text: '', files: [file] }])
	})

	test('puts a queued message back into the composer when the user turn fails', () => {
		const streaming: ChatTurnState = {
			kind: 'streaming',
			userTurn: { ...NEW_USER_TURN, queued: 'Og i maj?' }
		}

		expect(
			reduceChatTurn(streaming, {
				kind: 'error-response',
				status: 503,
				refusal: { code: 'temporarily_unavailable', canTryAgain: true }
			})
		).toEqual({
			state: {
				kind: 'failed',
				failure: {
					kind: 'refused',
					refusal: { code: 'temporarily_unavailable', canTryAgain: true }
				}
			},
			effects: [{ kind: 'restore-draft', text: 'Og i maj?' }]
		})
	})

	test('retries a connection lost before anything was shown once, and fails on the second loss', () => {
		const requesting: ChatTurnState = {
			kind: 'requesting',
			userTurn: NEW_USER_TURN
		}
		const retried = reduceChatTurn(requesting, {
			kind: 'connection-lost',
			resumable: false
		})

		expect(retried).toEqual({
			state: {
				kind: 'requesting',
				userTurn: { ...NEW_USER_TURN, retried: true }
			},
			effects: [{ kind: 'request' }]
		})
		expect(
			reduceChatTurn(retried.state, {
				kind: 'connection-lost',
				resumable: false
			})
		).toEqual({
			state: { kind: 'failed', failure: { kind: 'connection-lost' } },
			effects: []
		})
	})

	test('fails at once when the connection is lost after part of the answer was shown', () => {
		expect(
			reduceChatTurn(
				{ kind: 'streaming', userTurn: NEW_USER_TURN },
				{ kind: 'connection-lost', resumable: false }
			)
		).toEqual({
			state: { kind: 'failed', failure: { kind: 'connection-lost' } },
			effects: []
		})
	})

	test('reattaches a dropped stream once instead of failing when the server keeps the run going', () => {
		const streaming: ChatTurnState = {
			kind: 'streaming',
			userTurn: NEW_USER_TURN
		}
		const reattached = reduceChatTurn(streaming, {
			kind: 'connection-lost',
			resumable: true
		})

		expect(reattached).toEqual({
			state: {
				kind: 'streaming',
				userTurn: { ...NEW_USER_TURN, retried: true }
			},
			effects: [{ kind: 'resume-stream' }]
		})
		expect(
			reduceChatTurn(reattached.state, { kind: 'nothing-to-resume' }).state
		).toEqual({
			kind: 'failed',
			failure: { kind: 'connection-lost' }
		})
		expect(
			reduceChatTurn(reattached.state, {
				kind: 'connection-lost',
				resumable: true
			}).state
		).toEqual({ kind: 'failed', failure: { kind: 'connection-lost' } })
		expect(
			reduceChatTurn(
				{ kind: 'requesting', userTurn: NEW_USER_TURN },
				{ kind: 'connection-lost', resumable: true }
			).effects
		).toEqual([{ kind: 'resume-stream' }])
	})

	test('watches a running answer from idle and ends quietly when there is nothing to show', () => {
		const watching = reduceChatTurn(initialChatTurnState, {
			kind: 'stream-watched'
		})

		expect(watching).toEqual({
			state: {
				kind: 'requesting',
				userTurn: { ...NEW_USER_TURN, retried: true, watching: 'idle' }
			},
			effects: []
		})

		for (const event of [
			{ kind: 'nothing-to-resume' },
			{ kind: 'connection-lost', resumable: true },
			{ kind: 'error-response', status: 500, refusal: undefined }
		] satisfies ChatTurnEvent[]) {
			expect(reduceChatTurn(watching.state, event)).toEqual({
				state: { kind: 'idle' },
				effects: []
			})
		}

		const shown = reduceChatTurn(watching.state, { kind: 'content-shown' })

		expect(shown.state).toEqual({
			kind: 'streaming',
			userTurn: { ...NEW_USER_TURN, retried: true, watching: false }
		})
		expect(
			reduceChatTurn(shown.state, { kind: 'connection-lost', resumable: true })
				.state
		).toEqual({ kind: 'failed', failure: { kind: 'connection-lost' } })
	})

	test('watches again after a lost connection and keeps the failure when nothing runs', () => {
		const failed: ChatTurnState = {
			kind: 'failed',
			failure: { kind: 'connection-lost' }
		}
		const watching = reduceChatTurn(failed, { kind: 'stream-watched' })

		expect(watching.state.kind).toBe('requesting')
		expect(
			reduceChatTurn(watching.state, { kind: 'nothing-to-resume' }).state
		).toEqual(failed)

		const refused: ChatTurnState = {
			kind: 'failed',
			failure: { kind: 'refused', refusal: REFUSED_IN_PROGRESS }
		}

		expect(reduceChatTurn(refused, { kind: 'stream-watched' }).state).toBe(
			refused
		)
	})

	test('keeps the user turn running after client actions and sends the follow-up when ready', () => {
		const { state, effects } = replay(
			{ kind: 'streaming', userTurn: NEW_USER_TURN },
			[
				{ kind: 'request-finished', continues: true },
				{ kind: 'follow-up-ready' }
			]
		)

		expect(state).toEqual({
			kind: 'requesting',
			userTurn: { ...NEW_USER_TURN, followUps: 1 }
		})
		expect(effects).toEqual([{ kind: 'request' }])
	})

	test('fails and sends nothing when a follow-up goes past the budget', () => {
		const continuing: ChatTurnState = {
			kind: 'continuing',
			userTurn: {
				...NEW_USER_TURN,
				followUps: CHAT_FOLLOW_UP_BUDGET,
				queued: 'Hej'
			}
		}

		expect(reduceChatTurn(continuing, { kind: 'follow-up-ready' })).toEqual({
			state: {
				kind: 'failed',
				failure: { kind: 'follow-up-budget-exhausted' }
			},
			effects: [{ kind: 'restore-draft', text: 'Hej' }]
		})
	})

	test('offers Try again by the refusal, and starts over on it', () => {
		const failed = (canTry: boolean): ChatTurnState => ({
			kind: 'failed',
			failure: { kind: 'refused', refusal: { code: 'x', canTryAgain: canTry } }
		})

		expect(reduceChatTurn(failed(true), { kind: 'try-again-pressed' })).toEqual(
			{
				state: { kind: 'requesting', userTurn: NEW_USER_TURN },
				effects: [{ kind: 'request' }]
			}
		)
		expect(
			reduceChatTurn(failed(false), { kind: 'try-again-pressed' }).effects
		).toEqual([])
		expect(canTryAgain({ kind: 'connection-lost' })).toBe(true)
		expect(canTryAgain({ kind: 'server-error', status: 502 })).toBe(true)
		expect(canTryAgain({ kind: 'follow-up-budget-exhausted' })).toBe(false)
	})

	test('never continues a thread loaded from history on its own', () => {
		const waiting = reduceChatTurn(initialChatTurnState, {
			kind: 'changes-waiting',
			changes: [WAITING_APPROVAL]
		})

		expect(waiting.state).toEqual({
			kind: 'waiting',
			userTurn: NEW_USER_TURN,
			changes: [WAITING_APPROVAL]
		})
		expect(waiting.effects).toEqual([])
		expect(
			reduceChatTurn(initialChatTurnState, { kind: 'approval-sent' })
		).toEqual({
			state: initialChatTurnState,
			effects: [{ kind: 'abort-request' }]
		})
	})

	test('sends a message written while changes wait at once and marks them moved on', () => {
		expect(
			reduceChatTurn(WAITING, { kind: 'message-submitted', text: 'Nej tak' })
		).toEqual({
			state: { kind: 'requesting', userTurn: NEW_USER_TURN },
			effects: [
				{ kind: 'send-message', text: 'Nej tak' },
				{
					kind: 'mark-changes',
					mark: 'movedOn',
					changes: [WAITING_APPROVAL, WAITING_RUN]
				}
			]
		})
	})

	test('goes on with the same user turn when the approvals are answered, within the budget', () => {
		expect(reduceChatTurn(WAITING, { kind: 'approval-sent' })).toEqual({
			state: {
				kind: 'requesting',
				userTurn: {
					...NEW_USER_TURN,
					followUps: 1,
					answering: [WAITING_APPROVAL]
				}
			},
			effects: []
		})

		const spent: ChatTurnState = {
			...WAITING,
			userTurn: { ...NEW_USER_TURN, followUps: CHAT_FOLLOW_UP_BUDGET }
		}

		expect(reduceChatTurn(spent, { kind: 'approval-sent' })).toEqual({
			state: {
				kind: 'failed',
				failure: { kind: 'follow-up-budget-exhausted' }
			},
			effects: [{ kind: 'abort-request' }]
		})
	})

	test('resumes a waiting run once, and sends the resume again on retry and Try again', () => {
		const resume = { runId: 'run-2', data: { ticked: ['a'] } }
		const resumed = reduceChatTurn(WAITING, { kind: 'resume-pressed', resume })

		expect(resumed).toEqual({
			state: {
				kind: 'requesting',
				userTurn: {
					...NEW_USER_TURN,
					followUps: 1,
					answering: [WAITING_RUN],
					resumedRunIds: ['run-2'],
					resume
				}
			},
			effects: [{ kind: 'resume-run', resume }]
		})
		expect(
			reduceChatTurn(WAITING, {
				kind: 'resume-pressed',
				resume: { runId: 'run-9', data: 1 }
			}).state
		).toBe(WAITING)

		const retried = reduceChatTurn(resumed.state, {
			kind: 'connection-lost',
			resumable: false
		})

		expect(retried.effects).toEqual([{ kind: 'resume-run', resume }])

		const failed = reduceChatTurn(retried.state, {
			kind: 'connection-lost',
			resumable: false
		})

		expect(failed.state).toEqual({
			kind: 'failed',
			failure: { kind: 'connection-lost' },
			resume
		})
		expect(
			reduceChatTurn(failed.state, { kind: 'try-again-pressed' }).effects
		).toEqual([{ kind: 'resume-run', resume }])
	})

	test('ends the user turn and marks what it answered expired when the change no longer waits', () => {
		const answering: ChatTurnState = {
			kind: 'requesting',
			userTurn: { ...NEW_USER_TURN, answering: [WAITING_APPROVAL] }
		}

		expect(
			reduceChatTurn(answering, {
				kind: 'error-response',
				status: 409,
				refusal: { code: 'change_expired', canTryAgain: false, expired: true }
			})
		).toEqual({
			state: {
				kind: 'failed',
				failure: {
					kind: 'refused',
					refusal: { code: 'change_expired', canTryAgain: false, expired: true }
				}
			},
			effects: [
				{ kind: 'mark-changes', mark: 'expired', changes: [WAITING_APPROVAL] }
			]
		})
	})

	test('never changes the given state object', () => {
		for (const state of ALL_STATES) {
			const frozen = structuredClone(state)

			for (const event of ALL_EVENTS) {
				const next = reduceChatTurn(state, event)

				if (next.effects.length === 0 && next.state !== state) {
					expect(next.state).not.toBe(state)
				}

				expect(state).toEqual(frozen)
			}
		}
	})
})
