import { afterAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'

import { bunRedis } from '../resumable/index.js'
import { createSpendLimit } from './spend.js'

const url = process.env.REDIS_URL

describe.skipIf(!url)('createSpendLimit on real Redis', () => {
	const client = new RedisClient(url)
	const redis = bunRedis(client)
	afterAll(() => client.close())

	test('should refuse once a window reached its limit, per user, and keep the id out of the keys', async () => {
		const keyPrefix = `spend-test:${crypto.randomUUID()}`
		const spend = createSpendLimit({
			runScript: (script, keys, args) => redis.eval!(script, keys, args),
			secret: 'test-secret',
			keyPrefix,
			windows: [
				{ name: 'day', seconds: 86_400, limitUsd: 2 },
				{ name: 'month', seconds: 2_592_000, limitUsd: 20 }
			]
		})

		await spend.record('user-1', 1.5)
		expect(await spend.admit('user-1')).toEqual({ kind: 'admitted' })

		await spend.record('user-1', 0.500_001)
		await spend.record('user-1', null)
		expect(await spend.admit('user-1')).toMatchObject({
			kind: 'limited',
			retryAfterSeconds: expect.any(Number)
		})
		expect(await spend.admit('user-2')).toEqual({ kind: 'admitted' })

		const keys = (await client.send('KEYS', [`${keyPrefix}*`])) as string[]
		expect(keys).toHaveLength(2)
		expect(keys.join(' ')).not.toContain('user-1')
	})
})
