import { describe, expect, test } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { buildClientActionTools } from './clientActions.js'
import {
	deferredTool,
	deferredToolSearch,
	rankToolsByName
} from './deferredTools.js'
import { defineTool, toToolSet } from './defineTool.js'
import { markDryRun } from './dryRun.js'
import { buildToolManifest, renderToolManifestSource } from './manifest.js'
import { toJsonProjection } from './projection.js'
import { toolInputSchema } from './toolInputSchema.js'

function contextFor(values: Record<string, unknown>): RequestContext {
	return new RequestContext(Object.entries(values))
}

async function run(
	tool: ReturnType<typeof defineTool>['tool'],
	input: unknown,
	requestContext: RequestContext
) {
	return tool.execute?.(input as never, { requestContext } as never)
}

describe('defineTool', () => {
	test('should hide inputs from the model and fill them from the request context', async () => {
		// Given a tool whose workspace comes from the turn
		let received: unknown
		const defined = defineTool({
			tool: {
				id: 'budget_get',
				description: 'Gets the budget.',
				inputSchema: z.object({ workspaceId: z.string(), month: z.string() }),
				execute: async (input: unknown) => {
					received = input
					return { ok: true }
				}
			},
			tier: 'read',
			card: 'budgetSummary',
			hiddenInputs: { workspaceId: (rc) => rc.get('workspaceId' as never) }
		})
		const jsonSchema = defined.tool.inputSchema?.['~standard'].jsonSchema.input(
			{
				target: 'draft-07'
			} as never
		)

		// When the model calls it, even naming another workspace
		await run(
			defined.tool,
			{ month: '2026-10', workspaceId: 'other' },
			contextFor({ workspaceId: 'w-1' })
		)

		// Then the model never saw the input, and the turn's value wins
		expect(
			Object.keys((jsonSchema as { properties: object }).properties)
		).toEqual(['month'])
		expect(received).toEqual({ month: '2026-10', workspaceId: 'w-1' })
		const validated = await defined.tool.inputSchema?.['~standard'].validate({
			month: '2026-10'
		})
		expect(validated?.issues).toBeUndefined()
	})

	test('should validate the input of a tool without hidden inputs once', async () => {
		// Given a tool whose schema counts how often it runs
		let validations = 0
		const defined = defineTool({
			tool: {
				id: 'budget_find',
				description: 'Finds a budget.',
				inputSchema: z.object({
					month: z.string().refine(() => {
						validations += 1
						return true
					})
				}),
				execute: async (input: unknown) => input
			},
			tier: 'read'
		})

		// When the model calls it
		const result = await run(defined.tool, { month: '2026-10' }, contextFor({}))

		// Then the input was validated by the tool the turn runs, and only there
		expect(result).toEqual({ month: '2026-10' })
		expect(validations).toBe(1)
	})

	test('should report an overlong list once when the schema caps it too', () => {
		// Given a write capped both by its schema and by its definition
		const defined = defineTool({
			tool: {
				id: 'budget_setMany',
				description: 'Sets budgets.',
				inputSchema: toolInputSchema(z.object({ ids: z.array(z.string()) }), {
					maxArrayItems: 2
				}),
				execute: async () => ({ ok: true })
			},
			tier: 'approval',
			maxArrayItems: 2
		})

		// When the model sends three
		const result = defined.tool.inputSchema?.['~standard'].validate({
			ids: ['a', 'b', 'c']
		}) as { issues?: readonly unknown[] }

		// Then the cap is reported once
		expect(result.issues).toEqual([
			{ message: 'At most 2 items in one change.', path: ['ids'] }
		])
	})

	test('should wrap a tool made elsewhere, such as orpc-fn createMastraTool', async () => {
		const made = createTool({
			id: 'deals_list',
			description: 'Lists deals.',
			inputSchema: z.object({ stage: z.string() }),
			execute: async ({ stage }) => ({ stage })
		})

		const defined = defineTool({
			tool: made,
			tier: 'approval',
			toModelOutput: (output: { stage: string }) => `Stage ${output.stage}`
		})

		expect(defined.name).toBe('deals_list')
		expect(defined.tool.requireApproval).toBe(true)
		expect(defined.kind).toBe('server')
		expect(await run(defined.tool, { stage: 'won' }, contextFor({}))).toEqual({
			stage: 'won'
		})
		expect(defined.tool.toModelOutput?.({ stage: 'won' })).toEqual({
			type: 'text',
			value: 'Stage won'
		})
	})

	test('should answer with a marker instead of writing in a dry run, but still read', async () => {
		let writes = 0
		const write = defineTool({
			tool: {
				id: 'budget_delete',
				description: 'Deletes.',
				inputSchema: z.object({}),
				execute: async () => ++writes
			},
			tier: 'approval'
		})
		const read = defineTool({
			tool: {
				id: 'budget_get',
				description: 'Reads.',
				inputSchema: z.object({}),
				execute: async () => 'read'
			},
			tier: 'read'
		})
		const requestContext = new RequestContext()
		markDryRun(requestContext)

		expect(await run(write.tool, {}, requestContext)).toMatchObject({
			dryRun: true,
			tool: 'budget_delete'
		})
		expect(await run(read.tool, {}, requestContext)).toBe('read')
		expect(writes).toBe(0)
	})

	test('should make a tool without execute a client tool, and list it in the manifest', () => {
		const definitions = [
			defineTool({
				tool: {
					id: 'openScreen',
					description: 'Opens a screen.',
					inputSchema: z.object({ screen: z.string() })
				},
				tier: 'read',
				card: 'silent'
			}),
			defineTool({
				tool: {
					id: 'budget_set',
					description: 'Sets.',
					inputSchema: z.object({}),
					execute: async () => 1
				},
				tier: 'approval',
				card: 'change',
				invalidates: ['budget'],
				manifest: {
					confirmFields: [{ path: 'amount', format: { kind: 'amount' } }]
				}
			})
		]

		const manifest = buildToolManifest(definitions)

		expect(manifest).toEqual({
			openScreen: {
				kind: 'client',
				tier: 'read',
				card: 'silent',
				invalidates: []
			},
			budget_set: {
				kind: 'server',
				tier: 'approval',
				card: 'change',
				invalidates: ['budget'],
				confirmFields: [{ path: 'amount', format: { kind: 'amount' } }]
			}
		})
		expect(toToolSet(definitions).toolTiers).toEqual({
			openScreen: 'read',
			budget_set: 'approval'
		})
		expect(renderToolManifestSource(manifest)).toContain(
			'export const toolManifest = {'
		)
	})
})

