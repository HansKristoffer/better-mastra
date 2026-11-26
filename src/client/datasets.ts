/**
 * Turn datasets on the client: the rows a display part names by id. They
 * arrive as `data-turn-dataset` parts while the answer streams and are read
 * by id from the chat route for a stored answer, so a table or chart shows
 * the stored rows, never numbers the model typed. Rendering is the app's.
 */

import {
	TURN_DATASET_PART,
	type TurnDatasetView,
	turnDatasetSchema
} from '../protocol/index.js'
import type { ChatFetch } from './fetch.js'

export {
	TURN_DATASET_PART,
	type TurnDatasetColumn,
	type TurnDatasetView
} from '../protocol/index.js'

/** One dataset as a display part draws it. */
export interface DatasetState {
	readonly dataset: TurnDatasetView | undefined
	readonly phase: 'idle' | 'loading'
	/** The server has no such dataset for this thread: deleted, expired, or never registered. */
	readonly missing: boolean
	/** The last load failed before an answer: offer to try again. */
	readonly failed: boolean
}

export interface DatasetStore {
	/** The dataset's state; the same object until it changes. */
	get(datasetId: string): DatasetState
	subscribe(listener: () => void): () => void
	/** Loads the dataset unless it is known; `force` loads it again. */
	load(
		threadId: string,
		datasetId: string,
		options?: { readonly force?: boolean }
	): Promise<void>
	/** Takes the `data-turn-dataset` part; pass it the session's `onData`. */
	onData(part: { readonly type: string; readonly data?: unknown }): void
}

const IDLE: DatasetState = {
	dataset: undefined,
	phase: 'idle',
	missing: false,
	failed: false
}

/** The datasets of a chat: `{api}` is the chat route, as `createChatSession`'s `transport.api`. */
export function createDatasetStore(options: {
	readonly api: string
	/** Usually `createChatFetch(...)`. */
	readonly fetch?: ChatFetch
	readonly credentials?: RequestInit['credentials']
}): DatasetStore {
	const states = new Map<string, DatasetState>()
	const listeners = new Set<() => void>()
	const fetchDataset =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const get = (datasetId: string) => states.get(datasetId) ?? IDLE
	const set = (datasetId: string, change: Partial<DatasetState>) => {
		states.set(datasetId, { ...get(datasetId), ...change })
		for (const listener of [...listeners]) listener()
	}

	return {
		get,
		subscribe(listener) {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		async load(threadId, datasetId, loadOptions) {
			const known = get(datasetId)

			if (
				known.phase === 'loading' ||
				(!loadOptions?.force && (known.dataset || known.missing))
			)
				return

			set(datasetId, { phase: 'loading' })

			try {
				const response = await fetchDataset(
					`${options.api}/${encodeURIComponent(threadId)}/datasets/${encodeURIComponent(datasetId)}`,
					{
						method: 'GET',
						...(options.credentials && { credentials: options.credentials })
					}
				)

				if (response.status === 404) {
					set(datasetId, { phase: 'idle', missing: true, failed: false })
					return
				}

				if (!response.ok) throw new Error(`HTTP ${response.status}`)

				const body = (await response.json()) as { dataset?: unknown }
				set(datasetId, {
					phase: 'idle',
					dataset: turnDatasetSchema.parse(body.dataset),
					missing: false,
					failed: false
				})
			} catch {
				set(datasetId, { phase: 'idle', failed: true })
			}
		},
		onData(part) {
			if (part.type !== TURN_DATASET_PART) return

			const parsed = turnDatasetSchema.safeParse(
				(part.data as { dataset?: unknown } | undefined)?.dataset
			)

			if (parsed.success)
				set(parsed.data.id, {
					dataset: parsed.data,
					missing: false,
					failed: false
				})
		}
	}
}
