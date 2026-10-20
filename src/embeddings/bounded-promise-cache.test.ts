import { describe, expect, mock, test } from 'bun:test'
import { BoundedPromiseCache } from './bounded-promise-cache'

function createCache() {
	return new BoundedPromiseCache<string, string>({
		freshMs: 5 * 60_000,
		maxEntries: 500
	})
}

describe('BoundedPromiseCache', () => {
	test('shares an in-flight load between prewarm and session connect', async () => {
		const cache = createCache()
		const loadGreeting = mock(async () => 'Welcome to Acme')

		const prewarm = cache.getOrLoad('agent:default', loadGreeting)
		const connect = cache.getOrLoad('agent:default', loadGreeting)
		const [prewarmedGreeting, connectedGreeting] = await Promise.all([
			prewarm,
			connect
		])

		expect(connectedGreeting).toBe(prewarmedGreeting)
		expect(loadGreeting).toHaveBeenCalledTimes(1)
	})

	test('has reports a live entry without starting a load', async () => {
		const cache = createCache()
		expect(cache.has('agent:default')).toBe(false)

		const pending = cache.getOrLoad('agent:default', async () => 'Welcome')
		expect(cache.has('agent:default')).toBe(true)
		await pending
		expect(cache.has('agent:default')).toBe(true)
	})

	test('evicts a rejected load so the next connect can retry', async () => {
		const cache = createCache()
		let attempts = 0
		const loadGreeting = mock(async () => {
			attempts += 1
			if (attempts === 1) throw new Error('temporary database failure')
			return 'Hello again'
		})

		await expect(
			cache.getOrLoad('agent:default', loadGreeting)
		).rejects.toThrow('temporary database failure')
		await expect(cache.getOrLoad('agent:default', loadGreeting)).resolves.toBe(
			'Hello again'
		)
		expect(loadGreeting).toHaveBeenCalledTimes(2)
	})

	test('serveStale: false pays the reload instead of taking the stale value', () => {
		// An owner edits the tone. Invalidation only reaches the API process, so
		// the worker's own entry decides when the edit goes live. Voice keeps the
		// stale value (first audio must not wait); written channels must not.
		let now = 0
		const channel = () => {
			let loads = 0
			return {
				cache: new BoundedPromiseCache<string, number>({
					freshMs: 100,
					staleMs: 10_000,
					maxEntries: 10,
					now: () => now
				}),
				load: () => Promise.resolve(++loads)
			}
		}
		const voice = channel()
		const written = channel()

		return (async () => {
			expect(await voice.cache.getOrLoad('k', voice.load)).toBe(1)
			expect(await written.cache.getOrLoad('k', written.load)).toBe(1)

			// Past the fresh window, still inside the stale one.
			now = 500

			expect(
				await voice.cache.getOrLoad('k', voice.load, { serveStale: true })
			).toBe(1)
			expect(
				await written.cache.getOrLoad('k', written.load, { serveStale: false })
			).toBe(2)
		})()
	})
})
