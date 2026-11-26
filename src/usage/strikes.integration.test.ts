import { afterAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'

import { bunRedis } from '../resumable/index.js'
import { createAbuseStrikes } from './strikes.js'

const url = process.env.REDIS_URL

describe.skipIf(!url)('createAbuseStrikes on real Redis', () => {
	const client = new RedisClient(url)
	const redis = bunRedis(client)
	afterAll(() => client.close())

	test('should pause a user after the strikes, keep only an HMAC of the id, and let others through', async () => {
		const keyPrefix = `strikes-test:${crypto.randomUUID()}`
		const strikes = createAbuseStrikes({
			runScript: (script, keys, args) => redis.eval!(script, keys, args),
			secret: 'test-secret',
			keyPrefix,
			maxStrikes: 2,
			pauseSeconds: 60
		})

		expect(await strikes.record('user-1', 'harassment')).toEqual({ kind: 'ok' })
		expect(await strikes.check('user-1')).toEqual({ kind: 'ok' })
		const paused = await strikes.record('user-1', 'harassment')
		expect(paused).toMatchObject({ kind: 'paused' })
		expect(await strikes.check('user-1')).toMatchObject({
			kind: 'paused',
			retryAfterSeconds: expect.any(Number)
		})
		expect(await strikes.check('user-2')).toEqual({ kind: 'ok' })

		const keys = (await client.send('KEYS', [`${keyPrefix}*`])) as string[]
		expect(keys.length).toBeGreaterThan(0)
		expect(keys.join(' ')).not.toContain('user-1')
		const categories = keys.find((key) => key.endsWith(':categories'))!
		expect(await client.send('HGETALL', [categories])).toMatchObject({
			harassment: '2'
		})
	})
})
