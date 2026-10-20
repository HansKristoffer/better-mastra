import type {
	MastraCompositeStore,
	RetentionConfig
} from '@mastra/core/storage'
import type { Pool, PoolConfig } from 'pg'
import { errorAttributes, type Logger, silentLogger } from '../models/route.js'
import { asMastraStorage } from './type-bridge.js'

/** A Mastra store with the calls a process needs around it. */
export type MastraStorage = {
	/** Never creates tables on its own; call `init()` once, in the process that migrates. */
	store: MastraCompositeStore
	/** Creates or migrates Mastra's tables; retries once when another process ran the same DDL at the same moment. */
	init: () => Promise<void>
	/** A round trip to the database, for a health check. */
	ping: () => Promise<void>
	/** Closes what this preset opened (graceful shutdown). */
	close: () => Promise<void>
}

/** Probes an idle connection after this long, so a quiet socket is not severed on the way. */
const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000

export type PgStorageOptions = (
	| { connectionString: string; pool?: undefined }
	| {
			/** A pool you own and close; this preset never ends it. */
			pool: Pool
			connectionString?: undefined
	  }
) & {
	id?: string
	/** Schema of Mastra's tables. Defaults to `mastra`. */
	schema?: string
	/**
	 * Schema of the observability domain (traces, logs, metrics), on a pool of
	 * its own. Defaults to `mastra_observability`; `false` uses `PostgresStore`
	 * without the v-next observability domain.
	 */
	observabilitySchema?: string | false
	/** The storage pool's size. Defaults to 5; keep it small where connections are scarce. */
	poolMax?: number
	/** The observability pool never grows past this (default 2): it writes in the background. */
	observabilityPoolMax?: number
	ssl?: PoolConfig['ssl']
	connectionTimeoutMillis?: number
	retention?: RetentionConfig
	logger?: Logger
}

/**
 * Two processes creating the same table at once: the loser's `CREATE ... IF
 * NOT EXISTS` trips a unique index on the catalog after the winner commits.
 * Mastra wraps the pg error, so the code is found on the cause chain.
 */
export function isConcurrentDdlError(error: unknown) {
	let current: unknown = error
	for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
		const { code, constraint, message } = current as Error & {
			code?: unknown
			constraint?: unknown
		}
		if (
			code === '23505' &&
			(String(constraint).startsWith('pg_') ||
				/pg_(type|class|namespace)/.test(message))
		) {
			return true
		}
		current = current.cause
	}
	return false
}

/**
 * Runs `init` once per process at a time, and once more after `retryDelayMs`
 * when another process won a race on the same DDL. The failed attempt's other
 * table setups are still finishing on their own connections; retrying beside
 * them deadlocks, hence the wait.
 */
export function initWithRetry(
	init: () => Promise<void>,
	retryDelayMs = 1000
): () => Promise<void> {
	let running: Promise<void> | undefined
	const attempt = async () => {
		try {
			await init()
		} catch (error) {
			if (!isConcurrentDdlError(error)) throw error
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
			await init()
		}
	}
	return () => {
		running ??= attempt().finally(() => {
			running = undefined
		})
		return running
	}
}

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
 * `init()` creates and migrates once at startup. Needs `@mastra/pg` and `pg`.
 */
export async function pgStorage(
	options: PgStorageOptions
): Promise<MastraStorage> {
	const [{ PostgresStore, PostgresStoreVNext }, pg] = await Promise.all([
		import('@mastra/pg'),
		import('pg')
	])
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
		const pool = new pg.Pool({
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

	return {
		store: asMastraStorage(createStore(true)),
		init: initWithRetry(() => createStore(false).init()),
		ping: async () => {
			await pool.query('SELECT 1')
		},
		close: async () => {
			await Promise.all(owned.splice(0).map((owned) => owned.end()))
		}
	}
}

/** Mastra storage on libSQL (a local file or Turso). Needs `@mastra/libsql`. */
export async function libsqlStorage(
	url: string,
	options: { id?: string } = {}
): Promise<MastraStorage> {
	const { LibSQLStore } = await import('@mastra/libsql')
	const store = new LibSQLStore({ id: options.id ?? 'mastra', url })
	return {
		store: asMastraStorage(store),
		init: () => store.init(),
		ping: () => store.init(),
		close: () => store.close()
	}
}
