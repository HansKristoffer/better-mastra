import { expect, test } from 'bun:test'
import { createModelBudget } from './budget'

// The in-process limit stands in for the fleet-wide Redis limit hellu ran these against.
const {
	runModelCall: runWebsiteModelCall,
	runProviderCall: runWebsiteProviderCall,
	readMetrics: readWebsiteModelMetrics,
	withBudget: withWebsiteModelBudget
} = createModelBudget()

test('provider admission records waits, failures and explicit retries without charging nested wrappers twice', async () => {
	await withWebsiteModelBudget(new AbortController().signal, async () => {
		let active = 0
		let peak = 0
		await Promise.all(
			Array.from({ length: 17 }, () =>
				runWebsiteModelCall(() =>
					runWebsiteProviderCall(
						async () => {
							peak = Math.max(peak, ++active)
							await Bun.sleep(10)
							active--
						},
						{ provider: 'openrouter' }
					)
				)
			)
		)
		expect(peak).toBe(16)
		await expect(
			runWebsiteProviderCall(
				async () => {
					throw Object.assign(new Error('provider quota'), {
						statusCode: 429,
						responseHeaders: { 'retry-after': '1' }
					})
				},
				{ provider: 'openrouter' }
			)
		).rejects.toThrow('provider quota')

		let retried = false
		const retry = runWebsiteProviderCall(
			async () => {
				retried = true
			},
			{ provider: 'openrouter', retry: true }
		)
		await Bun.sleep(100)
		expect(retried).toBe(false)
		await retry
		const [metrics] = readWebsiteModelMetrics()
		expect(metrics).toMatchObject({
			provider: 'openrouter',
			calls: 19,
			failed: 1,
			rateLimited: 1,
			retries: 1
		})
		expect(metrics!.admissionMs).toBeGreaterThanOrEqual(900)
		expect(metrics!.executionMs).toBeGreaterThan(0)
	})
})

test('a returned 429 response trips the cooldown and still reaches the caller', async () => {
	await withWebsiteModelBudget(new AbortController().signal, async () => {
		const response = await runWebsiteProviderCall(
			async () =>
				new Response(null, {
					status: 429,
					headers: { 'retry-after': '1' }
				}),
			{ provider: 'decision:typesafe' }
		)
		expect(response.status).toBe(429)

		const startedAt = performance.now()
		await runWebsiteProviderCall(async () => 'next', {
			provider: 'decision:typesafe'
		})
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900)
		expect(readWebsiteModelMetrics()[0]).toMatchObject({
			provider: 'decision:typesafe',
			failed: 1,
			rateLimited: 1
		})
	})
})

test('a provider failure leaves the budget usable for retry', async () => {
	await withWebsiteModelBudget(new AbortController().signal, async () => {
		await expect(
			runWebsiteModelCall(async () => {
				throw new Error('429')
			})
		).rejects.toThrow('429')
		expect(await runWebsiteModelCall(async () => 'retry')).toBe('retry')
	})
})

test('concurrent imports share worker capacity while nested admission stays live', async () => {
	let active = 0
	let peak = 0
	await Promise.all(
		Array.from({ length: 3 }, () =>
			withWebsiteModelBudget(new AbortController().signal, () =>
				Promise.all(
					Array.from({ length: 20 }, () =>
						runWebsiteModelCall(() =>
							runWebsiteModelCall(async () => {
								peak = Math.max(peak, ++active)
								await Bun.sleep(1)
								active--
							})
						)
					)
				)
			)
		)
	)
	expect(peak).toBe(16)
	expect(active).toBe(0)
})

test('an already-aborted import rejects new admission', async () => {
	const controller = new AbortController()
	await withWebsiteModelBudget(controller.signal, async () => {
		controller.abort(new Error('cancelled import'))
		await expect(
			runWebsiteModelCall(async () => 'must not start')
		).rejects.toThrow('cancelled import')
	})
})
