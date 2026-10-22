import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { promiseTimeout } from 'hanzio'
import { errorAttributes, type Logger } from './route.js'

// OpenRouter's Batch API as a transport for background generation.
//
// A batch costs half of a direct call and answers within 24 hours (median 7
// minutes, p90 under an hour in OpenRouter's 2026-09 beta numbers). Work
// nobody waits on runs inside `withLlmMode('batch', ...)`; everything else
// calls the direct endpoint.
//
// The batch provider's `fetch` is the whole seam: the AI SDK builds the same
// chat-completions body it would send directly, this module queues it, and
// the batch's answer comes back as the response the SDK would have read. A
// call the batch does not answer rejects with `BatchUnanswered`, and the
// caller sends it again directly. A batch is a discount, never a dependency.

const BATCHES_URL = 'https://openrouter.ai/api/v1/batches'

/** How long a batch run waits on batches before it finishes at full price. */
export const MODEL_BATCH_WINDOW_MS = 3 * 60 * 60 * 1000

/** Calls that arrive this close together share a batch: one stage's fan-out. */
const GATHER_MS = 2_000
/** A steady trickle of calls still sends its batch this soon after the first. */
const MAX_GATHER_MS = 10_000
/** OpenRouter publishes no cap; this keeps one request body a few megabytes. */
const MAX_BATCH_REQUESTS = 1_000
const POLL_MS = 30_000
/**
 * Pools are sized for direct calls. In a batch run a pool of 16 would cut one
 * stage's fan-out into sequential batches of 16, so pools open up to this.
 */
const BATCH_CALL_CONCURRENCY = 1_000

export type LlmMode = 'direct' | 'batch'

export class BatchUnanswered extends Error {
	override name = 'BatchUnanswered'
}

const ResultRowSchema = z.object({
	custom_id: z.string(),
	response: z.object({ status_code: z.number(), body: z.unknown() }).nullish(),
	error: z.unknown().nullish()
})

const BatchSchema = z.object({
	id: z.string(),
	status: z.enum([
		'validating',
		'in_progress',
		'finalizing',
		'completed',
		'failed',
		'expired',
		'cancelling',
		'cancelled'
	]),
	usage: z
		.object({ cost: z.number().nullish(), total_tokens: z.number().nullish() })
		.nullish(),
	results: z.array(ResultRowSchema).nullish()
})

/** The part of a chat-completions answer the cost share reads and writes. */
const AnswerSchema = z.looseObject({
	usage: z.looseObject({ total_tokens: z.number() }).optional()
})

type Batch = z.infer<typeof BatchSchema>

const TERMINAL: readonly Batch['status'][] = [
	'completed',
	'failed',
	'expired',
	'cancelled'
]

type Waiter = {
	body: Record<string, unknown>
	resolve: (answer: unknown) => void
	reject: (error: unknown) => void
}

/** What one batch shares: the model, and an upstream pin when the route has one. */
type BatchRoute = {
	model: string
	provider?: { only: string[]; allow_fallbacks?: boolean | undefined }
}

type Gathering = {
	key: string
	route: BatchRoute
	waiters: Waiter[]
	openedAt: number
	timer?: ReturnType<typeof setTimeout>
}

type BatchScope = {
	/** Past this, new calls go direct and open batches stop being waited on. */
	until: number
	signal: AbortSignal
	gathering: Map<string, Gathering>
}

const scopes = new AsyncLocalStorage<BatchScope>()

/**
 * Formats the batch upstream refused as a schema it cannot read (Gemini's
 * batch rejects `maxLength` on a nullable field its direct API accepts).
 * Calls with such a format go direct for the life of the process.
 */
const refusedFormats = new Set<string>()
const SCHEMA_REFUSAL = /response_json_schema/i
const RowErrorSchema = z.looseObject({ message: z.string() })

/**
 * Runs a job's model calls the way its `mode` asks. In `batch` they go through
 * the batch endpoint for `MODEL_BATCH_WINDOW_MS`, then finish at full price.
 */
export function withLlmMode<T>(
	mode: LlmMode | undefined,
	signal: AbortSignal,
	run: () => Promise<T>
) {
	if (mode !== 'batch') return run()

	const until = Date.now() + MODEL_BATCH_WINDOW_MS
	return withModelBatching({ until, signal }, run)
}

/** Batchable model calls go through the batch endpoint until `until`. */
export function withModelBatching<T>(
	input: { until: number; signal: AbortSignal },
	run: () => Promise<T>
) {
	return scopes.run({ ...input, gathering: new Map() }, run)
}

