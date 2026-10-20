import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { extractOpenRouterCostUsd } from '../models/openrouter'
import { withModelBatching } from '../models/openrouter-batch'
import { createLlmRegistry } from '../models/registry'
import { createModelBudget } from './budget'
import { withUsage } from './generate'

const AI_WEBSITE_MODEL = 'google/gemini-3.8-flash'
const llms = await createLlmRegistry({ keys: { openrouter: 'test-key' } })
const budget = createModelBudget()
const { generateObject: aiGenerateObject, generateText: aiGenerateText } =
	withUsage({ llms, sink: () => {}, budget })
const withWebsiteModelBudget = budget.withBudget
const runWebsiteModelCall = budget.runModelCall

const BATCHES_URL = 'https://openrouter.ai/api/v1/batches'
const HOUR = 60 * 60 * 1000

const usage = { organizationId: 'org_test' }

const CapitalSchema = z.object({ capital: z.string() })

type BatchRow = { custom_id: string; body: { messages: { content: string }[] } }
type CreatedBatch = {
	keys: string[]
	body: { endpoint: string; model: string; requests: BatchRow[] }
}

/** The answer is the prompt echoed back, so each call can tell it got its own row. */
function completion(request: BatchRow['body']) {
	const prompt = request.messages.at(-1)?.content ?? ''
	const content =
		'response_format' in request ? `{"capital":"${prompt}"}` : prompt
	return {
		id: `gen-${prompt}`,
		model: AI_WEBSITE_MODEL,
		created: 1,
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content },
				finish_reason: 'stop'
			}
		],
		usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
	}
}

function fakeOpenRouter(
	options: {
		createStatus?: number
		/** Prompts whose batch row comes back as an error. */
		failingRows?: string[]
		/** Every row comes back refused the way Gemini refuses a schema. */
		refuseSchema?: boolean
	} = {}
) {
	const batches: CreatedBatch[] = []
	const direct: string[] = []
	const deleted: string[] = []

	spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const href = String(url)
				const method = init?.method ?? 'GET'

				if (href.endsWith('/chat/completions')) {
					const request = JSON.parse(String(init?.body))
					direct.push(request.messages.at(-1).content)
					return Response.json(completion(request))
				}
				if (href === BATCHES_URL && method === 'POST') {
					const body = JSON.parse(String(init?.body))
					batches.push({ keys: Object.keys(body), body })
					if (options.createStatus)
						return new Response('refused', { status: options.createStatus })
					return Response.json({
						id: `batch-${batches.length}`,
						status: 'validating'
					})
				}

				const id = href.slice(BATCHES_URL.length + 1)
				if (method === 'DELETE') {
					deleted.push(id)
					return Response.json({ deletion: { openrouter: 'deleted' } })
				}
				const { requests } = batches[Number(id.replace('batch-', '')) - 1]!.body
				return Response.json({
					id,
					status: 'completed',
					usage: {
						cost: 0.002 * requests.length,
						total_tokens: 10 * requests.length
					},
					results: requests.map((row) =>
						options.refuseSchema
							? {
									custom_id: row.custom_id,
									response: null,
									error: {
										type: 'invalid_request_error',
										message:
											'Invalid response_json_schema: value at properties.businessContext.anyOf.1.maxLength must be a number'
									}
								}
							: options.failingRows?.includes(row.body.messages.at(-1)!.content)
								? {
										custom_id: row.custom_id,
										response: null,
										error: { message: 'x' }
									}
								: {
										custom_id: row.custom_id,
										response: { status_code: 200, body: completion(row.body) }
									}
					)
				})
			},
			{ preconnect: fetch.preconnect }
		)
	)
	return { batches, direct, deleted }
}

/** Moves the fake clock on until the work settles, letting I/O run in between. */
async function drive<T>(work: Promise<T>) {
	let settled = false
	work.then(
		() => (settled = true),
		() => (settled = true)
	)
	while (!settled) {
		await new Promise((resolve) => setImmediate(resolve))
		jest.advanceTimersByTime(1_000)
	}
	return work
}

function batching<T>(run: () => Promise<T>, until = Date.now() + HOUR) {
	return drive(
		withModelBatching({ until, signal: new AbortController().signal }, run)
	)
}

