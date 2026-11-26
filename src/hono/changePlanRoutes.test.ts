import { describe, expect, test } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import { Hono } from 'hono'
import { z } from 'zod'

import {
	changePlanProgressSchema,
	changePlanSchema
} from '../protocol/index.js'
import {
	bindTurnChangePlan,
	closeTurnChangePlan,
	turnChangePlanId
} from '../tools/changePlans.js'
import { defineTool } from '../tools/defineTool.js'
import { createMemoryRecordStore } from '../tools/records.js'
import { refused } from '../turn/runChatTurn.js'
import type { ChatTurnBody } from '../turn/types.js'
import { createChatRoute } from './chatRoute.js'

function setup() {
	const prices = new Map([['a', 100]])
	const tool = defineTool({
		tool: {
			id: 'prices_raise',
			description: 'Raise.',
			inputSchema: z.object({ id: z.string() })
		},
		tier: 'plan',
		plan: {
			propose: async ({ input }: { input: { id: string } }) => ({
				title: 'Raise a',
				changes: [{ target: input.id, seen: prices.get(input.id), next: 110 }]
			}),
			read: async (id: string) => prices.get(id),
			write: async (id: string, price: number) => {
				prices.set(id, price)
			}
		}
	})
	const store = createMemoryRecordStore()
	const app = new Hono().route(
		'/',
		createChatRoute<string, ChatTurnBody>({
			path: '/chat',
			auth: async (c) => c.req.header('authorization') ?? null,
			parseBody: () => undefined,
			runTurn: async () => refused('invalid_request'),
			ownsThread: async (threadId, auth) =>
				threadId === 'thread-1' && auth === 'user',
			changePlans: {
				store,
				tools: [tool],
				requestContext: () => new RequestContext()
			}
		})
	)
	const proposePlan = async () => {
		const requestContext = new RequestContext()
		bindTurnChangePlan(requestContext, {
			store,
			threadId: 'thread-1',
			resourceId: 'user'
		})
		await tool.tool.execute?.({ id: 'a' } as never, { requestContext } as never)
		await closeTurnChangePlan(requestContext, true)

		return turnChangePlanId(requestContext)!
	}
	const call = (path: string, method = 'POST', auth = 'user') =>
		app.request(
			new Request(`http://test/chat/thread-1/plans/${path}`, {
				method,
				headers: { authorization: auth }
			})
		)

	return { prices, proposePlan, call }
}

describe('createChatRoute with change plans', () => {
	test('should read a plan, apply it with NDJSON progress, then refuse it as closed', async () => {
		const { prices, proposePlan, call } = setup()
		const planId = await proposePlan()

		const read = await call(planId, 'GET')
		expect(
			changePlanSchema.parse(((await read.json()) as { plan: unknown }).plan)
				.status
		).toBe('proposed')

		const applied = await call(`${planId}/apply`)
		expect(applied.headers.get('content-type')).toBe('application/x-ndjson')
		const lines = (await applied.text())
			.trim()
			.split('\n')
			.map((line) => changePlanProgressSchema.parse(JSON.parse(line)))
		expect(lines.map((line) => line.type)).toEqual([
			'step-started',
			'step-applied',
			'finished'
		])
		expect(prices.get('a')).toBe(110)

		const again = await call(`${planId}/apply`)
		expect(again.status).toBe(409)
		expect(await again.json()).toEqual({ error: 'closed' })
	})

	test('should discard a plan, and answer a plan of no thread of the caller as not found', async () => {
		const { prices, proposePlan, call } = setup()
		const planId = await proposePlan()

		expect((await call(`${planId}/apply`, 'POST', 'someone-else')).status).toBe(
			404
		)
		expect((await call('plan_missing', 'GET')).status).toBe(404)
		const discarded = await call(`${planId}/discard`)
		expect(
			((await discarded.json()) as { plan: { status: string } }).plan.status
		).toBe('discarded')
		expect(prices.get('a')).toBe(100)
	})
})
