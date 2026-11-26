import { describe, expect, test } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'

import {
	type ChangePlanProgress,
	changePlanStepOutputSchema
} from '../protocol/index.js'
import {
	applyChangePlan,
	bindTurnChangePlan,
	CHANGE_PLAN_KIND,
	type ChangePlanRecord,
	changePlansSignal,
	closeTurnChangePlan,
	discardChangePlan,
	moveOnFromWaitingPlans,
	readChangePlan,
	readDryRunChangePlan,
	turnChangePlanId
} from './changePlans.js'
import { applyTarget } from './changes.js'
import { defineTool, ToolRefusal } from './defineTool.js'
import { markDryRun } from './dryRun.js'
import { type ChatRecordStore, createMemoryRecordStore } from './records.js'

const THREAD = 'thread-1'

/** A price list that records every write, so a test sees exactly what was written. */
function createPrices(initial: Record<string, number>) {
	const prices = new Map(Object.entries(initial))
	const writes: { id: string; price: number }[] = []

	return {
		prices,
		writes,
		read: async (id: string) => prices.get(id),
		write: async (id: string, price: number) => {
			writes.push({ id, price })
			prices.set(id, price)
		}
	}
}

type Prices = ReturnType<typeof createPrices>

/** `prices_raise`: raises the named products' prices by a percentage, as a plan step. */
function raisePricesTool(
	db: Prices,
	options: {
		readonly write?: (id: string, price: number) => Promise<void>
		readonly guard?: (
			requestContext: RequestContext | undefined
		) => string | undefined
	} = {}
) {
	return defineTool({
		tool: {
			id: 'prices_raise',
			description: 'Raises prices by a percentage.',
			inputSchema: z.object({
				productIds: z.array(z.string()),
				percent: z.number(),
				shopId: z.string().optional()
			})
		},
		tier: 'plan',
		hiddenInputs: {
			shopId: (requestContext) => requestContext.get('shopId' as never)
		},
		plan: {
			guard: ({ requestContext }) => options.guard?.(requestContext),
			propose: async ({
				input
			}: {
				input: { productIds: string[]; percent: number }
			}) => ({
				title: `Raise ${input.productIds.length} prices by ${input.percent}%`,
				changes: await Promise.all(
					input.productIds.map(async (id) => {
						const seen = (await db.read(id)) ?? null

						return {
							target: { productId: id },
							seen,
							next:
								seen === null
									? null
									: Math.round(seen * (1 + input.percent / 100)),
							label: id
						}
					})
				)
			}),
			read: (target: { productId: string }) => db.read(target.productId),
			write: (target: { productId: string }, price: number) =>
				(options.write ?? db.write)(target.productId, price)
		}
	})
}

function turnContext(
	store: ChatRecordStore,
	caps?: { maxSteps?: number; maxChangesPerStep?: number }
) {
	const requestContext = contextOf({ shopId: 'shop-1' })
	bindTurnChangePlan(requestContext, {
		store,
		threadId: THREAD,
		resourceId: 'user:1',
		...(caps && { caps })
	})

	return requestContext
}

async function propose(
	tool: ReturnType<typeof raisePricesTool>,
	requestContext: RequestContext,
	input: { productIds: string[]; percent: number }
) {
	return tool.tool.execute?.(input as never, { requestContext } as never)
}

/** A plan of the given steps, proposed by one answered turn; its id. */
async function proposedPlan(
	store: ChatRecordStore,
	tool: ReturnType<typeof raisePricesTool>,
	steps: { productIds: string[]; percent: number }[]
): Promise<string> {
	const requestContext = turnContext(store)

	for (const step of steps) await propose(tool, requestContext, step)

	await closeTurnChangePlan(requestContext, true)

	return turnChangePlanId(requestContext)!
}

function contextOf(values: Record<string, unknown>): RequestContext {
	return new RequestContext(
		Object.entries(values) as never
	) as unknown as RequestContext
}

function applyContext(values: Record<string, unknown> = { shopId: 'shop-1' }) {
	return contextOf(values)
}

async function apply(
	store: ChatRecordStore,
	planId: string,
	tool: ReturnType<typeof raisePricesTool>,
	extra: Partial<Parameters<typeof applyChangePlan>[0]> = {}
) {
	const progress: ChangePlanProgress[] = []
	const result = await applyChangePlan({
		store,
		planId,
		threadId: THREAD,
		tools: [tool],
		requestContext: applyContext(),
		onProgress: (event) => progress.push(event),
		...extra
	})

	return { result, progress }
}

