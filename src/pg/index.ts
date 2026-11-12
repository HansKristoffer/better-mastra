import { PostgresStore, PostgresStoreVNext } from '@mastra/pg'
import { Pool } from 'pg'
import { errorAttributes, silentLogger } from '../models/route.js'
import {
	initWithRetry,
	type MastraStorage,
	type PgStorageOptions
} from '../runtime/storage.js'
import { asMastraStorage } from '../runtime/type-bridge.js'

export type { MastraStorage, PgStorageOptions } from '../runtime/storage.js'

/**
 * What `pgStorage` returns: `MastraStorage`, and the same store typed as
 * `@mastra/pg` made it.
 */
export type PgStorage<
	TStore extends PostgresStore | PostgresStoreVNext = PostgresStoreVNext
> = MastraStorage & {
	/**
	 * `store` itself, typed as `@mastra/pg`'s class, for code that names that
	 * type. `store` stays typed as `@mastra/core`'s, which `new Mastra` and
	 * `createMemory` take even where `@mastra/pg` resolves another copy of
	 * `@mastra/core` than the app's.
	 */
	readonly postgres: TStore
}

/** Probes an idle connection after this long, so a quiet socket is not severed on the way. */
const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000

function positiveInteger(name: string, value: number) {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer, got "${value}"`)
	}
	return value
}

/**
 * Mastra storage on Postgres, in its own schema, on pools that survive a
 * dropped connection: keep-alive on, and an idle client the network severs
 * is logged instead of becoming an unhandled error. Table creation is off;
 * `init()` creates and migrates once at startup. Synchronous: pools connect
 * on first query. Needs `@mastra/pg` and `pg`.
 */
export function pgStorage(
	options: PgStorageOptions & { observabilitySchema: false }
): PgStorage<PostgresStore>
export function pgStorage(
	options: PgStorageOptions & { observabilitySchema?: string }
): PgStorage
export function pgStorage(
	options: PgStorageOptions
): PgStorage<PostgresStore | PostgresStoreVNext>
export function pgStorage(
	options: PgStorageOptions
): PgStorage<PostgresStore | PostgresStoreVNext> {
	const logger = options.logger ?? silentLogger
	const id = options.id ?? 'mastra'
	const schemaName = options.schema ?? 'mastra'
	const observabilitySchema =
		options.observabilitySchema === false
			? undefined
			: (options.observabilitySchema ?? 'mastra_observability')
	const poolMax = positiveInteger('poolMax', options.poolMax ?? 5)
	const owned: Pool[] = []

	const createPool = (name: string, max: number) => {
		const pool = new Pool({
			connectionString: options.connectionString,
			max,
			keepAlive: true,
			keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
			...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
			...(options.connectionTimeoutMillis !== undefined
				? { connectionTimeoutMillis: options.connectionTimeoutMillis }
				: {})
		})
		pool.on('error', (error) => {
			logger.warn('Idle database connection dropped', {
				pool: name,
				...errorAttributes(error)
			})
		})
		owned.push(pool)
		return pool
	}

	const pool = options.pool ?? createPool(schemaName, poolMax)
	const observabilityPool =
		observabilitySchema === undefined
			? undefined
			: options.pool
				? options.pool
				: createPool(
						observabilitySchema,
						Math.min(
							poolMax,
							positiveInteger(
								'observabilityPoolMax',
								options.observabilityPoolMax ?? 2
							)
						)
					)

	const createStore = (disableInit: boolean) => {
		const config = {
			id,
			pool,
			schemaName,
			disableInit,
			...(options.retention ? { retention: options.retention } : {})
		}
		return observabilityPool && observabilitySchema
			? new PostgresStoreVNext({
					...config,
					observability: {
						pool: observabilityPool,
						schemaName: observabilitySchema
					}
				})
			: new PostgresStore(config)
	}

	const postgres = createStore(true)

	return {
		store: asMastraStorage(postgres),
		postgres,
		init: initWithRetry(() => createStore(false).init()),
		ping: async () => {
			await pool.query('SELECT 1')
		},
		close: async () => {
			await Promise.all(owned.splice(0).map((owned) => owned.end()))
		}
	}
}
