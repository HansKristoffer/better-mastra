import { describe, expect, test } from 'bun:test'

import { chatErrorResponse } from '../turn/errors.js'
import { classifyChatError } from '../client/errors.js'
import { chatTurnBodySchema, clientToolDefSchema } from './index.js'

const MESSAGE = {
	id: 'm1',
	role: 'user',
	parts: [{ type: 'text', text: 'Hej' }]
}

describe('chatTurnBodySchema', () => {
	test("should take the body the chat session sends, and keep the app's own fields once extended", () => {
		const body = chatTurnBodySchema
			.extend({ timezone: chatTurnBodySchema.shape.threadId })
			.parse({
				threadId: 't1',
				messages: [MESSAGE],
				trigger: 'submit-message',
				timezone: 'Europe/Copenhagen'
			})

		expect(body.messages[0]?.id).toBe('m1')
		expect(body.timezone).toBe('Europe/Copenhagen')
	})

	test('should refuse a message without parts and a client tool no provider takes', () => {
		expect(
			chatTurnBodySchema.safeParse({
				threadId: 't1',
				messages: [{ id: 'm1', role: 'user' }]
			}).success
		).toBe(false)
		expect(
			clientToolDefSchema.safeParse({
				name: 'open screen',
				description: 'Opens a screen.',
				jsonSchema: {}
			}).success
		).toBe(false)
		expect(
			clientToolDefSchema.safeParse({
				name: 'open_screen',
				description: 'Opens a screen.',
				jsonSchema: {}
			}).success
		).toBe(true)
	})
})

describe('a refusal with a retry time', () => {
	test('should reach the client as Retry-After and as retryAfterSeconds', async () => {
		const response = chatErrorResponse({
			code: 'usage_limited',
			status: 429,
			retryAfterSeconds: 41.2
		})
		const body = await response.json()

		expect(response.headers.get('retry-after')).toBe('42')
		expect(classifyChatError({ status: 429, body })).toEqual({
			code: 'usage_limited',
			canTryAgain: true,
			expired: false,
			retryAfterSeconds: 42
		})
	})
})

describe('the web-safe entry points', () => {
	test.each([
		['protocol', ['ai', 'zod']],
		['client', ['ai', 'hanzio', 'zod']]
	])('%s loads no Mastra and no server code', async (subpath, allowed) => {
		const build = await Bun.build({
			entrypoints: [`${import.meta.dir}/../${subpath}/index.ts`],
			target: 'browser',
			packages: 'external',
			metafile: true
		})
		const external = Object.values(build.metafile?.inputs ?? {}).flatMap(
			(input) => input.imports.filter((i) => i.external).map((i) => i.path)
		)

		expect(
			[...new Set(external)].filter(
				(path) =>
					!allowed.some((name) => path === name || path.startsWith(`${name}/`))
			)
		).toEqual([])
	})
})