async function editStoredPlan(
	store: ChatRecordStore,
	planId: string,
	edit: (record: ChangePlanRecord) => ChangePlanRecord
) {
	const record = (await store.get(CHANGE_PLAN_KIND, planId)) as ChangePlanRecord
	expect(await store.put(edit(record), record.version)).toBe(true)
}

describe('applyTarget', () => {
	test('should write only while the target holds the seen value, and count a target that holds next as done', async () => {
		const write = async () => {}

		expect(
			await applyTarget({ read: async () => 1, seen: 1, next: 2, write })
		).toBe('applied')
		expect(
			await applyTarget({ read: async () => 2, seen: 1, next: 2, write })
		).toBe('alreadyApplied')
		expect(
			await applyTarget({ read: async () => 3, seen: 1, next: 2, write })
		).toBe('changedSince')
		expect(
			await applyTarget({
				read: async () => 1,
				seen: 1,
				next: 2,
				write: async () => {
					throw new Error('down')
				}
			})
		).toBe('failed')
	})
})

describe('proposing a change plan', () => {
	test('should store a step and write nothing, and tell the model nothing is changed yet', async () => {
		// Given a turn with a plan-tier tool
		const db = createPrices({ a: 100, b: 200 })
		const tool = raisePricesTool(db)
		const store = createMemoryRecordStore()
		const requestContext = turnContext(store)

		// When the model calls it
		const output = await propose(tool, requestContext, {
			productIds: ['a', 'b'],
			percent: 5
		})

		// Then nothing was written, the step is in a draft plan, and the output
		// is what the client reads and the sentence what the model reads
		expect(db.writes).toEqual([])
		const parsed = changePlanStepOutputSchema.parse(output)
		expect(parsed.changePlan.step).toMatchObject({
			index: 0,
			title: 'Raise 2 prices by 5%',
			count: 2,
			sample: [
				{ label: 'a', before: 100, after: 105 },
				{ label: 'b', before: 200, after: 210 }
			]
		})
		const plan = await readChangePlan({
			store,
			planId: parsed.changePlan.planId,
			threadId: THREAD
		})
		expect(plan?.status).toBe('draft')
		const modelOutput = await tool.tool.toModelOutput?.(output as never)
		expect(JSON.stringify(modelOutput)).toContain('Nothing is changed yet')
	})

	test('should keep only the model input in the step, so apply fills hidden inputs again', async () => {
		const tool = raisePricesTool(createPrices({ a: 100 }))
		const store = createMemoryRecordStore()
		const requestContext = turnContext(store)

		await propose(tool, requestContext, { productIds: ['a'], percent: 5 })

		const record = (await store.get(
			CHANGE_PLAN_KIND,
			turnChangePlanId(requestContext)!
		)) as ChangePlanRecord
		expect(record.data.steps[0]?.input).toEqual({
			productIds: ['a'],
			percent: 5
		})
	})

	test("should refuse, as a sentence the model reads, a step over the caps or one touching an earlier step's target", async () => {
		const tool = raisePricesTool(createPrices({ a: 1, b: 2, c: 3 }))
		const store = createMemoryRecordStore()
		const requestContext = turnContext(store, {
			maxSteps: 2,
			maxChangesPerStep: 2
		})

		await expect(
			propose(tool, requestContext, { productIds: ['a', 'b', 'c'], percent: 5 })
		).rejects.toThrow(/at most 2 targets/)
		await propose(tool, requestContext, { productIds: ['a'], percent: 5 })
		await expect(
			propose(tool, requestContext, { productIds: ['a'], percent: 10 })
		).rejects.toBeInstanceOf(ToolRefusal)
		await propose(tool, requestContext, { productIds: ['b'], percent: 5 })
		await expect(
			propose(tool, requestContext, { productIds: ['c'], percent: 5 })
		).rejects.toThrow(/at most 2 steps/)
	})

	test('should add every step of tools called side by side to one plan', async () => {
		const tool = raisePricesTool(createPrices({ a: 1, b: 2, c: 3 }))
		const store = createMemoryRecordStore()
		const requestContext = turnContext(store)

		await Promise.all([
			propose(tool, requestContext, { productIds: ['a'], percent: 5 }),
			propose(tool, requestContext, { productIds: ['b'], percent: 5 }),
			propose(tool, requestContext, { productIds: ['c'], percent: 5 })
		])

		const plan = await readChangePlan({
			store,
			planId: turnChangePlanId(requestContext)!,
			threadId: THREAD
		})
		expect(plan?.steps.map((step) => step.index)).toEqual([0, 1, 2])
	})

	test('should offer the plan when the turn answered and discard it otherwise', async () => {
		const tool = raisePricesTool(createPrices({ a: 1 }))
		const store = createMemoryRecordStore()
		const answered = turnContext(store)
		const failed = turnContext(store)
		await propose(tool, answered, { productIds: ['a'], percent: 5 })
		await propose(tool, failed, { productIds: ['a'], percent: 5 })

		expect((await closeTurnChangePlan(answered, true))?.status).toBe('proposed')
		expect((await closeTurnChangePlan(failed, false))?.status).toBe('discarded')
		expect(await closeTurnChangePlan(turnContext(store), true)).toBeUndefined()
	})

	test('in a dry run should keep the plan in memory and store nothing', async () => {
		// Given an eval run, with a real store bound
		const tool = raisePricesTool(createPrices({ a: 100 }))
		const store = createMemoryRecordStore()
		const requestContext = turnContext(store)
		markDryRun(requestContext)

		// When the model proposes
		await propose(tool, requestContext, { productIds: ['a'], percent: 10 })

		// Then the eval reads the plan, and the store holds nothing
		const plan = await readDryRunChangePlan(requestContext)
		expect(plan?.steps[0]?.sample[0]).toMatchObject({ before: 100, after: 110 })
		expect(await store.list(CHANGE_PLAN_KIND, THREAD)).toEqual([])
	})
})