describe('renderToolManifestSource', () => {
	test("should name the kinds in the app's words and write what Biome writes", () => {
		// Given tools the app calls procedures and screen actions
		const definitions = [
			defineTool({
				tool: {
					id: 'budget_set',
					description: 'Sets a budget.',
					inputSchema: z.object({ amount: z.number() }),
					execute: async () => ({ ok: true })
				},
				tier: 'approval',
				card: 'changePlan',
				invalidates: ['budget', 'goals', 'transactions', 'accounts'],
				manifest: {
					confirmFields: [{ path: 'amount', format: { kind: 'amountKr' } }],
					note: 'It\'s the user\'s "own" budget'
				}
			}),
			defineTool({
				tool: {
					id: 'open-screen',
					description: 'Opens a screen.',
					inputSchema: z.object({ to: z.string() })
				},
				tier: 'read'
			})
		]
		const manifest = buildToolManifest(definitions, {
			kind: (definition) =>
				definition.kind === 'client' ? 'screenAction' : 'procedure'
		})

		// When its module is written with the app's type
		const source = renderToolManifestSource(manifest, {
			exportName: 'assistantToolManifest',
			type: { name: 'AssistantToolManifest', from: './toolManifest' }
		})

		// Then the kinds are the app's, and Biome leaves the module as it is
		expect(manifest['budget_set']?.kind).toBe('procedure')
		expect(manifest['open-screen']?.kind).toBe('screenAction')
		expect(source).toContain(
			'export const assistantToolManifest: AssistantToolManifest = {'
		)
		const formatted = Bun.spawnSync(
			['node_modules/.bin/biome', 'format', '--stdin-file-path=manifest.ts'],
			{ stdin: new TextEncoder().encode(source) }
		)
		expect(formatted.stdout.toString()).toBe(source)
	})
})

