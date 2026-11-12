import { describe, expect, test } from 'bun:test'

import { chatErrorResponse } from '../turn/errors.js'
import { classifyChatError } from '../client/errors.js'
import { parseChatTurnBody } from '../turn/body.js'
import {
	chatResumeSchema,
	chatTurnBodySchema,
	clientToolDefSchema,
	defineChatErrors
} from './index.js'
import { z } from 'zod'

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

describe("an app's own body", () => {
	// The server derives the thread, caps the messages, types the resume and adds its fields
	const appBody = chatTurnBodySchema
		.omit({ threadId: true, clientTools: true })
		.extend({
			messages: chatTurnBodySchema.shape.messages.min(1).max(2),
			resume: chatResumeSchema
				.extend({ data: z.object({ ticked: z.array(z.string()) }) })
				.optional(),
			locale: z.enum(['da', 'en'])
		})

	test('should parse with the schema and check every message part', async () => {
		const body = await parseChatTurnBody(appBody, {
			messages: [MESSAGE],
			locale: 'da',
			resume: { runId: 'r1', data: { ticked: ['a'] } }
		})

		expect(body?.locale).toBe('da')
		expect(body?.resume?.data.ticked).toEqual(['a'])
		expect(body?.messages[0]?.parts).toEqual([{ type: 'text', text: 'Hej' }])
	})

	test('should refuse what the schema refuses, and a part the AI SDK does not know', async () => {
		expect(
			await parseChatTurnBody(appBody, { messages: [], locale: 'da' })
		).toBeUndefined()
		expect(
			await parseChatTurnBody(appBody, { messages: [MESSAGE], locale: 'sv' })
		).toBeUndefined()
		// The shape passes `chatTurnBodySchema`; the part itself is not a text part
		expect(
			await parseChatTurnBody(appBody, {
				messages: [{ ...MESSAGE, parts: [{ type: 'text' }] }],
				locale: 'da'
			})
		).toBeUndefined()
	})
})

describe('defineChatErrors', () => {
	const errors = defineChatErrors({
		codes: { workspace_forbidden: 403, chat_model_forbidden: 403 },
		rename: {
			forbidden: 'workspace_forbidden',
			not_found: 'workspace_forbidden'
		}
	})

	test('should list the codes a client can get: the built-in ones it keeps, then its own', () => {
		expect(errors.codes).toEqual([
			'invalid_request',
			'message_too_long',
			'unauthenticated',
			'unavailable',
			'consent_required',
			'turn_in_progress',
			'change_expired',
			'usage_limited',
			'temporarily_unavailable',
			'workspace_forbidden',
			'chat_model_forbidden'
		])
		// A renamed built-in code is not one of the app's codes
		// @ts-expect-error
		errors.status('forbidden')
	})

	test('should give each code its status, and a refusal for the gate', () => {
		expect(errors.status('workspace_forbidden')).toBe(403)
		expect(errors.status('usage_limited')).toBe(429)
		expect(errors.refusal('usage_limited', { retryAfterSeconds: 30 })).toEqual({
			code: 'usage_limited',
			status: 429,
			retryAfterSeconds: 30
		})
	})

	test("should map the renamed built-in refusals, and parse a refusal's body", () => {
		expect(errors.refusals).toEqual({
			forbidden: { code: 'workspace_forbidden', status: 403 },
			not_found: { code: 'workspace_forbidden', status: 403 }
		})
		expect(
			errors.bodySchema.safeParse({ error: 'chat_model_forbidden' }).success
		).toBe(true)
		expect(errors.bodySchema.safeParse({ error: 'forbidden' }).success).toBe(
			false
		)
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
