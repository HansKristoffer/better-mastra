import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'

import type { ChangePlanView } from '../protocol/index.js'
import {
	CHANGE_PLAN_PART,
	type ChangePlanState,
	createChangePlanStore,
	readProposedChangePlans
} from './changePlans.js'

const step = (
	index: number,
	status: 'pending' | 'applied' | 'failed' = 'pending'
) => ({
	index,
	tool: 'prices_raise',
	title: `Step ${index + 1}`,
	status,
	count: 1,
	sample: [{ target: 'a', before: 1, after: 2 }]
})

function planOf(
	status: ChangePlanView['status'],
	steps = [step(0), step(1)]
): ChangePlanView {
	return {
		id: 'plan-1',
		threadId: 'thread-1',
		status,
		steps,
		createdAt: '2026-11-26T00:00:00.000Z',
		updatedAt: '2026-11-26T00:00:00.000Z'
	}
}

function ndjson(lines: readonly unknown[]): Response {
	return new Response(
		lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
		{
			headers: { 'content-type': 'application/x-ndjson' }
		}
	)
}

/** Every state the store goes through for a plan, in order. */
function record(
	store: ReturnType<typeof createChangePlanStore>,
	planId: string
) {
	const states: ChangePlanState[] = []
	store.subscribe(() => states.push(store.get(planId)))

	return states
}

describe('readProposedChangePlans', () => {
	test("should group a message's plan-tier tool results by plan, in order", () => {
		const output = (index: number) => ({
			changePlan: { planId: 'plan-1', step: step(index) }
		})
		const message = {
			id: 'm',
			role: 'assistant',
			parts: [
				{
					type: 'tool-prices_raise',
					toolCallId: 'c1',
					state: 'output-available',
					input: {},
					output: output(0)
				},
				{
					type: 'tool-prices_get',
					toolCallId: 'c2',
					state: 'output-available',
					input: {},
					output: { price: 1 }
				},
				{
					type: 'tool-prices_raise',
					toolCallId: 'c3',
					state: 'output-available',
					input: {},
					output: output(1)
				}
			]
		} as unknown as UIMessage

		expect(readProposedChangePlans(message)).toEqual([
			{ planId: 'plan-1', steps: [step(0), step(1)] }
		])
	})
})

describe('createChangePlanStore', () => {
	test('should take the plan from the stream part, and not load it again', async () => {
		const calls: string[] = []
		const store = createChangePlanStore({
			api: '/chat',
			fetch: async (input) => {
				calls.push(String(input))
				return Response.json({ plan: planOf('proposed') })
			}
		})

		store.onData({ type: CHANGE_PLAN_PART, data: { plan: planOf('proposed') } })
		await store.load('thread-1', 'plan-1')

		expect(store.get('plan-1').plan?.status).toBe('proposed')
		expect(calls).toEqual([])
	})

	test('should show each step as the confirm streams its progress', async () => {
		const calls: { url: string; method: string | undefined }[] = []
		const store = createChangePlanStore({
			api: '/chat',
			fetch: async (input, init) => {
				calls.push({ url: String(input), method: init?.method })
				return ndjson([
					{ type: 'step-started', index: 0 },
					{ type: 'step-applied', index: 0 },
					{ type: 'step-started', index: 1 },
					{
						type: 'step-failed',
						index: 1,
						error: { code: 'changed_since', message: 'Changed.' }
					},
					{
						type: 'finished',
						plan: planOf('failed', [step(0, 'applied'), step(1, 'failed')])
					}
				])
			}
		})
		store.onData({ type: CHANGE_PLAN_PART, data: { plan: planOf('proposed') } })
		const states = record(store, 'plan-1')

		await store.confirm('thread-1', 'plan-1')

		expect(calls).toEqual([
			{ url: '/chat/thread-1/plans/plan-1/apply', method: 'POST' }
		])
		expect(
			states.map((state) => [
				state.phase,
				state.runningStep,
				state.plan?.steps.map((s) => s.status)
			])
		).toEqual([
			['applying', undefined, ['pending', 'pending']],
			['applying', 0, ['pending', 'pending']],
			['applying', 0, ['applied', 'pending']],
			['applying', 1, ['applied', 'pending']],
			['applying', 1, ['applied', 'failed']],
			['applying', undefined, ['applied', 'failed']],
			['idle', undefined, ['applied', 'failed']]
		])
		expect(store.get('plan-1').plan?.status).toBe('failed')
	})

	test('should follow a plan another window applies until it ends', async () => {
		const answers = [planOf('applying'), planOf('applying'), planOf('applied')]
		const store = createChangePlanStore({
			api: '/chat',
			followMs: 1,
			fetch: async (_input, init) =>
				init?.method === 'POST'
					? Response.json({ error: 'in_progress' }, { status: 409 })
					: Response.json({ plan: answers.shift() ?? planOf('applied') })
		})

		await store.confirm('thread-1', 'plan-1')
		expect(store.get('plan-1').refusal).toBe('in_progress')

		for (
			let wait = 0;
			wait < 50 && store.get('plan-1').plan?.status !== 'applied';
			wait += 1
		) {
			await Bun.sleep(5)
		}

		expect(store.get('plan-1').plan?.status).toBe('applied')
		store.dispose()
	})

	test('should discard a plan and keep a failed request to try again', async () => {
		let online = false
		const store = createChangePlanStore({
			api: '/chat',
			fetch: async () => {
				if (!online) throw new TypeError('Failed to fetch')
				return Response.json({ plan: planOf('discarded') })
			}
		})

		await store.discard('thread-1', 'plan-1')
		expect(store.get('plan-1')).toMatchObject({ phase: 'idle', failed: true })

		online = true
		await store.discard('thread-1', 'plan-1')
		expect(store.get('plan-1')).toMatchObject({
			failed: false,
			plan: { status: 'discarded' }
		})
	})
})
