import { afterEach, expect, test } from 'bun:test'
import { generateText } from 'ai'
import { capOutputTokens } from '../models/registry'
import { chatCompletion, stubFetch } from '../models/stub-fetch.test'
import { openRouterRoute } from './index'

let restore = () => {}
afterEach(() => restore())

test('builds a routed, capped model synchronously that callers cannot reroute', async () => {
	const fetch = stubFetch(() => Response.json(chatCompletion('Hej')))
	restore = fetch.restore
	const route = openRouterRoute({
		apiKey: 'synthetic-key',
		routing: () => ({ only: ['google-vertex/europe'], allow_fallbacks: false })
	})
	const model = capOutputTokens(
		route.model('anthropic/claude-haiku-5.5'),
		2_048
	)

	await generateText({
		model,
		prompt: 'Hej',
		providerOptions: {
			openrouter: { provider: { only: ['anthropic'] }, models: ['x/y'] }
		}
	})

	const body = fetch.bodies()[0]
	expect(body).toEqual(
		expect.objectContaining({
			model: 'anthropic/claude-haiku-5.5',
			max_tokens: 2_048,
			usage: { include: true },
			provider: { only: ['google-vertex/europe'], allow_fallbacks: false }
		})
	)
	expect(body).not.toHaveProperty('models')
})
