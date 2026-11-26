import { describe, expect, test } from 'bun:test'
import { createTool } from '@mastra/core/tools'
import type { UIMessageChunk } from 'ai'
import { z } from 'zod'

import { CHANGE_PLAN_PART, changePlanSchema } from '../protocol/index.js'
import { applyChangePlan, CHANGE_PLAN_KIND } from '../tools/changePlans.js'
import { defineTool } from '../tools/defineTool.js'
import { createMemoryRecordStore } from '../tools/records.js'
import {
	createHarness,
	failingReply,
	readTurn,
	requestContext,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'

const PLAN_TOOL = 'prices_raise'
const WRITE_TOOL = 'prices_set'
const READ_TOOL = 'prices_get'

/**
 * A price table that records every write it takes, whoever makes it: the
 * guard test counts what reached the data, not what a tool says it did.
 */
function createPriceTable(initial: Record<string, number>) {
	const prices = new Map(Object.entries(initial))
	const writes: { readonly id: string; readonly price: number }[] = []

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

type PriceTable = ReturnType<typeof createPriceTable>

/** The app's tools over the table: a read, a plan-tier raise, and an approval-tier set. */
function priceTools(
	table: PriceTable,
	options: { readonly proposeWrites?: boolean } = {}
) {
	const raise = defineTool({
		tool: {
			id: PLAN_TOOL,
			description: 'Raises prices by a percentage.',
			inputSchema: z.object({
				productIds: z.array(z.string()),
				percent: z.number()
			})
		},
		tier: 'plan',
		plan: {
			propose: async ({
				input
			}: {
				input: { productIds: string[]; percent: number }
			}) => ({
				title: `Raise ${input.productIds.length} prices by ${input.percent}%`,
				changes: await Promise.all(
					input.productIds.map(async (id) => {
						const seen = (await table.read(id)) ?? 0
						const next = Math.round(seen * (1 + input.percent / 100))

						// A broken tool that writes while it proposes: the guard test must catch it.
						if (options.proposeWrites) await table.write(id, next)

						return { target: id, seen, next, label: id }
					})
				)
			}),
			read: (id: string) => table.read(id),
			write: (id: string, price: number) => table.write(id, price)
		}
	})
	const set = defineTool({
		tool: {
			id: WRITE_TOOL,
			description: 'Sets one price.',
			inputSchema: z.object({ productId: z.string(), price: z.number() }),
			execute: async ({
				productId,
				price
			}: {
				productId: string
				price: number
			}) => {
				await table.write(productId, price)
				return { ok: true }
			}
		},
		tier: 'approval'
	})
	const get = createTool({
		id: READ_TOOL,
		description: 'Reads one price.',
		inputSchema: z.object({ productId: z.string() }),
		execute: async ({ productId }) => ({ price: await table.read(productId) })
	})

	return { raise, set, get }
}

function planHarness(
	table: PriceTable,
	replies: Parameters<typeof createHarness>[0] extends infer O
		? O extends { replies?: infer R }
			? R
			: never
		: never,
	options: { readonly proposeWrites?: boolean } = {}
) {
	const store = createMemoryRecordStore()
	const tools = priceTools(table, options)
	const harness = createHarness({
		replies,
		overrides: {
			changePlans: { store },
			prepare: async ({ scope, threadKey }) => ({
				requestContext: requestContext.create(scope, threadKey),
				plan: {
					instructions: 'Stable instructions.',
					signal: 'Now on the prices page.',
					model: harness.model,
					modelId: 'test-model',
					tools: {
						[PLAN_TOOL]: tools.raise.tool,
						[WRITE_TOOL]: tools.set.tool,
						[READ_TOOL]: tools.get
					},
					maxSteps: 6
				}
			})
		}
	})

	return { harness, store, tools }
}

function planPart(chunks: readonly UIMessageChunk[]) {
	const part = chunks.find((chunk) => chunk.type === CHANGE_PLAN_PART) as
		{ data: { plan: unknown }; transient?: boolean } | undefined

	return (
		part && {
			plan: changePlanSchema.parse(part.data.plan),
			transient: part.transient
		}
	)
}

describe('runChatTurn with change plans', () => {
	test('should offer the steps of an answered turn as one plan, and write nothing until it is applied', async () => {
		// Given a model that proposes two raises, then answers
		const table = createPriceTable({ a: 100, b: 200 })
		const { harness, store, tools } = planHarness(table, [
			toolCallReply(PLAN_TOOL, { productIds: ['a'], percent: 10 }, 'call-1'),
			toolCallReply(PLAN_TOOL, { productIds: ['b'], percent: 5 }, 'call-2'),
			textReply('Here is the plan.')
		])

		// When the user asks
		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Raise a and b')] })
		)

		// Then the plan arrives once, proposed, with both steps, and nothing was written
		const part = planPart(chunks)
		expect(part?.transient).toBe(true)
		expect(part?.plan).toMatchObject({
			status: 'proposed',
			threadId: harness.threadKey.threadId,
			steps: [
				{ index: 0, title: 'Raise 1 prices by 10%', count: 1 },
				{ index: 1, title: 'Raise 1 prices by 5%', count: 1 }
			]
		})
		expect(table.writes).toEqual([])

		// And when the user confirms, both steps are written
		const result = await applyChangePlan({
			store,
			planId: part!.plan.id,
			threadId: harness.threadKey.threadId,
			tools: [tools.raise],
			requestContext: requestContext.create({
				userId: 'user-1',
				organizationId: 'org-1'
			})
		})
		expect(result).toMatchObject({
			kind: 'finished',
			plan: { status: 'applied' }
		})
		expect(table.writes).toEqual([
			{ id: 'a', price: 110 },
			{ id: 'b', price: 210 }
		])
	})

	test('should discard the plan of a turn that failed, and say so to the client', async () => {
		const table = createPriceTable({ a: 100 })
		const { harness, store } = planHarness(table, [
			toolCallReply(PLAN_TOOL, { productIds: ['a'], percent: 10 }),
			failingReply(new Error('provider down'))
		])

		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Raise a')] })
		)

		expect(planPart(chunks)?.plan.status).toBe('discarded')
		const [stored] = await store.list(
			CHANGE_PLAN_KIND,
			harness.threadKey.threadId
		)
		expect((stored?.data as { status: string } | undefined)?.status).toBe(
			'discarded'
		)
	})

	test('should discard a waiting plan when the user writes again, and tell the model', async () => {
		// Given a turn that proposed a plan the user never confirmed
		const table = createPriceTable({ a: 100 })
		const { harness, store } = planHarness(table, [
			toolCallReply(PLAN_TOOL, { productIds: ['a'], percent: 10 }),
			textReply('Here is the plan.'),
			textReply('Okay.')
		])
		await readTurn(await harness.run({ messages: [userMessage('Raise a')] }))

		// When the user writes something else
		await readTurn(await harness.run({ messages: [userMessage('Never mind')] }))

		// Then the plan is discarded, and the model read so in its signal
		const [stored] = await store.list(
			CHANGE_PLAN_KIND,
			harness.threadKey.threadId
		)
		expect((stored?.data as { status: string } | undefined)?.status).toBe(
			'discarded'
		)
		const lastPrompt = JSON.stringify(
			harness.model.doStreamCalls.at(-1)?.prompt
		)
		expect(lastPrompt).toContain('not confirmed, so nothing was changed')
		expect(lastPrompt).toContain('Now on the prices page.')
	})

	describe('guard: nothing writes outside a plan step or an approved tool', () => {
		const turnReplies = () => [
			toolCallReply(READ_TOOL, { productId: 'a' }, 'call-read'),
			toolCallReply(
				PLAN_TOOL,
				{ productIds: ['a', 'b'], percent: 10 },
				'call-plan'
			),
			toolCallReply(WRITE_TOOL, { productId: 'a', price: 1 }, 'call-write'),
			textReply('Done.')
		]

		test('should find no write in the data after a turn that reads, proposes and asks for approval', async () => {
			// Given a turn that uses every kind of tool, the approval one left unanswered
			const table = createPriceTable({ a: 100, b: 200 })
			const { harness } = planHarness(table, turnReplies())

			// When it runs to its end
			const { chunks } = await readTurn(
				await harness.run({ messages: [userMessage('Raise prices')] })
			)

			// Then the price table took no write: the plan waits, the approval waits
			expect(
				chunks.some((chunk) => chunk.type === 'tool-approval-request')
			).toBe(true)
			expect(table.writes).toEqual([])
		})

		test('should catch a plan-tier tool that writes while it proposes', async () => {
			// Given the same turn with a broken tool, the check above must fail:
			// this proves it reads the data, not a flag a tool sets
			const table = createPriceTable({ a: 100, b: 200 })
			const { harness } = planHarness(table, turnReplies(), {
				proposeWrites: true
			})

			await readTurn(
				await harness.run({ messages: [userMessage('Raise prices')] })
			)

			expect(table.writes).not.toEqual([])
		})
	})
})
