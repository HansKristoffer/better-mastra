import { describe, expect, test } from 'bun:test'

import { createDatasetStore, TURN_DATASET_PART } from './datasets.js'

const dataset = {
	id: 'ds_1',
	threadId: 'thread-1',
	columns: [{ key: 'month' }],
	rows: [{ month: '2026-10' }],
	createdAt: '2026-11-26T00:00:00.000Z'
}

describe('createDatasetStore', () => {
	test('should take the rows from the stream, and not load them again', async () => {
		const calls: string[] = []
		const store = createDatasetStore({
			api: '/chat',
			fetch: async (input) => {
				calls.push(String(input))
				return Response.json({ dataset })
			}
		})

		store.onData({ type: TURN_DATASET_PART, data: { dataset } })
		await store.load('thread-1', 'ds_1')

		expect(store.get('ds_1').dataset?.rows).toEqual(dataset.rows)
		expect(calls).toEqual([])
	})

	test("should load a stored answer's dataset by id, and mark one the server no longer has", async () => {
		const store = createDatasetStore({
			api: '/chat',
			fetch: async (input) =>
				String(input).endsWith('/ds_1')
					? Response.json({ dataset })
					: new Response(null, { status: 404 })
		})

		await store.load('thread-1', 'ds_1')
		await store.load('thread-1', 'ds_gone')

		expect(store.get('ds_1').dataset?.id).toBe('ds_1')
		expect(store.get('ds_gone')).toMatchObject({
			missing: true,
			dataset: undefined
		})
	})
})
