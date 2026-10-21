import { describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { libsqlStorage } from '../libsql/index'
import { pgStorage } from '../pg/index'
import {
	initWithRetry,
	isConcurrentDdlError,
	libsqlStorage as libsqlStorageAsync,
	pgStorage as pgStorageAsync
} from './storage'

const CONNECTION = 'postgresql://user:secret@db.test.invalid:5432/app'

type PgInternals = {
	disableInit: boolean
	schema: string
	pool: Pool & { options: Record<string, unknown> }
}

describe('pgStorage', () => {
	test('builds a store in the mastra schema with table creation off, on keep-alive pools', async () => {
		const storage = pgStorage({ connectionString: CONNECTION })
		const store = storage.store as unknown as PgInternals

		expect(store).toEqual(
			expect.objectContaining({ disableInit: true, schema: 'mastra' })
		)
		expect(store.pool.options).toEqual(
			expect.objectContaining({
				connectionString: CONNECTION,
				max: 5,
				keepAlive: true,
				keepAliveInitialDelayMillis: 10_000
			})
		)
		await storage.close()
	})

	test.each([0, -1, 2.5])('refuses a pool size of %p', (poolMax) => {
		expect(() => pgStorage({ connectionString: CONNECTION, poolMax })).toThrow(
			`poolMax must be a positive integer, got "${poolMax}"`
		)
	})

	test('never ends a pool the caller owns', async () => {
		const pool = new Pool({ connectionString: CONNECTION })
		const storage = pgStorage({ pool, observabilitySchema: false })
		await storage.close()
		expect(pool.ending).toBe(false)
		await pool.end()
	})

	test.skipIf(!process.env.DATABASE_URL)(
		'creates the tables, answers a ping and closes',
		async () => {
			// Two processes starting at once race on the same DDL.
			const options = {
				connectionString: process.env.DATABASE_URL!,
				schema: 'better_mastra_test',
				observabilitySchema: 'better_mastra_test_observability'
			}
			const [first, second] = [pgStorage(options), pgStorage(options)]
			await Promise.all([first.init(), second.init(), first.init()])
			await first.ping()
			await Promise.all([first.close(), second.close()])
		},
		30_000
	)
})

describe('root async presets', () => {
	test('still resolve to the same stores', async () => {
		const pg = await pgStorageAsync({ connectionString: CONNECTION })
		expect((pg.store as unknown as PgInternals).schema).toBe('mastra')
		await pg.close()
		const libsql = await libsqlStorageAsync('file::memory:')
		await libsql.init()
		await libsql.close()
	})
})

describe('libsqlStorage', () => {
	test('creates its tables, answers a ping and closes', async () => {
		const storage = libsqlStorage('file::memory:')
		await storage.init()
		await storage.ping()
		await storage.close()
	})
})

function concurrentDdlError() {
	const pgError = Object.assign(
		new Error(
			'duplicate key value violates unique constraint "pg_type_typname_nsp_index"'
		),
		{ code: '23505', constraint: 'pg_type_typname_nsp_index' }
	)
	return new Error('Storage init failed', { cause: pgError })
}

describe('initWithRetry', () => {
	test('retries once when another process created the same table first', async () => {
		const errors = [concurrentDdlError()]
		let calls = 0
		const init = initWithRetry(async () => {
			calls++
			const error = errors.shift()
			if (error) throw error
		}, 0)

		await init()

		expect(calls).toBe(2)
	})

	test('rethrows any other failure and leaves init retryable', async () => {
		let calls = 0
		const init = initWithRetry(async () => {
			calls++
			if (calls === 1) throw new Error('connection refused')
		}, 0)

		await expect(init()).rejects.toThrow('connection refused')
		await init()
		expect(calls).toBe(2)
	})

	test('recognises the catalog race on the cause chain only', () => {
		expect(isConcurrentDdlError(concurrentDdlError())).toBe(true)
		expect(isConcurrentDdlError(new Error('duplicate key'))).toBe(false)
	})
})
