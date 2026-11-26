import { afterAll, describe } from 'bun:test'
import { Pool } from 'pg'

import { recordStoreContract } from '../tools/records.test.js'
import { pgRecordStore } from './records.js'

const url = process.env.DATABASE_URL
const pool = url ? new Pool({ connectionString: url }) : undefined
let tables = 0

afterAll(async () => {
	await pool?.query('DROP SCHEMA IF EXISTS better_mastra_records_test CASCADE')
	await pool?.end()
})

describe.skipIf(!pool)('pgRecordStore', () => {
	// A table per test, so tests start empty.
	recordStoreContract('pgRecordStore', async () => {
		tables += 1
		const store = pgRecordStore({
			pool: pool!,
			schema: 'better_mastra_records_test',
			table: `records_${tables}`
		})
		await store.init()

		return store
	})
})
