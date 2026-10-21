import { describe, expect, mock, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { z } from 'zod'

import {
	CLIENT_ACTION_INVALID_INPUT,
	CLIENT_ACTION_REPEATED,
	defineClientAction,
	normalizeModelNulls,
	runClientAction,
	toClientToolDefs
} from './actions'

const filterAction = (
	handler: (input: { value: string }) => Promise<unknown>
) =>
	defineClientAction({
		name: 'applyFilters',
		description: 'Apply filters',
		inputSchema: z.object({ value: z.string() }),
		handler
	})

describe('runClientAction', () => {
	test('returns null for a tool that is no client action', () => {
		expect(
			runClientAction({ addToolOutput: async () => {}, messages: [] }, [], {
				toolCallId: 'call-1',
				toolName: 'serverTool',
				input: {}
			})
		).toBeNull()
	})

	test('posts the output, a summary only when the action gives one', async () => {
		const addToolOutput = mock(async (_output: unknown) => undefined)
		const summarized = defineClientAction({
			name: 'save',
			description: 'Save',
			inputSchema: z.object({}),
			resultSummary: 'Saved locally until the user presses Save.',
			handler: async () => 1
		})

		await runClientAction(
			{ addToolOutput, messages: [] },
			[filterAction(async (input) => input), summarized],
			{
				toolCallId: 'call-1',
				toolName: 'applyFilters',
				input: { value: 'x' }
			}
		)
		await runClientAction({ addToolOutput, messages: [] }, [summarized], {
			toolCallId: 'call-2',
			toolName: 'save',
			input: {}
		})

		expect(addToolOutput.mock.calls.map((call) => call[0])).toEqual([
			{ tool: 'applyFilters', toolCallId: 'call-1', output: { value: 'x' } },
			{
				tool: 'save',
				toolCallId: 'call-2',
				output: {
					summary: 'Saved locally until the user presses Save.',
					data: 1
				}
			}
		])
	})

	test('posts a thrown error and an unreadable input as output errors', async () => {
		const addToolOutput = mock(async (_output: unknown) => undefined)
		const actions = [
			filterAction(async () => {
				throw new Error('Invalid filter')
			})
		]

		await runClientAction({ addToolOutput, messages: [] }, actions, {
			toolCallId: 'call-1',
			toolName: 'applyFilters',
			input: { value: 'x' }
		})
		await runClientAction({ addToolOutput, messages: [] }, actions, {
			toolCallId: 'call-2',
			toolName: 'applyFilters',
			input: { value: 4 }
		})

		expect(addToolOutput.mock.calls.map((call) => call[0])).toEqual([
			{
				state: 'output-error',
				tool: 'applyFilters',
				toolCallId: 'call-1',
				errorText: 'Invalid filter'
			},
			{
				state: 'output-error',
				tool: 'applyFilters',
				toolCallId: 'call-2',
				errorText: CLIENT_ACTION_INVALID_INPUT
			}
		])
	})

	test('refuses a call this user turn already made with the same input, nulls aside', async () => {
		const handler = mock(async (input: { value: string }) => input)
		const addToolOutput = mock(async (_output: unknown) => undefined)
		const messages: UIMessage[] = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Filtrér' }] },
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: 'dynamic-tool',
						toolName: 'applyFilters',
						toolCallId: 'call-1',
						state: 'output-available',
						input: { value: 'x' },
						output: {}
					}
				]
			}
		]

		await runClientAction(
			{ addToolOutput, messages },
			[filterAction(handler)],
			{
				toolCallId: 'call-2',
				toolName: 'applyFilters',
				input: { value: 'x' }
			}
		)

		expect(handler).not.toHaveBeenCalled()
		expect(addToolOutput.mock.calls[0]?.[0]).toEqual({
			state: 'output-error',
			tool: 'applyFilters',
			toolCallId: 'call-2',
			errorText: CLIENT_ACTION_REPEATED
		})
	})

	test('hands a repeat to onRepeat, whose result is posted as the output', async () => {
		const handler = mock(async (input: { value: string }) => input)
		const addToolOutput = mock(async (_output: unknown) => undefined)
		const done = {
			type: 'dynamic-tool' as const,
			toolName: 'applyFilters',
			toolCallId: 'call-1',
			state: 'output-available' as const,
			input: { value: 'x' },
			output: {}
		}
		const action = defineClientAction({
			name: 'applyFilters',
			description: 'Apply filters',
			inputSchema: z.object({ value: z.string() }),
			handler,
			onRepeat: async (_input, { toolCallId }) => ({
				status: 'refused',
				reason: 'duplicate',
				toolCallId
			})
		})

		await runClientAction(
			{
				addToolOutput,
				messages: [{ id: 'a1', role: 'assistant', parts: [done] }]
			},
			[action],
			{ toolCallId: 'call-2', toolName: 'applyFilters', input: { value: 'x' } }
		)

		expect(handler).not.toHaveBeenCalled()
		expect(addToolOutput.mock.calls[0]?.[0]).toEqual({
			tool: 'applyFilters',
			toolCallId: 'call-2',
			output: { status: 'refused', reason: 'duplicate', toolCallId: 'call-2' }
		})
	})

	test('gives the handler the step that made the call, so it can refuse a shared step', async () => {
		const addToolOutput = mock(async (_output: unknown) => undefined)
		const call = (toolCallId: string, toolName: string) => ({
			type: 'dynamic-tool' as const,
			toolName,
			toolCallId,
			state: 'input-available' as const,
			input: {}
		})
		const messages: UIMessage[] = [
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{ type: 'step-start' },
					call('earlier', 'lookupSpending'),
					{ type: 'step-start' },
					call('server-1', 'lookupSpending'),
					call('screen-1', 'openScreen'),
					{ type: 'step-start' },
					{ type: 'text', text: 'Later' }
				]
			}
		]
		const seen: UIMessage['parts'] = []
		const openScreen = defineClientAction({
			name: 'openScreen',
			description: 'Open a screen',
			inputSchema: z.object({}),
			handler: async (_input, { step }) => {
				seen.push(...step)
				const shared = step.some(
					(part) => 'toolName' in part && part.toolName !== 'openScreen'
				)
				if (shared) throw new Error('mixed_step')
				return { opened: true }
			}
		})

		await runClientAction({ addToolOutput, messages }, [openScreen], {
			toolCallId: 'screen-1',
			toolName: 'openScreen',
			input: {}
		})

		expect(seen).toEqual([
			call('server-1', 'lookupSpending'),
			call('screen-1', 'openScreen')
		])
		expect(addToolOutput.mock.calls[0]?.[0]).toEqual({
			state: 'output-error',
			tool: 'openScreen',
			toolCallId: 'screen-1',
			errorText: 'mixed_step'
		})
	})
})

