import { describe, expect, spyOn, test } from 'bun:test'
import type { MastraDBMessage } from '@mastra/core/memory'
import { getToolName, isToolUIPart } from 'ai'

import { createThreadHandlers, sweepOldThreads } from './threads.js'
import {
	createHarness,
	DELETE_TOOL,
	LOOKUP_TOOL,
	readTurn,
	SCOPE,
	type Scope,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'

function handlersFor(harness: ReturnType<typeof createHarness>) {
	return createThreadHandlers<Scope>({
		memory: harness.memory,
		resourceId: (scope) => `${scope.organizationId}:${scope.userId}`,
		userId: (scope) => scope.userId,
		agent: harness.mastra.getAgentById('chat')
	})
}

const STRANGER: Scope = { userId: 'user-2', organizationId: 'org-1' }

describe('createThreadHandlers', () => {
	test("should list and read the caller's thread, and nobody else's", async () => {
		// Given one answered turn
		const harness = createHarness({ replies: [textReply('Hej!')] })
		await readTurn(
			await harness.run({ messages: [userMessage('Hej med dig')] })
		)
		const threads = handlersFor(harness)
		const { threadId } = harness.threadKey

		// When the caller and a stranger read it
		const listed = await threads.list(SCOPE, { page: 0, perPage: 20 })
		const page = await threads.get(SCOPE, { threadId })
		const strangers = await threads.get(STRANGER, { threadId })

		// Then the caller sees both messages and the stranger nothing
		expect(listed.threads.map((thread) => thread.title)).toEqual([
			'Hej med dig'
		])
		expect(page?.messages.map((message) => message.role)).toEqual([
			'user',
			'assistant'
		])
		expect(page?.hasOlder).toBe(false)
		expect(strangers).toBeUndefined()
		expect(
			await threads.list(STRANGER, { page: 0, perPage: 20 })
		).toMatchObject({
			threads: []
		})
	})

	test('should join an answer resumed after a tool result, or only after the parts isResumePoint names', async () => {
		// Given a stored answer that ends in a tool's result and its continuation
		const harness = createHarness({ replies: [] })
		const { threadId, resourceId } = harness.threadKey
		await harness.memory.createThread({ threadId, resourceId, title: 'Hej' })
		const at = (second: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, second))
		const message = (
			id: string,
			role: 'user' | 'assistant',
			second: number,
			parts: MastraDBMessage['content']['parts']
		): MastraDBMessage => ({
			id,
			role,
			threadId,
			resourceId,
			createdAt: at(second),
			content: { format: 2, parts }
		})
		await harness.memory.saveMessages({
			messages: [
				message('u1', 'user', 0, [{ type: 'text', text: 'Hvad brugte jeg?' }]),
				message('a1', 'assistant', 1, [
					{
						type: 'tool-invocation',
						toolInvocation: {
							state: 'result',
							toolCallId: 'call-1',
							toolName: LOOKUP_TOOL,
							args: {},
							result: { total: 1200 }
						}
					}
				]),
				message('a2', 'assistant', 2, [{ type: 'text', text: '1.200 kr.' }])
			]
		})

		// When it is read with the default and with a predicate that skips that tool
		const joined = await handlersFor(harness).get(SCOPE, { threadId })
		const apart = await createThreadHandlers<Scope>({
			memory: harness.memory,
			resourceId: (scope) => `${scope.organizationId}:${scope.userId}`,
			userId: (scope) => scope.userId,
			isResumePoint: (part) =>
				isToolUIPart(part) && getToolName(part) === 'openScreen'
		}).get(SCOPE, { threadId })

		// Then the default joins the two answers under the first id, the predicate keeps them apart
		expect(joined?.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
		expect(joined?.messages[1]?.parts.at(-1)).toEqual(
			expect.objectContaining({ type: 'text', text: '1.200 kr.' })
		)
		expect(apart?.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
	})

	test('should page older messages with the cursor', async () => {
		// Given two turns
		const harness = createHarness({ replies: [textReply('Svar')] })
		const first = userMessage('Første')
		const firstTurn = await readTurn(await harness.run({ messages: [first] }))
		await readTurn(
			await harness.run({
				messages: [first, firstTurn.message!, userMessage('Anden')]
			})
		)
		const threads = handlersFor(harness)
		const { threadId } = harness.threadKey

		// When reading two messages at a time
		const newest = await threads.get(SCOPE, { threadId, limit: 2 })
		const older = await threads.get(SCOPE, {
			threadId,
			limit: 2,
			...(newest?.nextCursor && { cursor: newest.nextCursor })
		})

		// Then the pages hold the newest turn, then the first
		expect(newest?.hasOlder).toBe(true)
		expect(older?.hasOlder).toBe(false)
		expect(
			[...(older?.messages ?? []), ...(newest?.messages ?? [])].map(
				(message) => message.role
			)
		).toEqual(['user', 'assistant', 'user', 'assistant'])
	})

	test('should show the approval waiting in the thread', async () => {
		const harness = createHarness({
			replies: [toolCallReply(DELETE_TOOL, { budgetId: 'b-1' })]
		})
		await readTurn(await harness.run({ messages: [userMessage('Slet')] }))

		const page = await handlersFor(harness).get(SCOPE, {
			threadId: harness.threadKey.threadId
		})

		expect(page?.pendingChanges).toEqual([
			expect.objectContaining({ kind: 'approval', toolName: DELETE_TOOL })
		])
	})

	test('should delete the thread, its observations and its waiting runs', async () => {
		// Given a thread with a deletion waiting for approval
		const harness = createHarness({
			replies: [toolCallReply(DELETE_TOOL, { budgetId: 'b-1' })]
		})
		await readTurn(await harness.run({ messages: [userMessage('Slet')] }))
		const store = await harness.memory.storage.getStore('memory')
		const clear = spyOn(store!, 'clearObservationalMemory')
		const threads = handlersFor(harness)
		const { threadId, resourceId } = harness.threadKey

		// When a stranger and then the caller delete it
		const strangers = await threads.delete(STRANGER, threadId)
		const callers = await threads.delete(SCOPE, threadId)

		// Then only the caller's delete removes it, with everything tied to it
		expect(strangers).toBe('not_found')
		expect(callers).toBe('deleted')
		expect(await harness.memory.getThreadById({ threadId })).toBeNull()
		expect(clear).toHaveBeenCalledWith(threadId, resourceId)
		const agent = harness.mastra.getAgentById('chat')
		expect(
			(await agent.listSuspendedRuns(harness.threadKey)).runs
		).toHaveLength(0)
	})

	test('should leave a thread a turn holds', async () => {
		const harness = createHarness()
		await readTurn(await harness.run({ messages: [userMessage('Hej')] }))
		const threads = createThreadHandlers<Scope>({
			memory: harness.memory,
			resourceId: (scope) => `${scope.organizationId}:${scope.userId}`,
			userId: (scope) => scope.userId,
			lock: async () => null
		})

		expect(await threads.delete(SCOPE, harness.threadKey.threadId)).toBe(
			'locked'
		)
	})

	test('should not rate a message that is not an answer in the thread', async () => {
		const harness = createHarness()
		await readTurn(await harness.run({ messages: [userMessage('Hej')] }))

		const rated = await handlersFor(harness).rate(SCOPE, {
			threadId: harness.threadKey.threadId,
			messageId: 'not-there',
			rating: 'up'
		})

		expect(rated).toBe(false)
	})
})

describe('sweepOldThreads', () => {
	test('should delete only the threads untouched since the cutoff', async () => {
		// Given one stored thread
		const harness = createHarness()
		await readTurn(await harness.run({ messages: [userMessage('Hej')] }))

		// When sweeping with a cutoff before and after it
		const early = await sweepOldThreads({
			memory: harness.memory,
			olderThan: new Date(0)
		})
		const late = await sweepOldThreads({
			memory: harness.memory,
			olderThan: new Date(Date.now() + 60_000)
		})

		// Then only the later sweep deletes it
		expect([early.deleted, late.deleted]).toEqual([0, 1])
		expect(
			await harness.memory.getThreadById({
				threadId: harness.threadKey.threadId
			})
		).toBeNull()
	})
})

test('should sweep every expired thread, not only the first batch, and keep live ones', async () => {
	// Given more expired threads than two batches hold, a foreign one and a live one
	const harness = createHarness()
	const saveThread = (id: string, ageDays: number) => {
		const at = new Date(Date.now() - ageDays * 86_400_000)
		return harness.memory.saveThread({
			thread: {
				id,
				resourceId: 'r',
				title: '',
				metadata: {},
				createdAt: at,
				updatedAt: at
			}
		})
	}
	await Promise.all(
		Array.from({ length: 25 }, (_, i) => saveThread(`old-${i}`, 120))
	)
	await saveThread('foreign-old', 121)
	await saveThread('live', 3)

	// When sweeping in batches of ten, leaving the foreign thread alone
	const result = await sweepOldThreads({
		memory: harness.memory,
		olderThan: new Date(Date.now() - 90 * 86_400_000),
		batchSize: 10,
		filter: (thread) => thread.id.startsWith('old-')
	})

	// Then every expired chat thread is gone and the rest stay
	const { threads } = await harness.memory.listThreads({ perPage: false })
	expect(result).toEqual({ deleted: 25, failed: 0 })
	expect(threads.map((thread) => thread.id).sort()).toEqual([
		'foreign-old',
		'live'
	])
})
