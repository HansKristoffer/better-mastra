/**
 * The server-side records a turn leaves behind: change plans waiting for the
 * user, the rows a data tool registered. One small port with compare-and-set,
 * so an app's own store is a few methods and every rule built on it (a
 * plan's claim, its lease, its caps) lives here, tested once.
 */

/** One stored record. `version` starts at 1 and grows by one on every write. */
export interface ChatRecord<T = unknown> {
	/** What the record is, such as `change-plan` or `turn-dataset`. */
	readonly kind: string
	readonly id: string
	/** The thread the record belongs to; deleted with it. */
	readonly threadId: string
	/** The memory resource of that thread: a caller reads only its own. */
	readonly resourceId: string
	readonly version: number
	/** When `deleteExpired` may remove it; null keeps it for the thread's life. */
	readonly expiresAt: Date | null
	readonly data: T
}

/**
 * Where records live. `put` is the only write and must be atomic: it creates
 * the record when `expectedVersion` is 0 and none exists, or replaces the one
 * stored at exactly `expectedVersion`, and answers false otherwise.
 */
export interface ChatRecordStore {
	get(kind: string, id: string): Promise<ChatRecord | null>
	put(record: ChatRecord, expectedVersion: number): Promise<boolean>
	/** The thread's records of one kind, oldest first. */
	list(kind: string, threadId: string): Promise<readonly ChatRecord[]>
	/** Removes every record of the thread, of every kind; how many. */
	deleteThread(threadId: string): Promise<number>
	/** Removes every record whose `expiresAt` is before `before`; how many. */
	deleteExpired(before: Date): Promise<number>
}

/**
 * Records in this process's memory, for tests, evals and a single instance.
 * Values are copied in and out, as a database would, so a caller that edits
 * what it read never edits what is stored.
 */
export function createMemoryRecordStore(): ChatRecordStore {
	const records = new Map<string, ChatRecord>()
	const keyOf = (kind: string, id: string) => `${kind}\0${id}`
	const copy = (record: ChatRecord): ChatRecord => structuredClone(record)

	return {
		async get(kind, id) {
			const record = records.get(keyOf(kind, id))

			return record ? copy(record) : null
		},
		async put(record, expectedVersion) {
			const key = keyOf(record.kind, record.id)
			const stored = records.get(key)
			const matches =
				expectedVersion === 0
					? stored === undefined
					: stored?.version === expectedVersion

			if (!matches) return false

			records.set(key, copy({ ...record, version: expectedVersion + 1 }))

			return true
		},
		async list(kind, threadId) {
			return [...records.values()]
				.filter(
					(record) => record.kind === kind && record.threadId === threadId
				)
				.map(copy)
		},
		async deleteThread(threadId) {
			return deleteWhere(records, (record) => record.threadId === threadId)
		},
		async deleteExpired(before) {
			return deleteWhere(
				records,
				(record) => record.expiresAt !== null && record.expiresAt < before
			)
		}
	}
}

function deleteWhere(
	records: Map<string, ChatRecord>,
	matches: (record: ChatRecord) => boolean
): number {
	let deleted = 0

	for (const [key, record] of records) {
		if (matches(record)) {
			records.delete(key)
			deleted += 1
		}
	}

	return deleted
}
