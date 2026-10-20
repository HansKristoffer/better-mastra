import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { MockEmbeddingModelV4 } from 'ai/test'
import { createEmbedder, type EmbeddingUsage } from './embedder'

const doEmbed = mock(async ({ values }: { values: string[] }) => ({
	embeddings: values.map(() => [0.1, 0.2, 0.3]),
	usage: { tokens: 8 * values.length },
	warnings: []
}))
const model = new MockEmbeddingModelV4({
	modelId: 'text-embedding-3-small',
	maxEmbeddingsPerCall: 100,
	doEmbed: doEmbed as never
})
const cacheGet = mock(async () => null as string | null)
const cacheSet = mock(async () => 'OK')
const usage: EmbeddingUsage<string>[] = []

function embedder(options: Partial<Parameters<typeof createEmbedder>[0]> = {}) {
	return createEmbedder<string>({
		model,
		cache: { get: cacheGet, set: cacheSet },
		usage: (entry) => usage.push(entry),
		...options
	})
}

beforeEach(() => {
	doEmbed.mockClear()
	cacheGet.mockReset()
	cacheGet.mockResolvedValue(null)
	cacheSet.mockClear()
	usage.length = 0
})

describe('embedQuery', () => {
	test('calls the model on a miss, writes the shared cache and reports the tokens', async () => {
		const result = await embedder().embedQuery('åbningstider', 'org_1')
		expect(result).toEqual({
			embedding: [0.1, 0.2, 0.3],
			tokens: 8,
			cached: false
		})
		expect(doEmbed).toHaveBeenCalledTimes(1)
		expect(cacheSet).toHaveBeenCalledTimes(1)
		expect(usage).toEqual([
			{ tokens: 8, modelId: 'text-embedding-3-small', context: 'org_1' }
		])
	})

	test('returns a shared-cache hit without calling the model', async () => {
		cacheGet.mockResolvedValueOnce(JSON.stringify([0.9, 0.8]))
		const result = await embedder().embedQuery('contact hours')
		expect(result).toEqual({ embedding: [0.9, 0.8], tokens: 0, cached: true })
		expect(doEmbed).not.toHaveBeenCalled()
		expect(usage).toEqual([])
	})

	test('the in-process cache skips the shared cache and the model on the second call', async () => {
		const queries = embedder()
		await queries.embedQuery('same query')
		const second = await queries.embedQuery('same query')
		expect(second).toMatchObject({ cached: true, tokens: 0 })
		expect(doEmbed).toHaveBeenCalledTimes(1)
		expect(cacheGet).toHaveBeenCalledTimes(1)
	})

	test('normalizes whitespace and case in the cache key', async () => {
		const queries = embedder()
		await queries.embedQuery('  Opening   Hours ')
		const second = await queries.embedQuery('opening hours')
		expect(second.cached).toBe(true)
		expect(doEmbed).toHaveBeenCalledTimes(1)
	})
})

describe('embedMany', () => {
	test('embeds in batches, keeps the order and reports each batch', async () => {
		const values = Array.from({ length: 5 }, (_, index) => `doc ${index}`)
		const vectors = await embedder({ batchSize: 2 }).embedMany(values)
		expect(vectors).toHaveLength(5)
		expect(doEmbed.mock.calls.map(([call]) => call.values)).toEqual([
			['doc 0', 'doc 1'],
			['doc 2', 'doc 3'],
			['doc 4']
		])
		expect(usage.map((entry) => entry.tokens)).toEqual([16, 16, 8])
	})

	test('refuses vectors of the wrong size', async () => {
		await expect(
			embedder({ dimensions: 1536 }).embedMany(['doc'])
		).rejects.toThrow('Embedding has 3 dimensions, expected 1536')
	})
})
