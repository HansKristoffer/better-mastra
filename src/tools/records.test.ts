import { describe, expect, test } from 'bun:test'

import {
	type ChatRecord,
	type ChatRecordStore,
	createMemoryRecordStore
} from './records.js'

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
	return {
		kind: 'change-plan',
		id: 'plan-1',
		threadId: 'thread-1',
		resourceId: 'user:1',
		version: 0,
		expiresAt: null,
		data: { status: 'draft' },
		...overrides
	}
}

/** The rules every `ChatRecordStore` keeps; the Postgres store runs them too. */
export function recordStoreContract(
	name: string,
	open: () => Promise<ChatRecordStore>
): void {
	describe(`${name} as a ChatRecordStore`, () => {
		test('should create once, and replace only the version it was given', async () => {
			const store = await open()

			expect(await store.put(record(), 0)).toBe(true)
			expect(await store.put(record(), 0)).toBe(false)
			expect(await store.put(record({ data: { status: 'proposed' } }), 2)).toBe(
				false
			)
			expect(await store.put(record({ data: { status: 'proposed' } }), 1)).toBe(
				true
			)
			expect(await store.get('change-plan', 'plan-1')).toMatchObject({
				version: 2,
				data: { status: 'proposed' }
			})
			expect(await store.get('turn-dataset', 'plan-1')).toBeNull()
		})

		test('should let one of two writers of the same version win', async () => {
			const store = await open()
			await store.put(record(), 0)

			const results = await Promise.all([
				store.put(record({ data: { by: 'first' } }), 1),
				store.put(record({ data: { by: 'second' } }), 1)
			])

			expect(results.filter(Boolean)).toHaveLength(1)
		})

		test("should list a thread's records of one kind, and delete by thread and by expiry", async () => {
			const store = await open()
			await store.put(record({ id: 'a' }), 0)
			await store.put(
				record({ id: 'b', expiresAt: new Date('2026-01-01T00:00:00Z') }),
				0
			)
			await store.put(record({ id: 'c', threadId: 'thread-2' }), 0)
			await store.put(record({ id: 'd', kind: 'turn-dataset' }), 0)

			expect(
				(await store.list('change-plan', 'thread-1')).map((stored) => stored.id)
			).toEqual(['a', 'b'])
			expect(await store.deleteExpired(new Date('2026-06-01T00:00:00Z'))).toBe(
				1
			)
			expect(await store.deleteThread('thread-1')).toBe(2)
			expect(
				(await store.list('change-plan', 'thread-2')).map((stored) => stored.id)
			).toEqual(['c'])
		})
	})
}

recordStoreContract('createMemoryRecordStore', async () =>
	createMemoryRecordStore()
)

describe('createMemoryRecordStore', () => {
	test('should copy values in and out', async () => {
		const store = createMemoryRecordStore()
		const data = { status: 'draft' }
		await store.put(record({ data }), 0)
		data.status = 'edited'

		const read = await store.get('change-plan', 'plan-1')
		;(read?.data as { status: string }).status = 'edited again'

		expect((await store.get('change-plan', 'plan-1'))?.data).toEqual({
			status: 'draft'
		})
	})
})
