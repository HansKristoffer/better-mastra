import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { anySignal, startTimer } from 'hanzio'
import { isBatchingModelCalls } from '../models/openrouter-batch.js'

/**
 * Shared capacity for one provider lane, usually across a fleet (a Redis
 * slot limiter): runs `run` once a slot is free, and `tripCooldown` holds new
 * admissions back after a 429.
 */
export type ConcurrencyLimit = (<T>(
	run: () => Promise<T>,
	signal?: AbortSignal
) => Promise<T>) & { tripCooldown: (ms: number) => Promise<void> }

type ProviderMetrics = {
	provider: string
	calls: number
	failed: number
	rateLimited: number
	retries: number
	admissionMs: number
	executionMs: number
	durations: number[]
}

type Scope = {
	run: ReturnType<typeof createPool>
	signal: AbortSignal
	admitted: boolean
	metrics: Map<string, ProviderMetrics>
}

/** A FIFO slot pool; a queued task leaves the queue when its signal aborts. */
function createPool(concurrency: number) {
	let active = 0
	const queue: Array<() => void> = []

	return async <T>(task: () => Promise<T>, signal?: AbortSignal) => {
		signal?.throwIfAborted()
		if (active < concurrency) active++
		else
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					queue.splice(queue.indexOf(admit), 1)
					reject(signal?.reason)
				}
				const admit = () => {
					signal?.removeEventListener('abort', onAbort)
					resolve()
				}
				queue.push(admit)
				signal?.addEventListener('abort', onAbort, { once: true })
			})
		try {
			return await task()
		} finally {
			// Hand the slot straight to the next task, or give it back.
			const next = queue.shift()
			if (next) next()
			else active--
		}
	}
}

/**
 * An in-process `ConcurrencyLimit`: `max` calls at once, and a tripped
 * cooldown delays each call that starts before it ends. Use a fleet-wide
 * (Redis) limit when several processes share one provider quota.
 */
export function localConcurrencyLimit(max: number): ConcurrencyLimit {
	const pool = createPool(max)
	let coolUntil = 0
	const limit = <T>(run: () => Promise<T>, signal?: AbortSignal) =>
		pool(async () => {
			const wait = coolUntil - Date.now()
			if (wait > 0) await sleep(wait, undefined, { signal })
			return run()
		}, signal)
	return Object.assign(limit, {
		tripCooldown: async (ms: number) => {
			coolUntil = Math.max(coolUntil, Date.now() + ms)
		}
	})
}

/** A 429 as the AI SDK throws it (`APICallError`) or any error shaped like it. */
function rateLimitRetryAfter(error: unknown): string | null | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const { statusCode, responseHeaders } = error as {
		statusCode?: unknown
		responseHeaders?: Record<string, string>
	}
	if (statusCode !== 429) return undefined
	return responseHeaders?.['retry-after'] ?? null
}

/**
 * Admission for background model work, apart from interactive turns.
 * `withBudget` opens a job's scope: up to `concurrency` calls of the job run
 * at once, and all jobs in the process share another `concurrency`. Each
 * provider call also takes a slot of its lane's `limit`, and a 429 trips that
 * lane's cooldown for its `retry-after`.
 */
export function createModelBudget(
	input: {
		/** One limit per provider lane; defaults to `localConcurrencyLimit(concurrency)`. */
		limit?: (provider: string) => ConcurrencyLimit
		concurrency?: number
	} = {}
) {
	const concurrency = input.concurrency ?? 16
	const scopes = new AsyncLocalStorage<Scope>()
	const processPool = createPool(concurrency)
	const limits = new Map<string, ConcurrencyLimit>()
	const limitFor = (provider: string) => {
		let limit = limits.get(provider)
		if (!limit) {
			limit = input.limit?.(provider) ?? localConcurrencyLimit(concurrency)
			limits.set(provider, limit)
		}
		return limit
	}

	function withBudget<T>(signal: AbortSignal, run: () => Promise<T>) {
		return scopes.run(
			{
				run: createPool(concurrency),
				signal,
				admitted: false,
				metrics: new Map()
			},
			run
		)
	}

	/**
	 * Nested helpers share a permit instead of acquiring a second one and
	 * deadlocking. A batch run takes none: its calls wait on batch rows, and a
	 * permit held through that wait would cut a stage into batches of sixteen.
	 */
	function runModelCall<T>(request: () => Promise<T>) {
		const scope = scopes.getStore()
		if (!scope || scope.admitted || isBatchingModelCalls()) return request()
		return scope.run(() =>
			processPool(() => {
				scope.signal.throwIfAborted()
				return scopes.run({ ...scope, admitted: true }, request)
			})
		)
	}

	/**
	 * A provider call takes its lane's capacity even inside an admission. A 429
	 * trips the lane's cooldown, whether the SDK threw it or a plain `fetch`
	 * returned it.
	 */
	function runProviderCall<T>(
		request: () => Promise<T>,
		call: {
			provider: string
			signal?: AbortSignal | undefined
			retry?: boolean
		}
	) {
		const scope = scopes.getStore()
		if (!scope) return request()
		const admission = startTimer()
		let stats = scope.metrics.get(call.provider)
		if (!stats) {
			stats = {
				provider: call.provider,
				calls: 0,
				failed: 0,
				rateLimited: 0,
				retries: 0,
				admissionMs: 0,
				executionMs: 0,
				durations: []
			}
			scope.metrics.set(call.provider, stats)
		}
		const metrics = stats
		const limit = limitFor(call.provider)
		const signal = anySignal(scope.signal, call.signal)
		return runModelCall(() =>
			limit(async () => {
				metrics.admissionMs += Math.round(admission())
				const execution = startTimer()
				metrics.calls++
				if (call.retry) metrics.retries++
				const rateLimited = async (retryAfter: string | null | undefined) => {
					metrics.failed++
					metrics.rateLimited++
					const seconds = retryAfter ? Number(retryAfter) : Number.NaN
					const delay = Number.isFinite(seconds)
						? seconds * 1000
						: retryAfter
							? Date.parse(retryAfter) - Date.now()
							: 1000
					await limit.tripCooldown(
						Number.isFinite(delay) ? Math.max(1000, delay) : 1000
					)
				}

				try {
					const result = await request()
					if (result instanceof Response && result.status === 429) {
						await rateLimited(result.headers.get('retry-after'))
					}
					return result
				} catch (error) {
					const retryAfter = rateLimitRetryAfter(error)
					if (retryAfter !== undefined) await rateLimited(retryAfter)
					else metrics.failed++
					throw error
				} finally {
					const duration = Math.round(execution())
					metrics.executionMs += duration
					if (metrics.durations.length < 10_000)
						metrics.durations.push(duration)
				}
			}, signal)
		)
	}

	/** The scope's per-provider numbers. Sums are call time, not wall time: calls overlap. */
	function readMetrics() {
		return [...(scopes.getStore()?.metrics.values() ?? [])].map(
			({ durations, ...stats }) => {
				const sorted = [...durations].sort((a, b) => a - b)
				const percentile = (p: number) =>
					sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0
				return { ...stats, p50Ms: percentile(0.5), p90Ms: percentile(0.9) }
			}
		)
	}

	return { withBudget, runModelCall, runProviderCall, readMetrics }
}

export type ModelBudget = ReturnType<typeof createModelBudget>
