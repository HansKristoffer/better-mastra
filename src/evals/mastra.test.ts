import { describe, expect, test } from 'bun:test'
import type { MastraDBMessage } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import type { DatasetItem } from '@mastra/core/storage'
import {
	createAgentTestRun,
	createTestMessage
} from '@mastra/evals/scorers/utils'
import type { EvalCase } from './case.js'
import {
	assertLocalDatabase,
	type ExperimentTaskArgs,
	caseOfRun,
	createCalledToolScorer,
	createChecksScorer,
	createExperimentTask,
	createNoToolErrorsScorer,
	planDatasetSync,
	readRunOutput,
	replayRecordedTools,
	threadTurnsToDatasetItems,
	toDatasetItem,
	traceOfRun
} from './mastra.js'

const GROCERIES: EvalCase = {
	id: 'spending-groceries',
	suites: ['smoke'],
	bucket: 'answer',
	persona: 'review',
	language: 'da',
	turns: ['Hvor meget brugte jeg på dagligvarer?', 'Og måneden før?'],
	expect: {
		tools: ['transaction_getSummary'],
		forbidTools: ['electricity_getPrices']
	},
	tags: ['spending']
}

function answer(
	id: string,
	text: string,
	tools: {
		toolName: string
		args?: Record<string, unknown>
		result: unknown
	}[] = []
) {
	return createTestMessage({
		id,
		role: 'assistant',
		content: text,
		parts: [
			...tools.map((tool, index) => ({
				type: 'tool-invocation' as const,
				toolInvocation: {
					state: 'result' as const,
					toolCallId: `${id}-call-${index}`,
					toolName: tool.toolName,
					args: tool.args ?? {},
					result: tool.result
				},
				providerMetadata: {
					mastra: { modelOutput: { type: 'text', value: `shown ${index}` } }
				}
			})),
			{ type: 'text' as const, text }
		]
	})
}

describe('reading a run', () => {
	test("reads each answer once when a follow-up turn's output repeats the earlier turn", () => {
		const first = answer('answer-1', 'Du har brugt 6.730 kr. hos Wolt i år.', [
			{ toolName: 'transaction_getSummary', result: { expenses: 6730 } }
		])
		const second = answer('answer-2', 'De seneste: 16. okt. 449 kr.')
		const output = readRunOutput([first, first, second])
		expect(output.answers).toEqual([
			'Du har brugt 6.730 kr. hos Wolt i år.',
			'De seneste: 16. okt. 449 kr.'
		])
		expect(output.calledTools).toEqual(['transaction_getSummary'])
		expect(output.toolResults).toEqual([
			expect.objectContaining({
				displayText: 'shown 0',
				output: { expenses: 6730 }
			})
		])
	})
})

describe('the hard checks as a Mastra scorer', () => {
	const scorer = createChecksScorer({
		caseOf: (run) => caseOfRun(run, [GROCERIES])
	})
	const run = (message: MastraDBMessage, caseId = GROCERIES.id) => ({
		...createAgentTestRun({
			inputMessages: [
				createTestMessage({ role: 'user', content: 'Hvor meget?' })
			],
			output: [message]
		}),
		groundTruth: toDatasetItem(GROCERIES).groundTruth ?? { caseId }
	})

	test('scores 1 when every check passes', async () => {
		const result = await scorer.run(
			run(
				answer(
					'a',
					'Du brugte 4.180 kr. på dagligvarer i sidste måned, og det er mindre end før.',
					[{ toolName: 'transaction_getSummary', result: { spent: 4180 } }]
				)
			)
		)
		expect(result).toEqual(expect.objectContaining({ score: 1 }))
	})

	test('scores 0 and names what failed', async () => {
		const result = await scorer.run(
			run(
				answer('a', 'Du brugte 4.180 kr. og det er fint for dig.', [
					{ toolName: 'transaction_getSummary', result: {} },
					{ toolName: 'electricity_getPrices', result: {} }
				])
			)
		)
		expect(result).toEqual(
			expect.objectContaining({
				score: 0,
				reason: 'does not call electricity_getPrices'
			})
		)
	})
})