/** The mode for a job enqueued from here: work a batch run starts runs in batch too. */
export function inheritedLlmMode() {
	return isBatchingModelCalls() ? ('batch' as const) : undefined
}

export function isBatchingModelCalls() {
	const scope = scopes.getStore()
	return !!scope && Date.now() < scope.until
}

/** A pool's width: its direct-call size, or wide open in a batch run. */
export function modelCallConcurrency(direct: number) {
	return isBatchingModelCalls() ? BATCH_CALL_CONCURRENCY : direct
}

const ChatRequestSchema = z.looseObject({
	model: z.string(),
	stream: z.unknown().optional(),
	provider: z
		.looseObject({
			only: z.array(z.string()).optional(),
			allow_fallbacks: z.boolean().optional()
		})
		.optional()
})

/** The `fetch` a batch OpenRouter provider sends with. */
export function createBatchFetch(input: {
	apiKey: string
	logger: Logger
}): typeof fetch {
	const headers = {
		Authorization: `Bearer ${input.apiKey}`,
		'Content-Type': 'application/json'
	}
	const { logger } = input

	async function sendThroughBatch(
		_url: Parameters<typeof fetch>[0],
		init?: RequestInit
	) {
		const scope = scopes.getStore()
		if (!scope || Date.now() >= scope.until)
			throw new BatchUnanswered('No batch window is open')
		if (typeof init?.body !== 'string')
			throw new BatchUnanswered('Only JSON requests can be batched')

		// The batch names the model and routing once, and streaming is not a
		// batch request. A pinned upstream moves to the batch; an order
		// preference is dropped and the batch takes the cheapest upstream.
		const request = ChatRequestSchema.safeParse(JSON.parse(init.body))
		if (!request.success)
			throw new BatchUnanswered('Not a chat-completions request')
		const { model, provider, stream: _stream, ...body } = request.data
		const pinned = provider?.only
			? { only: provider.only, allow_fallbacks: provider.allow_fallbacks }
			: undefined
		const answer = await gather(
			scope,
			{ model, ...(pinned ? { provider: pinned } : {}) },
			body,
			init.signal
		)
		return Response.json(answer)
	}

	function gather(
		scope: BatchScope,
		route: BatchRoute,
		body: Record<string, unknown>,
		signal: AbortSignal | null | undefined
	) {
		// Gemini takes one response format per batch, so each schema is a batch
		// of its own; they run side by side.
		const key = JSON.stringify([route, body.response_format ?? null])
		if (refusedFormats.has(key))
			throw new BatchUnanswered('The batch refuses this response format')

		return new Promise<unknown>((resolve, reject) => {
			signal?.throwIfAborted()
			// Every call of a run shares its signal; a listener left behind per
			// settled call would pile up thousands on it.
			const abort = () => reject(signal?.reason)
			signal?.addEventListener('abort', abort, { once: true })
			const settled = () => signal?.removeEventListener('abort', abort)

			const gathering: Gathering = scope.gathering.get(key) ?? {
				key,
				route,
				waiters: [],
				openedAt: Date.now()
			}
			gathering.waiters.push({
				body,
				resolve: (answer) => {
					settled()
					resolve(answer)
				},
				reject: (error) => {
					settled()
					reject(error)
				}
			})
			scope.gathering.set(key, gathering)

			clearTimeout(gathering.timer)
			const close = () => {
				scope.gathering.delete(key)
				void runBatch(scope, gathering)
			}
			const closesIn = Math.min(
				GATHER_MS,
				gathering.openedAt + MAX_GATHER_MS - Date.now()
			)
			const full = gathering.waiters.length >= MAX_BATCH_REQUESTS
			if (full || closesIn <= 0) close()
			else gathering.timer = setTimeout(close, closesIn)
		})
	}

	async function runBatch(scope: BatchScope, gathering: Gathering) {
		const { route, waiters } = gathering
		const startedAt = Date.now()

		let batch: Batch
		try {
			batch = await completeBatch(scope, route, waiters)
		} catch (error) {
			if (scope.signal.aborted) {
				for (const waiter of waiters) waiter.reject(scope.signal.reason)
				return
			}

			const unanswered =
				error instanceof BatchUnanswered
					? error
					: new BatchUnanswered('The batch did not answer', { cause: error })
			for (const waiter of waiters) waiter.reject(unanswered)
			logger.warn('Model batch unanswered, calling direct', {
				model: route.model,
				requests: waiters.length,
				wait_ms: Date.now() - startedAt,
				...errorAttributes(error)
			})
			return
		}

		const answers = new Map(
			(batch.results ?? []).flatMap((row) =>
				row.response?.status_code === 200
					? [[row.custom_id, withCostShare(row.response.body, batch)] as const]
					: []
			)
		)
		waiters.forEach((waiter, index) => {
			const answer = answers.get(customId(index))
			if (answer !== undefined) waiter.resolve(answer)
			else waiter.reject(new BatchUnanswered('The batch had no answer'))
		})
		void deleteBatch(batch.id)

		// A row that goes direct waited for nothing, so the log says why.
		const unanswered = batch.results?.find(
			(row) => row.response?.status_code !== 200
		)
		const refusal = RowErrorSchema.safeParse(unanswered?.error)
		if (refusal.success && SCHEMA_REFUSAL.test(refusal.data.message))
			refusedFormats.add(gathering.key)
		const unansweredError = unanswered
			? JSON.stringify(unanswered.error ?? unanswered.response?.body ?? null)
			: undefined

		logger.info('Model batch finished', {
			batch_id: batch.id,
			model: route.model,
			status: batch.status,
			requests: waiters.length,
			answered: answers.size,
			wait_ms: Date.now() - startedAt,
			...(batch.usage?.cost != null ? { cost_usd: batch.usage.cost } : {}),
			...(unansweredError
				? { unanswered_error: unansweredError.slice(0, 300) }
				: {})
		})
	}

	/** Resolves with the completed batch; rejects when it will not answer in the window. */
	async function completeBatch(
		scope: BatchScope,
		route: BatchRoute,
		waiters: Waiter[]
	) {
		// Field order matters: the API stream-parses `requests` and answers 400
		// when it comes before `endpoint` and `model`.
		const created = await fetch(BATCHES_URL, {
			method: 'POST',
			headers,
			signal: scope.signal,
			body: JSON.stringify({
				endpoint: '/v1/chat/completions',
				...route,
				requests: waiters.map((waiter, index) => ({
					custom_id: customId(index),
					body: waiter.body
				}))
			})
		})
		if (!created.ok) {
			const reason = (await created.text()).slice(0, 300)
			throw new BatchUnanswered(
				`Batch create returned ${created.status}: ${reason}`
			)
		}
		let batch = BatchSchema.parse(await created.json())

		while (batch.status !== 'completed') {
			if (TERMINAL.includes(batch.status))
				throw new BatchUnanswered(`Batch ${batch.id} ended ${batch.status}`)
			const left = scope.until - Date.now()
			// Abandoned, not cancelled: the API has no cancel, so a batch that
			// answers after this is still billed.
			if (left <= 0)
				throw new BatchUnanswered(`Batch ${batch.id} outlived the batch window`)
			await promiseTimeout(Math.min(POLL_MS, left), { signal: scope.signal })
			batch = (await readBatch(batch.id, scope.signal)) ?? batch
		}
		return batch
	}

	/** A failed poll is retried at the next one; the batch is still running. */
	async function readBatch(id: string, signal: AbortSignal) {
		try {
			const response = await fetch(`${BATCHES_URL}/${id}`, { headers, signal })
			if (!response.ok) return null
			return BatchSchema.parse(await response.json())
		} catch (error) {
			if (signal.aborted) throw error
			return null
		}
	}

	/**
	 * OpenRouter keeps a batch's inputs and results for 30 days; they can carry
	 * customer content, so they go as soon as they are read.
	 */
	async function deleteBatch(id: string) {
		try {
			const response = await fetch(`${BATCHES_URL}/${id}`, {
				method: 'DELETE',
				headers
			})
			if (!response.ok)
				logger.warn('Model batch could not be deleted', {
					batch_id: id,
					status: response.status
				})
		} catch (error) {
			logger.warn('Model batch could not be deleted', {
				batch_id: id,
				...errorAttributes(error)
			})
		}
	}

	// Bun's `fetch` type carries `preconnect`; Node's has none.
	return Object.assign(sendThroughBatch, {
		preconnect: Reflect.get(fetch, 'preconnect')
	}) as unknown as typeof fetch
}

const customId = (index: number) => `r${index}`

/**
 * A batch reports its cost once, not per row. Each answer gets the share its
 * tokens make up, where usage accounting reads a direct call's cost
 * (`usage.cost`): the run's total is exact, its split between calls close.
 */
function withCostShare(body: unknown, batch: Batch) {
	const answer = AnswerSchema.safeParse(body)
	const cost = batch.usage?.cost
	const totalTokens = batch.usage?.total_tokens
	if (!answer.success || !answer.data.usage || cost == null || !totalTokens)
		return body

	const { usage } = answer.data
	return {
		...answer.data,
		usage: { ...usage, cost: (cost * usage.total_tokens) / totalTokens }
	}
}
