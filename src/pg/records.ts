/**
 * `ChatRecordStore` on Postgres: one table beside Mastra's, holding change
 * plans and turn datasets as JSONB. `put` is one statement, an insert that
 * does nothing on a conflict or an update guarded by the version, so
 * compare-and-set holds across replicas without a transaction.
 */

import type { ChatRecord, ChatRecordStore } from '../tools/records.js'

/** The one call the store makes; a `pg` `Pool` or `Client` has it. */
export interface PgQueryable {
	query(
		text: string,
		values?: unknown[]
	): Promise<{
		readonly rows: Record<string, unknown>[]
		readonly rowCount: number | null
	}>
}

export interface PgRecordStore extends ChatRecordStore {
	/** Creates the table and its indexes if missing; once, in the process that migrates. */
	init(): Promise<void>
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * Records in `schema.table` (default `mastra.better_mastra_records`). Pass
 * the pool the app already has; the store never ends it.
 */
export function pgRecordStore(options: {
	readonly pool: PgQueryable
	readonly schema?: string
	readonly table?: string
}): PgRecordStore {
	const schema = identifier('schema', options.schema ?? 'mastra')
	const table = identifier('table', options.table ?? 'better_mastra_records')
	const name = `"${schema}"."${table}"`
	const { pool } = options

	return {
		async init() {
			await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
			await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
				kind text NOT NULL,
				id text NOT NULL,
				thread_id text NOT NULL,
				resource_id text NOT NULL,
				version integer NOT NULL,
				expires_at timestamptz,
				data jsonb NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (kind, id)
			)`)
			await pool.query(
				`CREATE INDEX IF NOT EXISTS "${table}_thread" ON ${name} (thread_id, kind, created_at)`
			)
			await pool.query(
				`CREATE INDEX IF NOT EXISTS "${table}_expires" ON ${name} (expires_at) WHERE expires_at IS NOT NULL`
			)
		},
		async get(kind, id) {
			const { rows } = await pool.query(
				`SELECT * FROM ${name} WHERE kind = $1 AND id = $2`,
				[kind, id]
			)

			return rows[0] ? toRecord(rows[0]) : null
		},
		async put(record, expectedVersion) {
			const values = [
				record.kind,
				record.id,
				record.threadId,
				record.resourceId,
				expectedVersion + 1,
				record.expiresAt,
				JSON.stringify(record.data)
			]
			const { rowCount } =
				expectedVersion === 0
					? await pool.query(
							`INSERT INTO ${name} (kind, id, thread_id, resource_id, version, expires_at, data)
							VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (kind, id) DO NOTHING`,
							values
						)
					: await pool.query(
							`UPDATE ${name} SET thread_id = $3, resource_id = $4, version = $5, expires_at = $6,
							data = $7::jsonb, updated_at = now() WHERE kind = $1 AND id = $2 AND version = $8`,
							[...values, expectedVersion]
						)

			return rowCount === 1
		},
		async list(kind, threadId) {
			const { rows } = await pool.query(
				`SELECT * FROM ${name} WHERE kind = $1 AND thread_id = $2 ORDER BY created_at, id`,
				[kind, threadId]
			)

			return rows.map(toRecord)
		},
		async deleteThread(threadId) {
			const { rowCount } = await pool.query(
				`DELETE FROM ${name} WHERE thread_id = $1`,
				[threadId]
			)

			return rowCount ?? 0
		},
		async deleteExpired(before) {
			const { rowCount } = await pool.query(
				`DELETE FROM ${name} WHERE expires_at IS NOT NULL AND expires_at < $1`,
				[before]
			)

			return rowCount ?? 0
		}
	}
}

function identifier(label: string, value: string): string {
	if (!IDENTIFIER.test(value)) {
		throw new Error(
			`${label} must be a lowercase SQL identifier, got "${value}"`
		)
	}

	return value
}

function toRecord(row: Record<string, unknown>): ChatRecord {
	return {
		kind: String(row.kind),
		id: String(row.id),
		threadId: String(row.thread_id),
		resourceId: String(row.resource_id),
		version: Number(row.version),
		expiresAt: row.expires_at
			? new Date(row.expires_at as string | Date)
			: null,
		data: row.data
	}
}
