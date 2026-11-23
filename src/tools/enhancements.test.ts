import { describe, expect, test } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import {
	CLIENT_ACTION_DISPATCHER_TOOL,
	configureSafeMarkdownIt,
	createChatErrorClassifier,
	defineChatErrors,
	type MarkdownItLike,
	toMessageBlocks
} from '../client/index.js'
import { BoundedPromiseCache } from '../index.js'
import { toEmbeddingCache } from '../resumable/index.js'
import {
	CACHE_MARKER,
	CACHE_MARKER_1H,
	cacheMarkerFor,
	diffPromptPrefixes,
	markConversationForCache
} from '../turn/index.js'
import { admitUserRequest } from '../usage/index.js'
import {
	compactTool,
	createClientActionDispatcherTool,
	createDeferredToolSupport,
	defineTool,
	formatClientActionsSignal,
	truncateModelOutput
} from './index.js'

describe('compactTool on external tools', () => {
	test('strips verbose Zod string regexes while keeping runtime validation intact', async () => {
		const raw = createTool({
			id: 'customer_get',
			description: 'Gets a customer.',
			inputSchema: z.object({
				id: z.string().uuid(),
				email: z.string().email(),
				createdAt: z.string().datetime()
			}),
			execute: async (input) => input
		})

		const compacted = compactTool(raw)
		expect(compactTool(raw)).toBe(compacted) // WeakMap-memoized

		const standard = (
			compacted.inputSchema as unknown as {
				'~standard': {
					jsonSchema: {
						input: (o: { target: string }) => Record<string, unknown>
					}
					validate: (
						v: unknown
					) => { issues?: unknown[] } | Promise<{ issues?: unknown[] }>
				}
			}
		)['~standard']
		const json = standard.jsonSchema.input({ target: 'draft-2020-12' })
		const serialized = JSON.stringify(json)
		expect(serialized).not.toContain('pattern')
		expect(serialized).toContain('date-time')

		// Runtime validation still rejects invalid values
		const invalid = await standard.validate({
			id: 'not-a-uuid',
			email: 'bad',
			createdAt: 'nope'
		})
		expect(invalid.issues?.length).toBeGreaterThan(0)
	})
})

describe('static page-action dispatcher and signal', () => {
	test('provides a single stable tool definition and formats available actions as a per-turn signal', () => {
		const tool = createClientActionDispatcherTool()
		expect(tool.id).toBe(CLIENT_ACTION_DISPATCHER_TOOL)

		const signal = formatClientActionsSignal([
			{
				name: 'filterDeals',
				description: 'Filters the deal list.',
				jsonSchema: {
					type: 'object',
					properties: {
						stage: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]+$' }
					}
				}
			}
		])
		expect(signal).toContain('run_page_action')
		expect(signal).toContain('filterDeals')
		expect(signal).not.toContain('^[0-9a-f-]+$')
		expect(formatClientActionsSignal([])).toBe('')
	})
})

describe('createDeferredToolSupport', () => {
	test('selects native Anthropic deferLoading on direct Anthropic routes and processor mode elsewhere', () => {
		const tool = createTool({
			id: 'billing_list',
			description: 'Lists invoices.',
			inputSchema: z.object({}),
			execute: async () => []
		})
		const entries = [{ name: 'billing_list', tool }]

		const native = createDeferredToolSupport({
			key: 'cat-1',
			entries,
			supportsAnthropicDeferLoading: true
		})
		expect(native.inputProcessors).toEqual([])
		expect(native.tools.search_tools).toBeDefined()
		expect(native.tools.billing_list).toBeDefined()

		const processor = createDeferredToolSupport({
			key: 'cat-1',
			entries,
			supportsAnthropicDeferLoading: false
		})
		expect(processor.inputProcessors).toHaveLength(1)
		expect(Object.keys(processor.tools)).toEqual(['search_tools'])
	})
})

describe('diffPromptPrefixes', () => {
	test('reports zero drift when prefixes match and pinpoints tool/instruction diffs when they diverge', async () => {
		const toolA = createTool({
			id: 'a',
			description: 'A',
			inputSchema: z.object({}),
			execute: async () => 'a'
		})
		const toolB = createTool({
			id: 'b',
			description: 'B',
			inputSchema: z.object({}),
			execute: async () => 'b'
		})
		const toolC = createTool({
			id: 'c',
			description: 'C',
			inputSchema: z.object({}),
			execute: async () => 'c'
		})

		const a = {
			instructions: ['Shared rules', 'Org rules'],
			tools: { a: toolA, b: toolB }
		}
		expect((await diffPromptPrefixes(a, { ...a })).cacheStable).toBe(true)

		const diff = await diffPromptPrefixes(a, {
			instructions: ['Shared rules', 'Other org'],
			tools: { a: toolA, c: toolC }
		})
		expect(diff.cacheStable).toBe(false)
		expect(diff.firstChangedBlockIndex).toBe(1)
		expect(diff.addedTools).toEqual(['c'])
		expect(diff.removedTools).toEqual(['b'])
	})
})

