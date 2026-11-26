/**
 * Turn datasets: rows a data tool registers by id, so the numbers the user
 * sees never pass through the model's output. The tool stores its rows and
 * hands the model a short handle (the id, the columns, a count and the app's
 * summary). A display part names the dataset by id, and the rows reach the
 * client from the store: streamed as a transient part when a display tool
 * runs, read by id after a reload. What a table or chart looks like is the
 * app's.
 */

import { randomBytes } from 'node:crypto'
import type { RequestContext } from '@mastra/core/request-context'

import {
	TURN_DATASET_PART,
	type TurnDatasetColumn,
	type TurnDatasetView
} from '../protocol/index.js'
import { isDryRun } from './dryRun.js'
import {
	type ChatRecord,
	type ChatRecordStore,
	createMemoryRecordStore
} from './records.js'
import { ToolRefusal } from './refusal.js'

/** The record kind of a dataset in a `ChatRecordStore`. */
export const TURN_DATASET_KIND = 'turn-dataset'

export type TurnDatasetRow = Readonly<Record<string, unknown>>

export interface TurnDatasetData {
	readonly title?: string
	readonly columns: readonly TurnDatasetColumn[]
	readonly rows: readonly TurnDatasetRow[]
	readonly createdAt: string
}

export type TurnDatasetRecord = ChatRecord<TurnDatasetData>

/** What `runChatTurn` binds to a turn's request context so its tools register and show the thread's datasets. */
export interface TurnDatasetsBinding {
	readonly store: ChatRecordStore
	readonly threadId: string
	readonly resourceId: string
	/** How long a dataset is kept, in ms; null keeps it as long as its thread. Default null. */
	readonly ttlMs?: number | null
	/** Rows one dataset may hold. Default 5,000. */
	readonly maxRows?: number
	readonly now?: () => number
}

/** What a data tool hands the model instead of its rows. */
export interface TurnDatasetHandle {
	readonly datasetId: string
	readonly title?: string
	readonly rowCount: number
	readonly columns: readonly TurnDatasetColumn[]
	/** The app's own words about the rows (totals worked out in code), for the model to talk about. */
	readonly summary?: string
	readonly note: string
}

/** The part of a tool's execution context datasets use. */
export interface DatasetToolContext {
	readonly requestContext?: RequestContext | undefined
	readonly writer?:
		| {
				custom(chunk: {
					type: `data-${string}`
					data: unknown
					transient?: boolean
				}): Promise<void>
		  }
		| undefined
}

const DEFAULT_MAX_ROWS = 5_000

/** What the model reads with every handle. */
export const DATASET_HANDLE_NOTE =
	'The rows are stored under datasetId; you do not see them. To show them, pass datasetId to a display tool. Never type the numbers out yourself.'

const bindings = new WeakMap<object, TurnDatasetsBinding>()
const dryRunBindings = new WeakMap<object, TurnDatasetsBinding>()

/** Gives the turn's tools the thread's datasets. `runChatTurn` calls it when it has `datasets`. */
export function bindTurnDatasets(
	requestContext: object,
	binding: TurnDatasetsBinding
): void {
	bindings.set(requestContext, binding)
}

/**
 * Stores a data tool's rows as a dataset of the thread and returns the
 * handle the tool gives the model in place of the rows. Columns default to
 * the keys of the first row. More rows than `maxRows` are refused with a
 * sentence the model reads, so it narrows its query. In a dry run the
 * dataset stays in memory on the request context.
 */