describe('a run that ends on a change waiting for approval', () => {
	/** An answer whose write call waits for the user, as Mastra stores it, beside a call that failed. */
	const proposal = createTestMessage({
		id: 'proposal',
		role: 'assistant',
		content: '',
		parts: [
			{
				type: 'tool-invocation' as const,
				toolInvocation: {
					state: 'call' as const,
					toolCallId: 'call-write',
					toolName: 'budget_update',
					args: { amount: 500 }
				}
			}
		]
	})
	proposal.content.metadata = {
		pendingToolApprovals: {
			budget_update: { toolCallId: 'call-write', toolName: 'budget_update' }
		}
	}
	const stranded = createTestMessage({
		id: 'stranded',
		role: 'assistant',
		content: '',
		parts: [
			{
				type: 'tool-invocation' as const,
				toolInvocation: {
					state: 'call' as const,
					toolCallId: 'call-read',
					toolName: 'budget_get',
					args: {}
				}
			}
		]
	})
	const run = (output: MastraDBMessage[]) =>
		createAgentTestRun({
			inputMessages: [createTestMessage({ role: 'user', content: 'Sæt 500' })],
			output
		})

	test('reads the waiting call as a proposal, not as a failed call or a result', () => {
		const output = readRunOutput([proposal, stranded])

		expect(output.calledTools).toEqual(['budget_update', 'budget_get'])
		expect(output.waitingCalls.map((call) => call.toolName)).toEqual([
			'budget_update'
		])
		expect(output.failedCalls.map((call) => call.toolName)).toEqual([
			'budget_get'
		])
		expect(output.toolResults).toEqual([])
		expect(traceOfRun({ output: [proposal] }).turns[0]).toMatchObject({
			heldForApproval: ['budget_update'],
			toolCalls: [{ name: 'budget_update', errorText: null }]
		})
	})

	test('passes the no-tool-errors scorer, which a failed call does not', async () => {
		const scorer = createNoToolErrorsScorer()

		expect(await scorer.run(run([proposal]))).toEqual(
			expect.objectContaining({ score: 1, reason: 'No tool call failed.' })
		)
		expect(await scorer.run(run([proposal, stranded]))).toEqual(
			expect.objectContaining({
				score: 0,
				reason: 'Failed tool calls: budget_get.'
			})
		)
	})

	test('scores each called tool under its own id', async () => {
		const update = createCalledToolScorer('budget_update')
		const remove = createCalledToolScorer('budget_delete')

		expect(update.id).not.toBe(remove.id)
		expect(await update.run(run([proposal]))).toEqual(
			expect.objectContaining({ score: 1 })
		)
		expect(await remove.run(run([proposal]))).toEqual(
			expect.objectContaining({
				score: 0,
				reason: 'The run did not call budget_delete; it called budget_update.'
			})
		)
	})
})

