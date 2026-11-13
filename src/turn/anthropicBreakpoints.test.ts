import { afterEach, describe, expect, test } from 'bun:test'

import { anthropicRoute } from '../models/providers/anthropic.js'
import { stubFetch } from '../models/stub-fetch.test.js'
import { createHarness, readTurn, userMessage } from './turnFixtures.test.js'

/** Anthropic refuses a request with more: the top-level `cache_control` takes one of the four slots. */
const ANTHROPIC_MAX_BREAKPOINTS = 4

function countBlockMarkers(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce<number>((sum, item) => sum + countBlockMarkers(item), 0)
	}

	if (value === null || typeof value !== 'object') return 0

	return Object.entries(value).reduce(
		(sum, [key, child]) =>
			sum + (key === 'cache_control' ? 1 : countBlockMarkers(child)),
		0
	)
}

describe('the chat turn on the direct Anthropic route', () => {
	let fetchStub: ReturnType<typeof stubFetch> | undefined

	afterEach(() => fetchStub?.restore())

	test.each([
		['one stable instruction block', 'Rules.'],
		['two stable instruction blocks', ['Rules.', 'Workspace facts.']]
	] as const)(
		'should send at most four cache breakpoints with %s and a signal',
		async (_name, instructions) => {
			// Given a turn on Claude through Anthropic's own API, whose request is captured
			fetchStub = stubFetch(() => new Response('{}', { status: 400 }))
			const model = anthropicRoute('test-key').model('claude-sonnet-5-5')
			const harness = createHarness({
				overrides: {
					prepare: async ({ scope, threadKey }) => {
						const { requestContext } = await import('./turnFixtures.test.js')

						return {
							requestContext: requestContext.create(scope, threadKey),
							plan: {
								instructions,
								signal: 'Now on the budget page.',
								model,
								maxSteps: 2
							}
						}
					}
				}
			})

			// When the user asks
			await readTurn(await harness.run({ messages: [userMessage('Hvad nu?')] }))

			// Then the request stays within Anthropic's limit, the automatic breakpoint included
			const [body] = fetchStub.bodies()
			const { cache_control: automatic, ...blocks } = body ?? {}

			expect(body).toBeDefined()
			expect(
				countBlockMarkers(blocks) + (automatic === undefined ? 0 : 1)
			).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS)
		}
	)
})