describe('applying a change plan', () => {
	test('should write every step in order, saving progress after each', async () => {
		const db = createPrices({ a: 100, b: 200 })
		const tool = raisePricesTool(db)
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 },
			{ productIds: ['b'], percent: 10 }
		])

		const { result, progress } = await apply(store, planId, tool)

		expect(db.writes).toEqual([
			{ id: 'a', price: 110 },
			{ id: 'b', price: 220 }
		])
		expect(result).toMatchObject({
			kind: 'finished',
			plan: { status: 'applied' }
		})
		expect(progress.map((event) => event.type)).toEqual([
			'step-started',
			'step-applied',
			'step-started',
			'step-applied',
			'finished'
		])
	})

	test('should refuse a step whose target changed since, write nothing of it, and stop the plan there', async () => {
		// Given a two-step plan, and someone else changing step 1's second target
		const db = createPrices({ a: 100, b: 200, c: 300 })
		const tool = raisePricesTool(db)
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a', 'b'], percent: 10 },
			{ productIds: ['c'], percent: 10 }
		])
		db.prices.set('b', 999)

		// When the user confirms
		const { result } = await apply(store, planId, tool)

		// Then step 1 wrote nothing (not even its unchanged target), step 2 never ran
		expect(db.writes).toEqual([])
		expect(result.kind === 'finished' && result.plan).toMatchObject({
			status: 'failed',
			steps: [
				{ status: 'failed', error: { code: 'changed_since' } },
				{ status: 'pending' }
			]
		})
	})

	test('should resume at the failed step and not run the steps already applied', async () => {
		// Given a plan whose step 2 failed to write
		const db = createPrices({ a: 100, b: 200 })
		let failWrites = true
		const tool = raisePricesTool(db, {
			write: async (id, price) => {
				if (id === 'b' && failWrites) throw new Error('database is down')
				await db.write(id, price)
			}
		})
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 },
			{ productIds: ['b'], percent: 10 }
		])
		const first = await apply(store, planId, tool)
		expect(
			first.result.kind === 'finished' &&
				first.result.plan.steps.map((step) => step.status)
		).toEqual(['applied', 'failed'])

		// When the user applies it again once the database is back
		failWrites = false
		const second = await apply(store, planId, tool)

		// Then only step 2 ran
		expect(second.result).toMatchObject({
			kind: 'finished',
			plan: { status: 'applied' }
		})
		expect(db.writes).toEqual([
			{ id: 'a', price: 110 },
			{ id: 'b', price: 220 }
		])
		expect(second.progress[0]).toEqual({ type: 'step-started', index: 1 })
	})

	test('(a) should count a target that already holds the new value as done, not as changed by someone else', async () => {
		// Given a plan whose first target an interrupted run already wrote
		// (the write landed, the progress save did not)
		const db = createPrices({ a: 100, b: 200 })
		const tool = raisePricesTool(db)
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a', 'b'], percent: 10 }
		])
		db.prices.set('a', 110)

		// When the plan is applied
		const { result } = await apply(store, planId, tool)

		// Then the step completes, and only the target still at its old value is written
		expect(result).toMatchObject({
			kind: 'finished',
			plan: { status: 'applied' }
		})
		expect(db.writes).toEqual([{ id: 'b', price: 220 }])
	})

	test("(a) should finish a hung runner's plan once its lease expired, and save nothing of the hung runner after", async () => {
		// Given a runner that wrote target a, then hung on target b
		const db = createPrices({ a: 100, b: 200 })
		let releaseHung: () => void = () => {}
		const hung = new Promise<void>((resolve) => {
			releaseHung = resolve
		})
		let clock = 0
		const now = () => clock
		const hangingTool = raisePricesTool(db, {
			write: async (id, price) => {
				if (id === 'b') await hung
				await db.write(id, price)
			}
		})
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, hangingTool, [
			{ productIds: ['a', 'b'], percent: 10 }
		])
		const crashed = apply(store, planId, hangingTool, {
			now,
			leaseMs: 1_000,
			owner: 'first'
		})
		await Bun.sleep(5)

		// When a second runner tries before and after the lease ran out
		const healthyTool = raisePricesTool(db)
		const early = await apply(store, planId, healthyTool, {
			now,
			leaseMs: 1_000,
			owner: 'second'
		})
		clock = 2_000
		const late = await apply(store, planId, healthyTool, {
			now,
			leaseMs: 1_000,
			owner: 'second'
		})

		// Then the early one is refused, and the late one finishes the plan
		// with a counted as done
		expect(early.result).toEqual({ kind: 'refused', code: 'in_progress' })
		expect(late.result).toMatchObject({
			kind: 'finished',
			plan: { status: 'applied' }
		})

		// And when the first runner wakes up, it saves nothing over the plan
		releaseHung()
		const { result, progress } = await crashed
		expect(progress.at(-1)).toMatchObject({
			type: 'step-failed',
			error: { code: 'lease_lost' }
		})
		expect(result.kind === 'finished' && result.plan.status).toBe('applying')
		expect(
			(await readChangePlan({ store, planId, threadId: THREAD }))?.status
		).toBe('applied')
		expect(db.writes.filter((write) => write.id === 'a')).toHaveLength(1)
		// The hung write was already past its re-read: it lands the same value.
		expect(
			db.writes.filter((write) => write.id === 'b').map((write) => write.price)
		).toEqual([220, 220])
	})

	test('(b) should refuse a step whose stored snapshot is missing or does not parse, and write nothing', async () => {
		for (const broken of [
			{ seen: undefined },
			{ seen: '{not json' },
			{ seen: 42 }
		]) {
			const db = createPrices({ a: 100 })
			const tool = raisePricesTool(db)
			const store = createMemoryRecordStore()
			const planId = await proposedPlan(store, tool, [
				{ productIds: ['a'], percent: 10 }
			])
			await editStoredPlan(store, planId, (record) => ({
				...record,
				data: {
					...record.data,
					steps: record.data.steps.map((step) => ({
						...step,
						changes: step.changes.map(
							(change) => ({ ...change, ...broken }) as never
						)
					}))
				}
			}))

			const { result } = await apply(store, planId, tool)

			expect(db.writes).toEqual([])
			expect(
				result.kind === 'finished' && result.plan.steps[0]?.error?.code
			).toBe('snapshot_unreadable')
		}
	})

	test('(b) should refuse a step whose snapshot fails the value schema', async () => {
		const db = createPrices({ a: 100 })
		const base = raisePricesTool(db)
		const tool = {
			...base,
			plan: {
				...base.plan!,
				definition: { ...base.plan!.definition, valueSchema: z.string() }
			}
		}
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, base, [
			{ productIds: ['a'], percent: 10 }
		])

		const { result } = await apply(store, planId, tool)

		expect(db.writes).toEqual([])
		expect(
			result.kind === 'finished' && result.plan.steps[0]?.error?.code
		).toBe('snapshot_unreadable')
	})

	test('(c) should let only one of two simultaneous confirms run the plan', async () => {
		const db = createPrices({ a: 100, b: 200 })
		const tool = raisePricesTool(db)
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a', 'b'], percent: 10 }
		])

		const results = await Promise.all([
			apply(store, planId, tool, { owner: 'window-1' }),
			apply(store, planId, tool, { owner: 'window-2' })
		])

		expect(results.map(({ result }) => result.kind).sort()).toEqual([
			'finished',
			'refused'
		])
		expect(db.writes).toHaveLength(2)
	})

	test('(c) should never claim an applied or discarded plan again, nor a draft', async () => {
		const tool = raisePricesTool(createPrices({ a: 100, b: 200 }))
		const store = createMemoryRecordStore()
		const applied = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 }
		])
		await apply(store, applied, tool)
		const discarded = await proposedPlan(store, tool, [
			{ productIds: ['b'], percent: 10 }
		])
		await discardChangePlan({ store, planId: discarded, threadId: THREAD })
		const draftContext = turnContext(store)
		await propose(tool, draftContext, { productIds: ['b'], percent: 10 })

		expect((await apply(store, applied, tool)).result).toEqual({
			kind: 'refused',
			code: 'closed'
		})
		expect((await apply(store, discarded, tool)).result).toEqual({
			kind: 'refused',
			code: 'closed'
		})
		expect(
			(await apply(store, turnChangePlanId(draftContext)!, tool)).result
		).toEqual({
			kind: 'refused',
			code: 'not_ready'
		})
		expect(
			await discardChangePlan({ store, planId: applied, threadId: THREAD })
		).toEqual({
			kind: 'refused',
			code: 'closed'
		})
	})

	test('should answer a plan of another thread as not found', async () => {
		const tool = raisePricesTool(createPrices({ a: 100 }))
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 }
		])

		expect(
			(await apply(store, planId, tool, { threadId: 'thread-2' })).result
		).toEqual({
			kind: 'refused',
			code: 'not_found'
		})
		expect(
			await readChangePlan({ store, planId, threadId: 'thread-2' })
		).toBeNull()
	})

	test("should run the guard again per step with the apply request's context", async () => {
		const db = createPrices({ a: 100 })
		const tool = raisePricesTool(db, {
			guard: (requestContext) =>
				requestContext?.get('role' as never) === 'viewer'
					? 'Only an owner can change prices.'
					: undefined
		})
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 }
		])

		const { result } = await apply(store, planId, tool, {
			requestContext: applyContext({ shopId: 'shop-1', role: 'viewer' })
		})

		expect(db.writes).toEqual([])
		expect(result.kind === 'finished' && result.plan.steps[0]?.error).toEqual({
			code: 'refused',
			message: 'Only an owner can change prices.'
		})
	})

	test('should fail a step whose tool is gone', async () => {
		const tool = raisePricesTool(createPrices({ a: 100 }))
		const store = createMemoryRecordStore()
		const planId = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 }
		])

		const { result } = await apply(store, planId, tool, { tools: [] })

		expect(
			result.kind === 'finished' && result.plan.steps[0]?.error?.code
		).toBe('unknown_tool')
	})
})

describe("the thread's plans", () => {
	test('should be discarded when the user writes a new message instead, and told to the model', async () => {
		const tool = raisePricesTool(createPrices({ a: 100, b: 200 }))
		const store = createMemoryRecordStore()
		const applied = await proposedPlan(store, tool, [
			{ productIds: ['a'], percent: 10 }
		])
		await apply(store, applied, tool)
		await proposedPlan(store, tool, [{ productIds: ['b'], percent: 10 }])

		const plans = await moveOnFromWaitingPlans({ store, threadId: THREAD })

		expect(plans.map((plan) => plan.data.status)).toEqual([
			'applied',
			'discarded'
		])
		expect(changePlansSignal(plans)).toBe(
			[
				'Change plans you proposed in this conversation, newest last:',
				'- "Raise 1 prices by 10%": the user confirmed it and all 1 steps were applied.',
				'- "Raise 1 prices by 10%": not confirmed, so nothing was changed.'
			].join('\n')
		)
		expect(changePlansSignal([])).toBeUndefined()
	})
})
