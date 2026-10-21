import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'

import {
	findStrandedToolCalls,
	isShowingProgress,
	isToolResultPart,
	isUserFacingPart,
	mergeThreadMessages,
	readReplySuggestions,
	selectRequestMessages,
	toMessageBlocks
} from './messages'
import {
	expiredChanges,
	type PendingChange,
	readWaitingChanges,
	rebuildPendingApprovals
} from './pending'

const user = (id: string, text = id): UIMessage => ({
	id,
	role: 'user',
	parts: [{ type: 'text', text }]
})

const assistant = (id: string, parts: UIMessage['parts']): UIMessage => ({
	id,
	role: 'assistant',
	parts
})

const tool = (
	toolCallId: string,
	state:
		| 'input-available'
		| 'output-available'
		| 'output-error'
		| 'approval-requested'
		| 'approval-responded',
	toolName = 'openScreen'
): UIMessage['parts'][number] =>
	({
		type: 'dynamic-tool',
		toolName,
		toolCallId,
		state,
		input: {},
		...(state === 'output-available' ? { output: {} } : {}),
		...(state === 'output-error' ? { errorText: 'x' } : {}),
		...(state.startsWith('approval')
			? { approval: { id: `run-1::${toolCallId}`, approved: true } }
			: {})
	}) as UIMessage['parts'][number]

const suspended = (
	toolCallId: string,
	extra: Record<string, unknown> = {}
): UIMessage['parts'][number] =>
	({
		type: 'data-tool-call-suspended',
		id: toolCallId,
		data: {
			runId: 'run-2',
			toolCallId,
			toolName: 'proposeChangePlan',
			suspendPayload: { n: 1 },
			...extra
		}
	}) as UIMessage['parts'][number]

const isClientResult = (part: { toolCallId: string }) =>
	part.toolCallId.startsWith('client')

describe('selectRequestMessages', () => {
	const earlier = [
		user('u0'),
		assistant('a0', [{ type: 'text', text: 'Svar' }])
	]

	test('sends only the new user message for a new user turn', () => {
		expect(selectRequestMessages([...earlier, user('u1')])).toEqual([
			user('u1')
		])
	})

	test('sends the current user turn when the answer carries the client results', () => {
		const answer = assistant('a1', [tool('client-1', 'output-available')])

		expect(
			selectRequestMessages([...earlier, user('u1'), answer], {
				isClientResult
			})
		).toEqual([user('u1'), answer])
		expect(selectRequestMessages([...earlier, user('u1'), answer])).toEqual([
			user('u1')
		])
	})

	test('sends the current user turn with approval answers', () => {
		const answer = assistant('a1', [tool('call-1', 'approval-responded')])

		expect(selectRequestMessages([user('u1'), answer])).toEqual([
			user('u1'),
			answer
		])
	})

	test('sends the waiting answer alone to resume its suspended run', () => {
		const answer = assistant('a1', [
			tool('call-2', 'input-available'),
			suspended('call-2')
		])

		expect(selectRequestMessages([...earlier, user('u1'), answer])).toEqual([
			answer
		])
	})
})

describe('mergeThreadMessages', () => {
	test('shows a message in both once, as the live copy, after the stored ones', () => {
		const live = [user('u2'), assistant('a2', [{ type: 'text', text: 'Ny' }])]

		expect(
			mergeThreadMessages([user('u1'), user('u2', 'gammel')], live)
		).toEqual([user('u1'), ...live])
	})

	test('joins an answer resumed after a client result into one answer', () => {
		const first = assistant('a1', [tool('client-1', 'output-available')])
		const second = assistant('a2', [{ type: 'text', text: 'Der er du.' }])

		expect(mergeThreadMessages([user('u1'), first, second], [])).toEqual([
			user('u1'),
			{ ...first, parts: [...first.parts, ...second.parts] }
		])
	})

	test('joins only after the parts isResumePoint names', () => {
		const screen = assistant('a1', [tool('screen-1', 'output-available')])
		const resumed = assistant('a2', [{ type: 'text', text: 'Der er du.' }])
		const lookup = assistant('a3', [tool('server-1', 'output-available')])
		const heartbeat = assistant('a4', [{ type: 'text', text: 'Hej igen.' }])
		const isScreenAction = (part: UIMessage['parts'][number]) =>
			isToolResultPart(part) &&
			'toolCallId' in part &&
			part.toolCallId.startsWith('screen-')

		expect(
			mergeThreadMessages(
				[user('u1'), screen],
				[resumed, user('u2'), lookup, heartbeat],
				{ isResumePoint: isScreenAction }
			)
		).toEqual([
			user('u1'),
			{ ...screen, parts: [...screen.parts, ...resumed.parts] },
			user('u2'),
			lookup,
			heartbeat
		])
	})
})