describe('an experiment task', () => {
	const signal = createTestMessage({
		id: 'signal',
		role: 'system',
		content: 'Now on the budget page.'
	})

	type ToolHook = (call: { toolName: string; input: unknown }) => unknown

	/** An agent that records what each turn ran with, calls the tools it is told to, and answers with the turn's text. */
	function fakeAgent(toolsToCall: readonly string[] = []) {
		const calls: { turn: unknown; options: Record<string, unknown> }[] = []
		const hookResults: unknown[] = []
		const generate = async (
			turn: unknown,
			options: Record<string, unknown>
		) => {
			calls.push({ turn, options })

			const hooks = options.hooks as { beforeToolCall: ToolHook } | undefined
			for (const toolName of toolsToCall) {
				hookResults.push(hooks?.beforeToolCall({ toolName, input: {} }))
			}

			return {
				scoringData: {
					output: [answer(`answer-${calls.length}`, `Svar på ${turn}`)]
				}
			}
		}

		return { calls, hookResults, agent: { generate } as never }
	}

	test('runs every turn of an item with the prepared request context, on one thread', async () => {
		const { agent, calls } = fakeAgent()
		const requestContext = new RequestContext()
		const prepared: ExperimentTaskArgs[] = []
		const task = createExperimentTask({
			agent,
			prepare: (args) => {
				prepared.push(args)

				return {
					requestContext,
					memory: { thread: 'eval-thread', resource: 'eval-resource' },
					outputPrefix: [signal]
				}
			}
		})

		const output = await task({
			input: ['Hvor meget?', { text: 'Og før?' }],
			groundTruth: { caseId: GROCERIES.id }
		})

		// Then the item was prepared once, and each turn ran with that context and thread
		expect(prepared).toHaveLength(1)
		expect(calls.map((call) => call.turn)).toEqual(['Hvor meget?', 'Og før?'])
		expect(
			calls.every((call) => call.options.requestContext === requestContext)
		).toBe(true)
		expect(calls[0]?.options).toMatchObject({
			memory: { thread: 'eval-thread', resource: 'eval-resource' },
			returnScorerData: true
		})
		// And the scorers get the prefix first, then each turn's messages
		expect(output.map((message) => message.id)).toEqual([
			'signal',
			'answer-1',
			'answer-2'
		])
	})

	test("fails the item when a call matches none of its mocks under policy 'deny'", async () => {
		// Given an agent that calls a tool the item has no mock for
		const { agent, hookResults } = fakeAgent(['budget_get'])
		const task = createExperimentTask({
			agent,
			prepare: () => ({
				requestContext: new RequestContext(),
				toolMocks: { mocks: [], unmockedToolPolicy: 'deny' }
			})
		})

		// Then the call never reaches the tool, and the item fails
		await expect(task({ input: 'Hvor meget?' })).rejects.toThrow(
			'The run called budget_get without a matching mock'
		)
		expect(hookResults).toEqual([
			{ proceed: false, output: { error: 'TOOL_MOCK_NOT_DECLARED' } }
		])
	})

	test('refuses an input that holds no message', async () => {
		const { agent } = fakeAgent()
		const task = createExperimentTask({
			agent,
			prepare: () => ({ requestContext: new RequestContext() })
		})

		await expect(task({ input: [{ page: 'budget' }] })).rejects.toThrow(
			"An experiment item's input must be a message or a list of messages."
		)
	})
})

describe('the dataset sync', () => {
	const BALANCES: EvalCase = {
		...GROCERIES,
		id: 'balances',
		turns: ['Hvor mange penge har jeg?']
	}
	const stored = (id: string, testCase: EvalCase): DatasetItem => {
		const now = new Date('2026-10-19T08:00:00Z')
		return {
			...toDatasetItem(testCase),
			id,
			datasetId: 'cases',
			datasetVersion: 1,
			createdAt: now,
			updatedAt: now
		} as DatasetItem
	}
	const reversed = (value: unknown) =>
		Object.fromEntries(Object.entries(value as object).toReversed())

	test('a case keeps its turns, id and expectation', () => {
		expect(toDatasetItem(GROCERIES, { locale: 'da' })).toEqual({
			externalId: 'spending-groceries',
			input: GROCERIES.turns,
			groundTruth: { caseId: 'spending-groceries', expect: GROCERIES.expect },
			metadata: {
				persona: 'review',
				language: 'da',
				bucket: 'answer',
				suites: ['smoke'],
				tags: ['spending'],
				locale: 'da'
			}
		})
	})

	test('adds new cases, updates changed ones, deletes removed ones and leaves the rest', () => {
		const unchanged = stored('stored-1', BALANCES)
		const plan = planDatasetSync(
			[BALANCES, GROCERIES, { ...BALANCES, id: 'new-case' }].map((c) =>
				toDatasetItem(c)
			),
			[
				{
					...unchanged,
					groundTruth: reversed(unchanged.groundTruth),
					metadata: reversed(unchanged.metadata)
				},
				stored('stored-2', { ...GROCERIES, turns: ['Gammelt spørgsmål'] }),
				stored('stored-3', { ...GROCERIES, id: 'removed-case' })
			]
		)
		expect(plan).toEqual({
			add: [expect.objectContaining({ externalId: 'new-case' })],
			update: [
				{
					itemId: 'stored-2',
					item: expect.objectContaining({ input: GROCERIES.turns })
				}
			],
			remove: ['stored-3']
		})
	})
})

