import { createHash } from 'node:crypto'
import { type EmbeddingModel, embed, embedMany as aiEmbedMany } from 'ai'
import {
	backgroundPromise,
	chunkArray,
	normalizeWhitespace,
	pMap
} from 'hanzio'
import { errorAttributes, type Logger, silentLogger } from '../models/route.js'
import { BoundedPromiseCache } from './bounded-promise-cache.js'

/** A shared cache for query embeddings; Redis `get`/`setex` fit as they are. */
export type EmbeddingCache = {
	get: (key: string) => Promise<string | null>
	set: (key: string, value: string, ttlSeconds: number) => Promise<unknown>
}

/** Tokens an embedding call used, with the caller's context. */
export type EmbeddingUsage<TContext> = {
	tokens: number
	modelId: string
	context: TContext | undefined
}

const SHARED_TTL_SECONDS = 24 * 60 * 60
const MEMORY_TTL_MS = 5 * 60 * 1000
const MEMORY_MAX_ENTRIES = 500
const PREWARM_QUERY = 'warmup'

function modelIdOf(model: EmbeddingModel) {
	return typeof model === 'string' ? model : model.modelId
}

/** Case and whitespace do not change what a search query means. */
export function queryEmbeddingCacheKey(
	modelId: string,
	query: string,
	prefix = 'qemb'
) {
	const normalized = normalizeWhitespace(query.toLowerCase())
	const digest = createHash('sha256')
		.update(`${modelId}:${normalized}`)
		.digest('hex')
	return `${prefix}:${digest}`
}

/**
 * Query and document embeddings on one model. `embedQuery` is for the hot
 * path: an in-process cache in front of the shared one, and concurrent calls
 * for one query share a single request. `embedMany` is for indexing: batches
 * of `batchSize` with `concurrency` requests at once, and every vector checked
 * before it is returned. Reuse one embedder per model, so every call reuses
 * the provider's connection.
 */
export function createEmbedder<TContext = undefined>(input: {
	model: EmbeddingModel
	/** Shared query cache (Redis), kept 24 hours. */
	cache?: EmbeddingCache
	/** Prefix of the shared cache keys. */
	cachePrefix?: string
	/** Tokens per call that reached the provider; cache hits cost none. */
	usage?: (usage: EmbeddingUsage<TContext>) => void
	/** Every vector must have this length. */
	dimensions?: number
	batchSize?: number
	concurrency?: number
	logger?: Logger
}) {
	const modelId = modelIdOf(input.model)
	const batchSize = input.batchSize ?? 100
	const concurrency = input.concurrency ?? 3
	const logger = input.logger ?? silentLogger
	const memory = new BoundedPromiseCache<string, number[]>({
		freshMs: MEMORY_TTL_MS,
		maxEntries: MEMORY_MAX_ENTRIES
	})

	function checked(vector: number[]) {
		if (
			vector.length === 0 ||
			(input.dimensions !== undefined && vector.length !== input.dimensions)
		) {
			throw new Error(
				`Embedding has ${vector.length} dimensions, expected ${input.dimensions ?? 'more than 0'}`
			)
		}
		return vector
	}

	function report(tokens: number, context: TContext | undefined) {
		if (tokens > 0) input.usage?.({ tokens, modelId, context })
	}

	async function readShared(key: string) {
		if (!input.cache) return null
		try {
			const raw = await input.cache.get(key)
			if (!raw) return null
			const parsed: unknown = JSON.parse(raw)
			return Array.isArray(parsed) &&
				parsed.length > 0 &&
				parsed.every((value) => typeof value === 'number')
				? (parsed as number[])
				: null
		} catch (error) {
			logger.warn('Query embedding cache read failed', errorAttributes(error))
			return null
		}
	}

	async function embedQuery(value: string, context?: TContext) {
		const key = queryEmbeddingCacheKey(modelId, value, input.cachePrefix)
		let tokens = 0
		let cached = true
		const embedding = await memory.getOrLoad(key, async () => {
			const shared = await readShared(key)
			if (shared) return shared
			cached = false
			const result = await embed({ model: input.model, value })
			tokens = result.usage.tokens ?? 0
			const vector = checked(result.embedding)
			backgroundPromise(async () =>
				input.cache?.set(key, JSON.stringify(vector), SHARED_TTL_SECONDS)
			)
			return vector
		})
		report(tokens, context)
		return { embedding, tokens, cached }
	}

	async function embedMany(values: readonly string[], context?: TContext) {
		const results = await pMap(
			chunkArray(values, batchSize),
			async (batch) => {
				const result = await aiEmbedMany({ model: input.model, values: batch })
				if (result.embeddings.length !== batch.length) {
					throw new Error(
						`Incomplete embedding batch: ${result.embeddings.length} of ${batch.length}`
					)
				}
				const embeddings = result.embeddings.map(checked)
				report(result.usage.tokens ?? 0, context)
				return embeddings
			},
			{ concurrency }
		)
		return results.flat()
	}

	/** Best-effort connection warm, so the first real query skips the handshake. */
	async function prewarm() {
		try {
			await embedQuery(PREWARM_QUERY)
		} catch (error) {
			logger.warn('Embedding connection prewarm failed', errorAttributes(error))
		}
	}

	return {
		modelId,
		embedQuery,
		embedMany,
		prewarm,
		/** Drops the in-process query cache. */
		clearCache: () => memory.clear()
	}
}

export type Embedder<TContext = undefined> = ReturnType<
	typeof createEmbedder<TContext>
>