describe('findStrandedToolCalls', () => {
	test('finds server calls left without a result, not client, suspended or provider calls', () => {
		const message = assistant('a1', [
			tool('server-1', 'input-available', 'listGoals'),
			tool('client-1', 'input-available', 'openScreen'),
			tool('server-2', 'input-available', 'proposeChangePlan'),
			suspended('server-2'),
			{
				...tool('server-3', 'input-available', 'webSearch'),
				providerExecuted: true
			} as UIMessage['parts'][number],
			tool('server-4', 'output-available', 'listGoals')
		])

		expect(
			findStrandedToolCalls(message, (name) => name === 'openScreen')
		).toEqual([{ toolCallId: 'server-1', toolName: 'listGoals' }])
	})
})

describe('isShowingProgress', () => {
	test('is true for answer text and a running tool, false after a finished tool or a new step', () => {
		expect(
			isShowingProgress([assistant('a', [{ type: 'text', text: 'Hej' }])])
		).toBe(true)
		expect(
			isShowingProgress([assistant('a', [tool('c', 'input-available')])])
		).toBe(true)
		expect(
			isShowingProgress([assistant('a', [tool('c', 'output-available')])])
		).toBe(false)
		expect(
			isShowingProgress([
				assistant('a', [{ type: 'text', text: 'Hej' }, { type: 'step-start' }])
			])
		).toBe(false)
		expect(isShowingProgress([user('u')])).toBe(false)
	})
})

describe('toMessageBlocks', () => {
	test('draws texts and runs of tool parts, skipping blank text and memory parts', () => {
		const message = assistant('a', [
			{ type: 'text', text: 'Først' },
			tool('c1', 'output-available'),
			{ type: 'data-om-observation', data: {} } as UIMessage['parts'][number],
			tool('c2', 'output-available'),
			{ type: 'text', text: '  ' },
			{ type: 'text', text: 'Sidst', state: 'streaming' }
		])

		expect(
			toMessageBlocks(message).map((block) =>
				block.kind === 'text' ? block.text : block.parts.length
			)
		).toEqual(['Først', 2, 'Sidst'])
		expect(isUserFacingPart({ type: 'data-om-status' })).toBe(false)
	})
})

describe('readReplySuggestions', () => {
	test('keeps at most three distinct, short, non-blank replies', () => {
		expect(
			readReplySuggestions({
				suggestions: [
					' Ja ',
					'ja',
					'',
					'x'.repeat(81),
					'Nej',
					'Måske',
					'Fire',
					4
				]
			})
		).toEqual(['Ja', 'Nej', 'Måske'])
		expect(readReplySuggestions({ other: true })).toBeUndefined()
	})
})

describe('pending changes', () => {
	const approval: PendingChange = {
		kind: 'approval',
		runId: 'run-1',
		toolCallId: 'call-1',
		toolName: 'updateGoal',
		approvalId: 'run-1::call-1'
	}
	const run: PendingChange = {
		kind: 'suspended',
		runId: 'run-2',
		toolCallId: 'call-2',
		toolName: 'proposeChangePlan',
		payload: { n: 1 }
	}

	test('reads the approvals and suspended runs a message leaves waiting', () => {
		const message = assistant('a', [
			tool('call-1', 'approval-requested', 'updateGoal'),
			tool('call-2', 'input-available', 'proposeChangePlan'),
			suspended('call-2'),
			suspended('call-3', { resumed: true })
		])

		expect(readWaitingChanges(message)).toEqual([
			{ ...approval, input: {} },
			run
		])
	})

	test("puts a stored thread's pending changes back as the live stream showed them", () => {
		const stored = [
			user('u1'),
			assistant('a1', [
				tool('call-1', 'input-available', 'updateGoal'),
				tool('call-2', 'input-available', 'proposeChangePlan'),
				suspended('call-2'),
				tool('call-9', 'input-available', 'updateGoal')
			])
		]
		const rebuilt = rebuildPendingApprovals(stored, [approval, run])

		expect(readWaitingChanges(rebuilt[1] as UIMessage)).toEqual([
			{ ...approval, input: {} },
			run
		])
		expect(expiredChanges(stored, [approval, run])).toEqual(
			new Map([['call-9', 'expired']])
		)
	})
})
