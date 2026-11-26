import { describe, expect, test } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import type { UIMessageChunk } from 'ai'
import { Hono } from 'hono'
import { z } from 'zod'

import { createChatRoute } from '../hono/chatRoute.js'
import { TURN_DATASET_PART, turnDatasetSchema } from '../protocol/index.js'
import {
	bindTurnDatasets,
	readTurnDataset,
	registerDataset,
	TURN_DATASET_KIND
} from '../tools/datasets.js'
import { defineTool, ToolRefusal } from '../tools/defineTool.js'
import { markDryRun } from '../tools/dryRun.js'
import { createMemoryRecordStore } from '../tools/records.js'
import { refused } from './runChatTurn.js'
import { deleteThreadEverywhere } from './threads.js'
import {
	createHarness,
	readTurn,
	requestContext,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'
import type { ChatTurnBody } from './types.js'

/** A number no model would write by chance: if it reaches a prompt or the thread, a row did. */
const REVENUE = 98_765.43
const ROWS = [
	{ month: '2026-09', revenue: REVENUE },
	{ month: '2026-10', revenue: 12_345.67 }
]

const revenueTool = defineTool({
	tool: {
		id: 'revenue_by_month',
		description: 'Revenue per month.',
		inputSchema: z.object({}),
		execute: async (
			_input: unknown,
			context: { requestContext?: RequestContext }
		) =>
			registerDataset(context, {
				rows: ROWS,
				columns: [
					{ key: 'month' },
					{ key: 'revenue', label: 'Revenue', type: 'currency' }
				],
				title: 'Revenue by month',
				summary: 'Two months; October is lower than September.'
			})
	},
	tier: 'read'
})

const tableTool = defineTool({
	tool: {
		id: 'show_table',
		description: 'Shows a dataset as a table.',
		inputSchema: z.object({ datasetId: z.string() }),
		execute: async () => ({ shown: true })
	},
	tier: 'read',
	datasets: (input: { datasetId: string }) => [input.datasetId]
})

function contextWith(
	store: ReturnType<typeof createMemoryRecordStore>,
	threadId = 'thread-1'
) {
	const context = new RequestContext()
	bindTurnDatasets(context, { store, threadId, resourceId: 'user', maxRows: 2 })

	return context
}

describe('registerDataset', () => {
	test('should store the rows and hand back only a handle', async () => {
		const store = createMemoryRecordStore()
		const handle = await revenueTool.tool.execute?.(
			{} as never,
			{ requestContext: contextWith(store) } as never
		)

		expect(JSON.stringify(handle)).not.toContain(String(REVENUE))
		expect(handle).toMatchObject({
			rowCount: 2,
			title: 'Revenue by month',
			summary: expect.any(String)
		})
		const dataset = await readTurnDataset({
			store,
			datasetId: (handle as { datasetId: string }).datasetId,
			threadId: 'thread-1'
		})
		expect(dataset?.rows).toEqual(ROWS)
	})

	test('should refuse more rows than a dataset holds, with a sentence for the model', async () => {
		await expect(
			registerDataset(
				{ requestContext: contextWith(createMemoryRecordStore()) },
				{ rows: [...ROWS, ...ROWS] }
			)
		).rejects.toBeInstanceOf(ToolRefusal)
	})

	test('should take columns from the first row when none are given', async () => {
		const handle = await registerDataset(
			{ requestContext: contextWith(createMemoryRecordStore()) },
			{ rows: ROWS }
		)

		expect(handle.columns).toEqual([{ key: 'month' }, { key: 'revenue' }])
	})

	test('in a dry run should keep the dataset in memory, so a display tool still finds it', async () => {
		const context = new RequestContext()
		markDryRun(context)

		const handle = await registerDataset(
			{ requestContext: context },
			{ rows: ROWS }
		)

		await expect(
			tableTool.tool.execute?.(
				{ datasetId: handle.datasetId } as never,
				{ requestContext: context } as never
			)
		).resolves.toEqual({ shown: true })
	})
})

describe('a display tool', () => {
	test('should refuse a dataset of another thread, or one that does not exist, before it runs', async () => {
		const store = createMemoryRecordStore()
		const other = await registerDataset(
			{ requestContext: contextWith(store, 'thread-2') },
			{ rows: ROWS }
		)

		for (const datasetId of [other.datasetId, 'ds_made_up']) {
			await expect(
				tableTool.tool.execute?.(
					{ datasetId } as never,
					{ requestContext: contextWith(store) } as never
				)
			).rejects.toThrow(/No dataset has the id/)
		}
	})
})

describe('runChatTurn with datasets', () => {
	function datasetHarness() {
		const store = createMemoryRecordStore()
		const harness = createHarness({
			replies: [
				toolCallReply('revenue_by_month', {}, 'call-data'),
				// The model only has the handle; the test reads the id from the store.
				async () => {
					const [dataset] = await store.list(
						TURN_DATASET_KIND,
						harness.threadKey.threadId
					)
					return {
						stream: new ReadableStream({
							start(controller) {
								for (const part of toolCallReply(
									'show_table',
									{ datasetId: dataset?.id },
									'call-show'
								)) {
									controller.enqueue(part)
								}
								controller.close()
							}
						})
					}
				},
				textReply('September was the stronger month.')
			],
			overrides: {
				datasets: { store },
				prepare: async ({ scope, threadKey }) => ({
					requestContext: requestContext.create(scope, threadKey),
					plan: {
						instructions: 'Stable instructions.',
						model: harness.model,
						modelId: 'test-model',
						tools: {
							revenue_by_month: revenueTool.tool,
							show_table: tableTool.tool
						},
						maxSteps: 5
					}
				})
			}
		})

		return { harness, store }
	}

	test('should stream the rows to the client and keep them out of every prompt and the stored thread', async () => {
		const { harness, store } = datasetHarness()

		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Revenue by month?')] })
		)

		// The client got the rows, transient, from the store
		const part = chunks.find((chunk) => chunk.type === TURN_DATASET_PART) as
			| (UIMessageChunk & { data: { dataset: unknown }; transient?: boolean })
			| undefined
		expect(part?.transient).toBe(true)
		expect(turnDatasetSchema.parse(part?.data.dataset).rows).toEqual(ROWS)

		// The model never read a row, and the thread never stored one
		for (const call of harness.model.doStreamCalls) {
			expect(JSON.stringify(call.prompt)).not.toContain(String(REVENUE))
		}
		const { messages } = await harness.memory.recall({
			threadId: harness.threadKey.threadId,
			resourceId: harness.threadKey.resourceId
		})
		expect(JSON.stringify(messages)).not.toContain(String(REVENUE))

		// And a deleted thread takes its datasets along
		await deleteThreadEverywhere(
			harness.memory,
			harness.threadKey,
			undefined,
			store
		)
		expect(
			await store.list(TURN_DATASET_KIND, harness.threadKey.threadId)
		).toEqual([])
	})
})

describe('the dataset route', () => {
	test("should answer the thread owner's dataset, and 404 for anyone else or any other id", async () => {
		const store = createMemoryRecordStore()
		const handle = await registerDataset(
			{ requestContext: contextWith(store) },
			{ rows: ROWS }
		)
		const app = new Hono().route(
			'/',
			createChatRoute<string, ChatTurnBody>({
				path: '/chat',
				auth: async (c) => c.req.header('authorization') ?? null,
				parseBody: () => undefined,
				runTurn: async () => refused('invalid_request'),
				ownsThread: async (threadId, auth) =>
					threadId === 'thread-1' && auth === 'user',
				datasets: { store }
			})
		)
		const get = (datasetId: string, auth = 'user') =>
			app.request(
				new Request(`http://test/chat/thread-1/datasets/${datasetId}`, {
					headers: { authorization: auth }
				})
			)

		const ok = await get(handle.datasetId)
		expect(
			turnDatasetSchema.parse(
				((await ok.json()) as { dataset: unknown }).dataset
			).rows
		).toEqual(ROWS)
		expect((await get(handle.datasetId, 'someone-else')).status).toBe(404)
		expect((await get('ds_missing')).status).toBe(404)
	})
})