describe('configureSafeMarkdownIt', () => {
	test('disables HTML and images, validates links, and adds safe target/rel attributes', () => {
		const disabled: string[] = []
		const attrs = new Map<string, string>([['href', 'https://example.com']])
		const rules: NonNullable<MarkdownItLike['renderer']>['rules'] = {}
		const md: MarkdownItLike = {
			options: { html: true },
			disable: (rule) => {
				disabled.push(...(Array.isArray(rule) ? rule : [rule]))
			},
			validateLink: () => true,
			renderer: { rules }
		}

		configureSafeMarkdownIt(md, { safeLinks: 'web' })

		expect(md.options?.html).toBe(false)
		expect(disabled).toEqual(['image'])
		expect(md.validateLink('https://example.com')).toBe(true)
		expect(md.validateLink('javascript:alert(1)')).toBe(false)
		expect(md.validateLink('/relative')).toBe(false)

		const token = {
			attrGet: (name: string) => attrs.get(name) ?? null,
			attrSet: (name: string, value: string) => {
				attrs.set(name, value)
			}
		}
		const out = rules.link_open?.(
			[token],
			0,
			{},
			{},
			{
				renderToken: () => '<a>'
			}
		)
		expect(out).toBe('<a>')
		expect(attrs.get('target')).toBe('_blank')
		expect(attrs.get('rel')).toBe('noopener noreferrer nofollow')
	})
})

describe('misc DX and reliability helpers', () => {
	test('createChatErrorClassifier honors renamed change_expired codes', () => {
		const errors = defineChatErrors({
			codes: { approval_stale: 409 },
			rename: { change_expired: 'approval_stale' }
		})
		const classify = createChatErrorClassifier(errors)
		expect(
			classify({ status: 409, body: { error: 'approval_stale' } })
		).toMatchObject({
			code: 'approval_stale',
			expired: true,
			canTryAgain: false
		})
	})

	test('toMessageBlocks optionally includes reasoning, files, and merges text', () => {
		const msg = {
			id: 'm1',
			role: 'assistant' as const,
			parts: [
				{
					type: 'reasoning' as const,
					text: 'Thinking...',
					state: 'done' as const
				},
				{ type: 'text' as const, text: 'Hello ' },
				{ type: 'text' as const, text: 'world' },
				{
					type: 'file' as const,
					url: 'https://example.com/a.pdf',
					mediaType: 'application/pdf'
				}
			]
		}
		const blocks = toMessageBlocks(msg, {
			includeReasoning: true,
			includeFiles: true,
			mergeText: true
		})
		expect(blocks.map((b) => b.kind)).toEqual(['reasoning', 'text', 'file'])
		expect(blocks[1]).toMatchObject({ kind: 'text', text: 'Hello world' })
	})

	test('root exports BoundedPromiseCache, resumable exports toEmbeddingCache, and admitUserRequest accepts redis.eval', async () => {
		const cache = new BoundedPromiseCache<string, number>({
			freshMs: 60_000,
			maxEntries: 2
		})
		expect(await cache.getOrLoad('a', async () => 1)).toBe(1)

		const kv = new Map<string, string>()
		const embCache = toEmbeddingCache({
			get: async (k) => kv.get(k) ?? null,
			set: async (k, v) => {
				kv.set(k, v)
				return 'OK'
			}
		})
		await embCache.set('k', 'v', 60)
		expect(await embCache.get('k')).toBe('v')

		const admitted = await admitUserRequest({
			redis: { eval: async () => 1 },
			secret: 'test-secret',
			keyPrefix: 'app:quota',
			operation: 'chat',
			userId: 'u1',
			windows: [{ name: 'minute', seconds: 60, limit: 5 }]
		})
		expect(admitted).toEqual({ kind: 'admitted' })
	})

	test('defineTool caps oversized model output while keeping full execute output, and memoizes reads per turn until a write runs', async () => {
		let readCalls = 0
		const readTool = defineTool({
			tier: 'read',
			maxModelOutputChars: 40,
			memoizePerTurn: true,
			tool: {
				id: 'items_list',
				description: 'Lists items.',
				inputSchema: z.object({ filter: z.string() }),
				execute: async ({ filter }: { filter: string }) => {
					readCalls += 1
					return { filter, payload: 'x'.repeat(120) }
				}
			}
		})
		const writeTool = defineTool({
			tier: 'write',
			tool: {
				id: 'items_update',
				description: 'Updates items.',
				inputSchema: z.object({}),
				execute: async () => ({ updated: true })
			}
		})

		const ctx = new RequestContext()
		const first = await readTool.tool.execute?.({ filter: 'open' }, {
			requestContext: ctx
		} as never)
		const second = await readTool.tool.execute?.({ filter: 'open' }, {
			requestContext: ctx
		} as never)
		expect(readCalls).toBe(1)
		expect(second).toEqual(first)

		// UI card gets full structured output; model gets truncated text
		expect((first as { payload: string }).payload).toHaveLength(120)
		const modelOut = readTool.tool.toModelOutput?.(first as never) as {
			type: string
			value: string
		}
		expect(modelOut.type).toBe('text')
		expect(modelOut.value).toContain('[Truncated ')
		expect(truncateModelOutput('short', 40)).toBeUndefined()

		// A write in the same turn invalidates the per-turn read cache
		await writeTool.tool.execute?.({}, { requestContext: ctx } as never)
		await readTool.tool.execute?.({ filter: 'open' }, {
			requestContext: ctx
		} as never)
		expect(readCalls).toBe(2)
	})

	test('prompt cache helpers support 1h TTL markers alongside 5m defaults', () => {
		expect(cacheMarkerFor()).toBe(CACHE_MARKER)
		expect(cacheMarkerFor('1h')).toBe(CACHE_MARKER_1H)
		const marked = markConversationForCache(
			[{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
			'1h'
		)
		expect(marked[0]?.providerOptions).toMatchObject({
			anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
			openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } }
		})
	})
})