export async function registerDataset(
	context: DatasetToolContext,
	dataset: {
		readonly rows: readonly TurnDatasetRow[]
		readonly columns?: readonly TurnDatasetColumn[]
		readonly title?: string
		readonly summary?: string
	}
): Promise<TurnDatasetHandle> {
	const binding = bindingOf(context.requestContext)
	const now = binding.now ?? Date.now
	const maxRows = binding.maxRows ?? DEFAULT_MAX_ROWS

	if (dataset.rows.length > maxRows) {
		throw new ToolRefusal(
			`That gave ${dataset.rows.length} rows and a dataset holds at most ${maxRows}. Narrow the query and try again.`
		)
	}

	const columns =
		dataset.columns ??
		Object.keys(dataset.rows[0] ?? {}).map((key) => ({ key }))
	const datasetId = `ds_${randomBytes(6).toString('hex')}`
	const ttlMs = binding.ttlMs ?? null
	const record: TurnDatasetRecord = {
		kind: TURN_DATASET_KIND,
		id: datasetId,
		threadId: binding.threadId,
		resourceId: binding.resourceId,
		version: 0,
		expiresAt: ttlMs === null ? null : new Date(now() + ttlMs),
		data: {
			...(dataset.title !== undefined && { title: dataset.title }),
			columns,
			rows: dataset.rows,
			createdAt: new Date(now()).toISOString()
		}
	}

	if (!(await binding.store.put(record, 0))) {
		throw new Error('The dataset could not be stored: its id is taken.')
	}

	return {
		datasetId,
		...(dataset.title !== undefined && { title: dataset.title }),
		rowCount: dataset.rows.length,
		columns,
		...(dataset.summary !== undefined && { summary: dataset.summary }),
		note: DATASET_HANDLE_NOTE
	}
}

/**
 * The thread's datasets with these ids, streamed to the client as transient
 * `data-turn-dataset` parts when the tool has a writer. An id that is not a
 * dataset of this thread is refused with a sentence the model reads: it may
 * only show rows a tool registered in this conversation.
 */
export async function showDatasets(
	context: DatasetToolContext,
	datasetIds: readonly string[]
): Promise<readonly TurnDatasetView[]> {
	const binding = bindingOf(context.requestContext)
	const shown: TurnDatasetView[] = []

	for (const datasetId of new Set(datasetIds)) {
		const dataset = await readTurnDataset({
			store: binding.store,
			datasetId,
			threadId: binding.threadId
		})

		if (!dataset) {
			throw new ToolRefusal(
				`No dataset has the id ${JSON.stringify(datasetId)} in this conversation. Use a datasetId a tool gave you.`
			)
		}

		shown.push(dataset)
	}

	for (const dataset of shown) {
		await context.writer?.custom({
			type: TURN_DATASET_PART,
			data: { dataset },
			transient: true
		})
	}

	return shown
}

/** A dataset of the thread, as the client renders it; null for none, or one of another thread. */
export async function readTurnDataset(input: {
	readonly store: ChatRecordStore
	readonly datasetId: string
	readonly threadId: string
}): Promise<TurnDatasetView | null> {
	const record = (await input.store.get(
		TURN_DATASET_KIND,
		input.datasetId
	)) as TurnDatasetRecord | null

	if (!record || record.threadId !== input.threadId) return null

	return {
		id: record.id,
		threadId: record.threadId,
		...(record.data.title !== undefined && { title: record.data.title }),
		columns: [...record.data.columns],
		rows: record.data.rows.map((row) => ({ ...row })),
		createdAt: record.data.createdAt
	}
}

function bindingOf(
	requestContext: RequestContext | undefined
): TurnDatasetsBinding {
	if (!requestContext)
		throw new Error('A dataset tool ran without a request context.')

	if (isDryRun(requestContext)) {
		const existing = dryRunBindings.get(requestContext)

		if (existing) return existing

		const binding: TurnDatasetsBinding = {
			store: createMemoryRecordStore(),
			threadId: 'dry-run',
			resourceId: 'dry-run'
		}
		dryRunBindings.set(requestContext, binding)

		return binding
	}

	const binding = bindings.get(requestContext)

	if (!binding) {
		throw new Error(
			'A dataset tool ran outside a turn with datasets: pass `datasets` to runChatTurn.'
		)
	}

	return binding
}
