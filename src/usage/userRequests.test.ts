import { afterAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'

import { admitUserRequest, type RunRedisScript } from './userRequests.js'

const WINDOWS = [
	{ name: 'minute', seconds: 60, limit: 2 },
	{ name: 'day', seconds: 86_400, limit: 100 }
] as const

function admit(runScript: RunRedisScript, timeoutMs?: number) {
	return admitUserRequest({
		runScript,
		secret: 'secret',
		keyPrefix: 'app:ai-usage',
		operation: 'receipt',
		userId: 'user-1',
		windows: WINDOWS,
		...(timeoutMs !== undefined && { timeoutMs })
	})
}

describe('admitUserRequest', () => {
	test('should charge every window of the operation under a hashed user key', async () => {
		// Given Redis that admits the request
		let call: { keys: readonly string[]; args: readonly unknown[] } | undefined
		const runScript: RunRedisScript = async (_script, keys, args) => {
			call = { keys, args }
			return 1
		}

		// When the request is admitted
		const admission = await admit(runScript)

		// Then each window has its own key, without the user id, in one slot
		expect(admission).toEqual({ kind: 'admitted' })
		expect(call?.keys).toHaveLength(2)
		expect(call?.keys.join()).not.toContain('user-1')
		expect(call?.keys[0]).toMatch(
			/^app:ai-usage:\{[0-9a-f]{64}\}:receipt:minute$/
		)
		expect(call?.args).toEqual([2, 60, 100, 86_400])
	})

	test('should refuse with the seconds until the fullest window has room', async () => {
		const admission = await admit(async () => -42)

		expect(admission).toEqual({ kind: 'limited', retryAfterSeconds: 42 })
	})

	test('should be unavailable when Redis fails or does not answer in time', async () => {
		const failure = new Error('connection refused')

		const failed = await admit(async () => {
			throw failure
		})
		const silent = await admit(() => new Promise(() => {}), 10)

		expect(failed).toEqual({ kind: 'unavailable', error: failure })
		expect(silent.kind).toBe('unavailable')
	})
})

const url = process.env.REDIS_URL

describe.skipIf(!url)('admitUserRequest on real Redis', () => {
	const redis = new RedisClient(url)
	afterAll(() => redis.close())

	test('should admit up to the limit, then refuse without extending the window', async () => {
		// Given a fresh operation with a limit of two a minute
		const operation = `test-${crypto.randomUUID()}`
		const runScript: RunRedisScript = (script, keys, args) =>
			redis.send('EVAL', [
				script,
				String(keys.length),
				...keys,
				...args.map(String)
			])
		const once = () =>
			admitUserRequest({
				runScript,
				secret: 'secret',
				keyPrefix: 'better-mastra-test',
				operation,
				userId: 'user-1',
				windows: WINDOWS
			})

		// When three requests arrive
		const results = [await once(), await once(), await once()]

		// Then the third waits for the minute window
		expect(results.map((result) => result.kind)).toEqual([
			'admitted',
			'admitted',
			'limited'
		])
		const refused = results[2] as { retryAfterSeconds: number }
		expect(refused.retryAfterSeconds).toBeGreaterThan(0)
		expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60)
	})
})