describe('a copied thread turn', () => {
	const recordedAt = new Date('2026-10-18T09:30:00.000Z')
	const messages: MastraDBMessage[] = [
		{
			...createTestMessage({
				id: 'user-1',
				role: 'user',
				content: 'Hvordan går budgettet?'
			}),
			createdAt: recordedAt
		},
		answer('answer-1', 'Du har brugt 12.346 kr.', [
			{
				toolName: 'budget_getSummary',
				args: { month: '2026-10' },
				result: { total: 12346 }
			}
		]),
		createTestMessage({ id: 'user-2', role: 'user', content: 'Tak' }),
		answer('answer-2', 'Velbekomme.', [{ toolName: 'goal_list', result: [] }])
	]

	test("keeps the user's message and that turn's tool results as mocks, denying the rest", () => {
		expect(
			threadTurnsToDatasetItems({
				messages,
				messageIds: ['user-1'],
				externalIdPrefix: 'chat:',
				metadata: (user) => ({ recordedAt: user.createdAt.toISOString() })
			})
		).toEqual([
			{
				externalId: 'chat:user-1',
				input: ['Hvordan går budgettet?'],
				groundTruth: { caseId: 'chat:user-1' },
				toolMocks: [
					{
						toolName: 'budget_getSummary',
						args: { month: '2026-10' },
						output: { total: 12346 },
						matchArgs: 'ignore'
					}
				],
				unmockedToolPolicy: 'deny',
				metadata: { recordedAt: recordedAt.toISOString() }
			}
		])
	})

	test('refuses a message that is not a user message', () => {
		expect(() =>
			threadTurnsToDatasetItems({ messages, messageIds: ['answer-1'] })
		).toThrow('Message answer-1 is not a user message of the thread.')
	})
})

describe('a replay of recorded tool reads', () => {
	class FakeTool {
		constructor(
			readonly id: string,
			readonly description: string
		) {}
		execute = async (_input: unknown): Promise<unknown> => ({ live: true })
	}
	const real = { lookup: new FakeTool('lookup', 'Spending by category') }
	const read = {
		toolName: 'lookup',
		input: { category: 'Groceries' },
		output: { spent: 4200 }
	}

	test('serves the recorded read for the same input', async () => {
		const replay = replayRecordedTools(real, [read])
		expect(
			await replay.tools.lookup.execute({ category: 'Groceries' } as never)
		).toEqual({
			spent: 4200
		})
		expect(replay.unmatchedCalls()).toEqual([])
	})

	test('refuses other input or an unrecorded tool, and records it', async () => {
		const replay = replayRecordedTools(real, [read])
		expect(
			await replay.tools.lookup.execute({ category: 'Rent' } as never)
		).toEqual({
			error: 'No recorded read matches this call (TOOL_MOCK_MISMATCH).'
		})
		const empty = replayRecordedTools(real, [])
		await empty.tools.lookup.execute({} as never)
		expect(replay.unmatchedCalls()).toEqual([
			{
				toolName: 'lookup',
				input: { category: 'Rent' },
				code: 'TOOL_MOCK_MISMATCH'
			}
		])
		expect(empty.unmatchedCalls()).toEqual([
			expect.objectContaining({ code: 'TOOL_MOCK_NOT_DECLARED' })
		])
	})

	test('keeps each tool as the model sees it and leaves the real tool alone', () => {
		const replayed = replayRecordedTools(real, [read]).tools.lookup
		expect(replayed).toBeInstanceOf(FakeTool)
		expect(replayed.description).toBe('Spending by category')
		expect(replayed.execute).not.toBe(real.lookup.execute)
	})
})

test('the local-database guard refuses anything but development on this machine', () => {
	const local = {
		APP_ENV: 'development',
		DATABASE_URL: 'postgres://u@localhost:5432/db'
	}
	expect(() => assertLocalDatabase(local)).not.toThrow()
	expect(() =>
		assertLocalDatabase({ ...local, APP_ENV: 'production' })
	).toThrow()
	expect(() =>
		assertLocalDatabase({
			...local,
			DATABASE_URL: 'postgres://u@db.example.com/db'
		})
	).toThrow()
})