describe('toolInputSchema', () => {
	test('should offer dates as strings and cap the lists of a write', () => {
		const schema = toolInputSchema(
			z.object({ on: z.date(), ids: z.array(z.string()) }),
			{ maxArrayItems: 2 }
		)
		const json = schema['~standard'].jsonSchema.input({
			target: 'draft-07'
		} as never) as {
			properties: Record<string, Record<string, unknown>>
		}

		expect(json.properties.on).toMatchObject({
			type: 'string',
			format: 'date-time'
		})
		expect(json.properties.ids?.maxItems).toBe(2)
		expect(
			schema['~standard'].validate({ on: '2026-10-20T10:00:00Z', ids: ['a'] })
		).toEqual({
			value: { on: new Date('2026-10-20T10:00:00Z'), ids: ['a'] }
		})
		expect(
			schema['~standard'].validate({
				on: '2026-10-20T10:00:00Z',
				ids: ['a', 'b', 'c']
			})
		).toMatchObject({
			issues: [{ message: 'At most 2 items in one change.' }]
		})
	})
})

describe('toJsonProjection', () => {
	test('should keep plain JSON and drop the omitted keys at any depth', () => {
		expect(
			toJsonProjection(
				{
					at: new Date('2026-10-20T00:00:00Z'),
					account: { iban: 'DK00', name: 'Løn' }
				},
				{ omit: ['iban'] }
			)
		).toEqual({ at: '2026-10-20T00:00:00.000Z', account: { name: 'Løn' } })
		expect(toJsonProjection(undefined)).toBeNull()
	})
})

describe('deferred tools', () => {
	const entries = [
		{
			name: 'workItem_getAll',
			tool: createTool({
				id: 'workItem_getAll',
				description: 'Lists tasks.',
				inputSchema: z.object({})
			})
		},
		{
			name: 'deal_move',
			tool: createTool({
				id: 'deal_move',
				description: 'Moves a deal to another work stage.',
				inputSchema: z.object({})
			})
		}
	]

	test('should rank a name match above a description match', () => {
		expect(rankToolsByName()('get all work items', entries)).toEqual([
			'workItem_getAll',
			'deal_move'
		])
		expect(rankToolsByName(1)('move deal', entries)).toEqual(['deal_move'])
	})

	test('should mark a tool for deferred loading once, and answer a search with tool references', async () => {
		const [first] = entries
		const deferred = deferredTool(first!.tool)
		const search = deferredToolSearch('test-catalog', entries)

		expect(deferred.providerOptions?.anthropic).toEqual({ deferLoading: true })
		expect(deferredTool(first!.tool)).toBe(deferred)
		expect(deferredToolSearch('test-catalog', [])).toBe(search)
		const output = await search.execute?.(
			{ query: 'move deal' } as never,
			{} as never
		)
		expect(search.toModelOutput?.(output)).toEqual({
			type: 'content',
			value: [
				{
					type: 'custom',
					providerOptions: {
						anthropic: { type: 'tool-reference', toolName: 'deal_move' }
					}
				}
			]
		})
		expect(search.toModelOutput?.({ found: [] })).toMatchObject({
			type: 'text'
		})
	})
})

describe('buildClientActionTools', () => {
	test('should keep ids, schemas and approval', () => {
		const tools = buildClientActionTools([
			{
				name: 'saveWorkflow',
				description: 'Save the workflow',
				jsonSchema: {
					type: 'object',
					properties: { force: { type: 'boolean' } }
				},
				requiresApproval: true
			}
		])

		expect(tools.saveWorkflow?.id).toBe('saveWorkflow')
		expect(tools.saveWorkflow?.requireApproval).toBe(true)
		expect(tools.saveWorkflow?.execute).toBeUndefined()
	})
})
