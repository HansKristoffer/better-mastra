import { describe, expect, test } from 'bun:test'

import { createThreadLock } from './lock'
import { bunRedis, type ThreadLockRedis } from './redis'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const quiet = { warn() {} }

/** One Redis shared by every lock made from it, with keys that expire. */
function fakeRedis() {
	const values = new Map<string, { value: string; expiresAt: number }>()
	const state = { down: false }
	const live = (key: string) => {
		const entry = values.get(key)
		if (entry && entry.expiresAt <= Date.now()) values.delete(key)
		return values.get(key)
	}
	const op = async <T>(run: () => T): Promise<T> => {
		if (state.down) throw new Error('redis down')
		return run()
	}
	const redis: ThreadLockRedis = {
		setIfAbsent: (key, value, ttlMs) =>
			op(() => {
				if (live(key)) return false
				values.set(key, { value, expiresAt: Date.now() + ttlMs })
				return true
			}),
		deleteIfEquals: (key, value) =>
			op(() => {
				if (live(key)?.value === value) values.delete(key)
			}),
		expireIfEquals: (key, value, ttlMs) =>
			op(() => {
				const entry = live(key)
				if (entry?.value !== value) return false
				entry.expiresAt = Date.now() + ttlMs
				return true
			})
	}

	return { redis, state, holds: (key: string) => live(key) !== undefined }
}

describe('createThreadLock', () => {
	test('should hold a thread for one turn at a time on every replica, and free it on release', async () => {
		// Given two replicas on one Redis
		const { redis } = fakeRedis()
		const a = createThreadLock({ redis, logger: quiet })
		const b = createThreadLock({ redis, logger: quiet })

		// When one holds the thread
		const release = await a({ threadId: 't' })

		// Then neither replica gets it, and another thread is free
		expect(release).not.toBeNull()
		expect(await a({ threadId: 't' })).toBeNull()
		expect(await b({ threadId: 't' })).toBeNull()
		expect(await b({ threadId: 'other' })).not.toBeNull()

		// And after the release the next turn gets it
		await release?.()
		expect(await b({ threadId: 't' })).not.toBeNull()
	})

	test('should give the thread to one of two claims made at the same moment', async () => {
		const { redis } = fakeRedis()
		const lock = createThreadLock({ redis, logger: quiet })

		const claims = await Promise.all([
			lock({ threadId: 't' }),
			lock({ threadId: 't' })
		])

		expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
	})

	test('should keep a long turn held past the TTL, and let a dead holder expire', async () => {
		// Given a short TTL
		const { redis, holds } = fakeRedis()
		const lock = createThreadLock({ redis, ttlMs: 60, logger: quiet })
		const other = createThreadLock({ redis, ttlMs: 60, logger: quiet })

		// When a turn runs for several TTLs
		await lock({ threadId: 't' })
		await tick(200)

		// Then it still holds the thread
		expect(await other({ threadId: 't' })).toBeNull()

		// And a holder that died without releasing, here one whose key was never renewed, expires
		await redis.setIfAbsent('thread-lock:dead', 'gone', 40)
		await tick(60)
		expect(holds('thread-lock:dead')).toBe(false)
		expect(await other({ threadId: 'dead' })).not.toBeNull()
	})

	test("should leave another holder's claim alone when a release comes after its own expired", async () => {
		// Given a claim that expired because its renewals could not reach Redis
		const { redis, state } = fakeRedis()
		const lock = createThreadLock({ redis, ttlMs: 45, logger: quiet })
		const other = createThreadLock({ redis, ttlMs: 10_000, logger: quiet })
		const release = await lock({ threadId: 't' })
		state.down = true
		await tick(80)
		state.down = false

		// When another replica has taken the thread and the first one releases late
		const taken = await other({ threadId: 't' })
		await release?.()

		// Then the thread is still the second holder's
		expect(taken).not.toBeNull()
		expect(await createThreadLock({ redis })({ threadId: 't' })).toBeNull()
	})

	test('should run the turn under the process lock alone when Redis does not answer', async () => {
		// Given a Redis that is down
		const { redis, state } = fakeRedis()
		const warnings: string[] = []
		const lock = createThreadLock({
			redis,
			logger: { warn: (message) => warnings.push(message) }
		})
		state.down = true

		// When a turn claims its thread
		const release = await lock({ threadId: 't' })

		// Then it runs, a second turn here still waits its turn, and the outage is logged
		expect(release).not.toBeNull()
		expect(await lock({ threadId: 't' })).toBeNull()
		expect(warnings).toContain('thread lock: redis claim failed')
		await release?.()
		expect(await lock({ threadId: 't' })).not.toBeNull()
	})

	test('should lock within one process without Redis', async () => {
		const lock = createThreadLock()

		const release = await lock({ threadId: 't' })

		expect(await lock({ threadId: 't' })).toBeNull()
		await release?.()
		expect(await lock({ threadId: 't' })).not.toBeNull()
	})
})

describe('the thread lock commands of bunRedis', () => {
	test('should claim with SET NX PX and check the owner in a script on release and renewal', async () => {
		// Given a client that records its commands and answers as Redis would
		const sent: string[][] = []
		const redis = bunRedis(
			{
				send: async (command, args) => {
					sent.push([command, ...args])

					return command === 'SET' ? 'OK' : 1
				}
			},
			{ connect: async () => Promise.reject(new Error('not used')) }
		)

		// When the lock's three commands run
		const claimed = await redis.setIfAbsent('k', 'token', 500)
		const renewed = await redis.expireIfEquals('k', 'token', 500)
		await redis.deleteIfEquals('k', 'token')

		// Then the claim is atomic and the other two name the key and the owner's token
		expect([claimed, renewed]).toEqual([true, true])
		expect(sent[0]).toEqual(['SET', 'k', 'token', 'NX', 'PX', '500'])
		expect(sent[1]?.slice(0, 1)).toEqual(['EVAL'])
		expect(sent[1]?.slice(2)).toEqual(['1', 'k', 'token', '500'])
		expect(sent[2]?.slice(2)).toEqual(['1', 'k', 'token'])
	})
})
