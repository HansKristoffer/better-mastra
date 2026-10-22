import type {
	MastraCompositeStore,
	RetentionConfig
} from '@mastra/core/storage'
import type { Pool, PoolConfig } from 'pg'
import { retry } from 'hanzio'
import type { Logger } from '../models/route.js'

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
	const attempt = () =>
		retry(init, {
			retries: 1,
			delayMs: retryDelayMs,
			shouldRetry: isConcurrentDdlError
		})
	return () => {
		running ??= attempt().finally(() => {
			running = undefined
		})
		return running
	}
}

/**
 * `pgStorage` from `better-mastra/pg`, loaded on call so the root import never
 * needs `@mastra/pg`.
 * @deprecated Import `pgStorage` from `better-mastra/pg`: it is synchronous.
 */
export async function pgStorage(
	options: PgStorageOptions
): Promise<MastraStorage> {
	return (await import('../pg/index.js')).pgStorage(options)
}

/**
 * `libsqlStorage` from `better-mastra/libsql`, loaded on call.
 * @deprecated Import `libsqlStorage` from `better-mastra/libsql`: it is synchronous.
 */
export async function libsqlStorage(
	url: string,
	options: { id?: string } = {}
): Promise<MastraStorage> {
	return (await import('../libsql/index.js')).libsqlStorage(url, options)
}