const capital = (prompt: string) =>
	aiGenerateObject({
		schema: CapitalSchema,
		prompt,
		model: AI_WEBSITE_MODEL,
		usage
	})

beforeEach(() => {
	jest.useFakeTimers()
})

afterEach(() => {
	jest.useRealTimers()
	jest.restoreAllMocks()
})

test('one stage goes out as one batch per answer format and comes back as normal results', async () => {
	const openRouter = fakeOpenRouter()

	const [denmark, sweden, norway] = await batching(() =>
		Promise.all([
			capital('Denmark'),
			capital('Sweden'),
			aiGenerateText({ prompt: 'Norway', model: AI_WEBSITE_MODEL, usage })
		])
	)

	expect(denmark.object).toEqual({ capital: 'Denmark' })
	expect(sweden.object).toEqual({ capital: 'Sweden' })
	expect(norway.text).toBe('Norway')
	expect(openRouter.direct).toEqual([])
	expect(
		openRouter.batches.map((batch) => batch.body.requests.length).sort()
	).toEqual([1, 2])
	// The API stream-parses `requests` and refuses it before `endpoint` and `model`.
	expect(openRouter.batches[0]!.keys).toEqual(['endpoint', 'model', 'requests'])
	expect(openRouter.batches[0]!.body.model).toBe(AI_WEBSITE_MODEL)
	expect(openRouter.batches[0]!.body.requests[0]!.body).not.toHaveProperty(
		'model'
	)
	expect(openRouter.deleted.sort()).toEqual(['batch-1', 'batch-2'])
	// The batch's cost, shared out by tokens, is what usage accounting reads.
	expect(extractOpenRouterCostUsd(denmark)).toBeCloseTo(0.002)
})

test('an import admission budget does not cut a fan-out into batches of sixteen', async () => {
	const openRouter = fakeOpenRouter()
	const countries = Array.from({ length: 40 }, (_, index) => `Country ${index}`)

	await batching(() =>
		withWebsiteModelBudget(new AbortController().signal, () =>
			Promise.all(
				countries.map((country) => runWebsiteModelCall(() => capital(country)))
			)
		)
	)

	expect(openRouter.batches.map((batch) => batch.body.requests.length)).toEqual(
		[40]
	)
})

test('a row the batch did not answer is sent direct', async () => {
	const openRouter = fakeOpenRouter({ failingRows: ['Sweden'] })

	const [denmark, sweden] = await batching(() =>
		Promise.all([capital('Denmark'), capital('Sweden')])
	)

	expect(denmark.object).toEqual({ capital: 'Denmark' })
	expect(sweden.object).toEqual({ capital: 'Sweden' })
	expect(openRouter.direct).toEqual(['Sweden'])
})

test('a refused batch sends every call direct', async () => {
	const openRouter = fakeOpenRouter({ createStatus: 400 })

	const [denmark, sweden] = await batching(() =>
		Promise.all([capital('Denmark'), capital('Sweden')])
	)

	expect([denmark.object, sweden.object]).toEqual([
		{ capital: 'Denmark' },
		{ capital: 'Sweden' }
	])
	expect(openRouter.direct.sort()).toEqual(['Denmark', 'Sweden'])
})

test('once the batch window has closed, calls go direct without a batch', async () => {
	const openRouter = fakeOpenRouter()

	const denmark = await batching(() => capital('Denmark'), Date.now() - 1)

	expect(denmark.object).toEqual({ capital: 'Denmark' })
	expect(openRouter.batches).toEqual([])
	expect(openRouter.direct).toEqual(['Denmark'])
})

test('a response format the batch cannot read goes direct from then on', async () => {
	const openRouter = fakeOpenRouter({ refuseSchema: true })
	const RefusedSchema = CapitalSchema.describe('A schema the batch refuses')
	const refused = (prompt: string) =>
		aiGenerateObject({
			schema: RefusedSchema,
			prompt,
			model: AI_WEBSITE_MODEL,
			usage
		})

	const denmark = await batching(() => refused('Denmark'))
	const sweden = await batching(() => refused('Sweden'))

	expect([denmark.object, sweden.object]).toEqual([
		{ capital: 'Denmark' },
		{ capital: 'Sweden' }
	])
	expect(openRouter.batches).toHaveLength(1)
	expect(openRouter.direct).toEqual(['Denmark', 'Sweden'])
})