describe('normalizeModelNulls', () => {
	test('leaves out null where the schema means "left out", at any depth', () => {
		const schema = z.object({
			nodeKey: z.string(),
			sourceHandle: z.string().optional(),
			position: z
				.object({ x: z.number(), y: z.number().optional() })
				.optional(),
			tags: z.record(z.string(), z.string().optional()),
			edits: z.array(
				z.discriminatedUnion('op', [
					z.object({ op: z.literal('rename'), title: z.string().optional() }),
					z.object({ op: z.literal('clear'), keep: z.string().nullable() })
				])
			)
		})

		expect(
			normalizeModelNulls(schema, {
				nodeKey: 'a',
				sourceHandle: null,
				position: { x: 4, y: null },
				tags: { a: null, b: 'b' },
				edits: [
					{ op: 'rename', title: null },
					{ op: 'clear', keep: null }
				]
			})
		).toEqual({
			nodeKey: 'a',
			position: { x: 4 },
			tags: { b: 'b' },
			edits: [{ op: 'rename' }, { op: 'clear', keep: null }]
		})
	})
})

describe('toClientToolDefs', () => {
	test('describes each action with its input JSON schema', () => {
		const action = defineClientAction({
			name: 'openScreen',
			description: 'Opens a screen.',
			inputSchema: z.object({ screen: z.enum(['home', 'budget']) }),
			requiresApproval: true,
			handler: async () => undefined
		})

		expect(toClientToolDefs([action])).toEqual([
			{
				name: 'openScreen',
				description: 'Opens a screen.',
				requiresApproval: true,
				jsonSchema: expect.objectContaining({
					type: 'object',
					properties: { screen: { type: 'string', enum: ['home', 'budget'] } }
				})
			}
		])
	})
})
