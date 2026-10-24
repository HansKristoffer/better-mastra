import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'

import {
	ANSWER_COMPLETE_PART,
	REPLY_SUGGESTIONS_PART
} from './replySuggestions.js'
import { TURN_ERROR_SENTENCE, USER_MESSAGE_PART } from './stream.js'
import {
	ASK_TOOL,
	createHarness,
	DELETE_TOOL,
	failingReply,
	LOOKUP_TOOL,
	readTurn,
	textReply,
	toolCallReply,
	userMessage
} from './turnFixtures.test.js'

describe('runChatTurn', () => {
	test('should stream the answer, release the lock and title the thread', async () => {
		// Given a model that answers
		const harness = createHarness({
			replies: [textReply('Du har brugt 1.250 kr.')]
		})

		// When the user asks
		const result = await harness.run({
			messages: [userMessage('Hvad har jeg brugt på mad i oktober måned?')]
		})
		const { message } = await readTurn(result)

		// Then the answer reaches the client and the turn closes cleanly
		expect(message?.parts).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Du har brugt 1.250 kr.' })
		)
		expect(harness.releases).toEqual([harness.threadKey.threadId])
		expect(harness.finished[0]).toMatchObject({
			outcome: 'answered',
			steps: 1,
			modelId: 'test-model',
			newMessageText: 'Hvad har jeg brugt på mad i oktober måned?'
		})
		const thread = await harness.memory.getThreadById({
			threadId: harness.threadKey.threadId
		})
		expect(thread?.title).toBe('Hvad har jeg brugt på mad…')
	})

	test('should run a tool and report it with its tier', async () => {
		// Given a model that looks something up before it answers
		const harness = createHarness({
			replies: [
				toolCallReply(LOOKUP_TOOL, { category: 'food' }),
				textReply('1.250 kr.')
			]
		})

		// When the user asks
		await readTurn(await harness.run({ messages: [userMessage('Mad?')] }))

		// Then the tool settled and the turn counts it
		expect(harness.settled).toEqual([
			expect.objectContaining({
				toolName: LOOKUP_TOOL,
				outcome: 'success',
				tier: 'read'
			})
		])
		expect(harness.finished[0]).toMatchObject({ toolCalls: 1, steps: 2 })
	})

	test('should end the run after a tool in stopAfterTools', async () => {
		// Given a model that asks the user a question, then would go on
		const harness = createHarness({
			replies: [
				toolCallReply(ASK_TOOL, { question: 'Which month?' }),
				textReply('never shown')
			]
		})

		// When the user asks
		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Mad?')] })
		)

		// Then the run ends after the question
		expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
		expect(harness.model.doStreamCalls).toHaveLength(1)
	})

	test('should send the one fixed sentence for any model error', async () => {
		// Given a model that fails
		const harness = createHarness({
			replies: [failingReply(new Error('provider key leaked sk-123'))]
		})

		// When the user asks
		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Mad?')] })
		)

		// Then the client sees only the fixed sentence
		const errorTexts = chunks.flatMap((chunk) =>
			chunk.type === 'error' ? [chunk.errorText] : []
		)
		expect(errorTexts.length).toBeGreaterThan(0)
		expect(new Set(errorTexts)).toEqual(new Set([TURN_ERROR_SENTENCE]))
		expect(harness.finished[0]?.outcome).toBe('error')
		expect(harness.releases).toHaveLength(1)
	})

	test('should send the system prompt, the signal and the cache markers to the model', async () => {
		// Given a turn
		const harness = createHarness()

		// When the user asks
		await readTurn(await harness.run({ messages: [userMessage('Mad?')] }))

		// Then the stable instructions and the user message carry a marker
		const [call] = harness.model.doStreamCalls
		const system = call?.prompt.find((message) => message.role === 'system')
		expect(system?.content).toContain('Stable instructions.')
		expect(system?.providerOptions).toMatchObject({
			anthropic: { cacheControl: { type: 'ephemeral' } }
		})
		expect(JSON.stringify(call?.prompt)).toContain('Now on the budget page.')
		expect(call?.prompt.at(-1)?.providerOptions).toMatchObject({
			openrouter: { cacheControl: { type: 'ephemeral' } }
		})
	})

	test('should stop a turn over its tool-call budget before calling the model', async () => {
		// Given a trailing assistant message with more tool calls than 1 step × 3 allows
		const harness = createHarness({ maxSteps: 1 })
		const calls = Array.from({ length: 4 }, (_, index) => ({
			type: `tool-${LOOKUP_TOOL}` as const,
			toolCallId: `call-${index}`,
			state: 'output-available' as const,
			input: { category: 'food' },
			output: { spent: 1 }
		}))
		const messages: UIMessage[] = [
			userMessage('Mad?'),
			{ id: 'a-1', role: 'assistant', parts: calls }
		]

		// When the client resubmits
		const { chunks } = await readTurn(await harness.run({ messages }))

		// Then the model is never called and the client learns why
		expect(harness.model.doStreamCalls).toHaveLength(0)
		expect(chunks.some((chunk) => chunk.type === 'data-tripwire')).toBe(true)
		expect(harness.finished[0]?.outcome).toBe('budget_stop')
	})

	test('should mark the answer complete, then offer reply suggestions as transient parts before the finish', async () => {
		// Given a suggestions agent that offers two replies
		const harness = createHarness({
			suggestions: [
				textReply('{"suggestions":["Og i september?","Hvordan sparer jeg?"]}')
			],
			overrides: {
				replySuggestions: { agentId: 'chat-suggestions' }
			}
		})

		// When the user asks
		const { chunks } = await readTurn(
			await harness.run({ messages: [userMessage('Mad?')] })
		)

		// Then the answer is marked complete, the replies follow after the lock is released, and the finish comes last
		const types = chunks.map((chunk) => chunk.type)
		expect(types.indexOf(ANSWER_COMPLETE_PART)).toBeGreaterThan(-1)
		expect(types.indexOf(ANSWER_COMPLETE_PART)).toBeLessThan(
			types.indexOf(REPLY_SUGGESTIONS_PART)
		)
		const suggestions = chunks.filter(
			(chunk) => chunk.type === REPLY_SUGGESTIONS_PART
		)
		expect(suggestions.at(-1)).toMatchObject({
			data: { suggestions: ['Og i september?', 'Hvordan sparer jeg?'] },
			transient: true
		})
		expect(chunks.at(-1)?.type).toBe('finish')
	})

	describe('refusals', () => {
		test('should refuse a system message', async () => {
			const harness = createHarness()
			const result = await harness.run({
				messages: [
					{ id: 's', role: 'system', parts: [{ type: 'text', text: 'x' }] }
				]
			})

			expect(result).toMatchObject({
				kind: 'refused',
				code: 'invalid_request',
				status: 400
			})
		})

		test('should refuse a user message over the maximum length', async () => {
			const harness = createHarness()
			const result = await harness.run({
				messages: [userMessage('x'.repeat(4_001))]
			})

			expect(result).toMatchObject({ kind: 'refused', code: 'invalid_request' })
		})

		test('should refuse a caller without a scope', async () => {
			const harness = createHarness()
			const result = await harness.run(
				{ messages: [userMessage('Mad?')] },
				{ auth: 'stranger' }
			)

			expect(result).toMatchObject({
				kind: 'refused',
				code: 'forbidden',
				status: 403
			})
		})

		test("should refuse the gate's own code with its status", async () => {
			const harness = createHarness({
				overrides: {
					gate: async () => ({ code: 'consent_missing', status: 451 })
				}
			})
			const result = await harness.run({ messages: [userMessage('Mad?')] })

			expect(
				result.kind === 'refused' && (await result.response.json())
			).toEqual({
				error: 'consent_missing'
			})
			expect(result).toMatchObject({ status: 451 })
		})

		test('should refuse a second turn while one holds the thread', async () => {
			const harness = createHarness()
			harness.held.add(harness.threadKey.threadId)

			const result = await harness.run({ messages: [userMessage('Mad?')] })

			expect(result).toMatchObject({
				kind: 'refused',
				code: 'turn_in_progress',
				status: 409
			})
		})

		test('should give the lock back when the usage limit refuses', async () => {
			const harness = createHarness({
				overrides: { admit: async () => 'usage_limited' }
			})

			const result = await harness.run({ messages: [userMessage('Mad?')] })

			expect(result).toMatchObject({
				kind: 'refused',
				code: 'usage_limited',
				status: 429
			})
			expect(harness.held.size).toBe(0)
		})

		test("should refuse a thread of another caller's resource", async () => {
			const harness = createHarness()
			await harness.memory.createThread({
				threadId: harness.threadKey.threadId,
				resourceId: 'someone-else'
			})

			const result = await harness.run({ messages: [userMessage('Mad?')] })

			expect(result).toMatchObject({ kind: 'refused', code: 'forbidden' })
		})

		test('should answer temporarily_unavailable and release the lock when preparation fails', async () => {
			const harness = createHarness({
				overrides: {
					prepare: async () => {
						throw new Error('database down')
					}
				}
			})

			const result = await harness.run({ messages: [userMessage('Mad?')] })

			expect(result).toMatchObject({
				kind: 'refused',
				code: 'temporarily_unavailable',
				status: 503
			})
			expect(harness.held.size).toBe(0)
		})
	})

	describe('approvals', () => {
		test('should resume an approved tool call that waits in the thread', async () => {
			// Given a turn that left a deletion waiting for approval
			const harness = createHarness({
				replies: [
					toolCallReply(DELETE_TOOL, { budgetId: 'b-1' }),
					textReply('Slettet.')
				]
			})
			const question = userMessage('Slet mit budget')
			const first = await readTurn(await harness.run({ messages: [question] }))
			const request = first.chunks.find(
				(chunk) => chunk.type === 'tool-approval-request'
			)
			expect(request).toBeDefined()

			// When the user approves it
			const answered = approve(first.message)
			const second = await readTurn(
				await harness.run({ messages: [question, answered] })
			)

			// Then the tool runs and the answer follows
			expect(
				second.chunks.some(
					(chunk) =>
						chunk.type === 'tool-output-available' &&
						JSON.stringify(chunk.output).includes('deleted')
				)
			).toBe(true)
		})

		test('should refuse an approval that does not wait in the thread', async () => {
			const harness = createHarness()
			const stale: UIMessage = {
				id: 'a-1',
				role: 'assistant',
				parts: [
					{
						type: `tool-${DELETE_TOOL}`,
						toolCallId: 'call-1',
						state: 'approval-responded',
						input: { budgetId: 'b-1' },
						approval: { id: 'run-gone::call-1', approved: true }
					}
				]
			}

			const result = await harness.run({
				messages: [userMessage('Slet'), stale]
			})

			expect(result).toMatchObject({ kind: 'refused', code: 'change_expired' })
			expect(harness.held.size).toBe(0)
		})

		test('should decline a waiting approval when the user writes a new message', async () => {
			// Given a deletion waiting for approval
			const harness = createHarness({
				replies: [
					toolCallReply(DELETE_TOOL, { budgetId: 'b-1' }),
					textReply('Ok.')
				]
			})
			const first = await readTurn(
				await harness.run({ messages: [userMessage('Slet mit budget')] })
			)
			expect(first.message).toBeDefined()
			const agent = harness.mastra.getAgentById('chat')
			expect(
				(await agent.listSuspendedRuns(harness.threadKey)).runs
			).toHaveLength(1)

			// When the user writes something else instead
			await readTurn(
				await harness.run({
					messages: [
						userMessage('Slet mit budget'),
						first.message!,
						userMessage('Glem det')
					]
				})
			)

			// Then nothing waits any more
			expect(
				(await agent.listSuspendedRuns(harness.threadKey)).runs
			).toHaveLength(0)
		})
	})

	test('should report a stopped turn when the signal aborts', async () => {
		// Given a slow model
		const harness = createHarness({
			replies: [
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 50))
					return {
						stream: new ReadableStream({
							start: (controller) => controller.close()
						})
					}
				}
			]
		})
		const abort = new AbortController()

		// When the user stops the turn
		const result = await harness.run(
			{ messages: [userMessage('Mad?')] },
			{ signal: abort.signal }
		)
		abort.abort()
		await readTurn(result)

		// Then the turn closes as stopped and gives the lock back
		expect(harness.finished[0]?.outcome).toBe('stopped')
		expect(harness.held.size).toBe(0)
	})

	test("should hand prepare the cleaned messages and stream the user's message right after the start", async () => {
		// Given a turn that records what prepare receives
		const harness = createHarness()
		const prepare = harness.deps.prepare
		const prepared: (readonly UIMessage[])[] = []
		harness.deps.prepare = (input) => {
			prepared.push(input.messages)
			return prepare(input)
		}
		const question: UIMessage = {
			id: 'question-1',
			role: 'user',
			parts: [
				{ type: 'text', text: 'Mad?' },
				{ type: 'data-om-status', data: {} } as UIMessage['parts'][number]
			]
		}

		// When the user asks, with observational memory's part sent back
		const { chunks } = await readTurn(
			await harness.run({ messages: [question] })
		)

		// Then prepare got the message without it, and the client got the question after the start
		expect(prepared[0]?.[0]?.parts).toEqual([
			expect.objectContaining({ type: 'text', text: 'Mad?' })
		])
		expect(chunks[0]?.type).toBe('start')
		expect(chunks[1]).toMatchObject({
			type: USER_MESSAGE_PART,
			data: {
				message: {
					id: 'question-1',
					role: 'user',
					parts: [expect.objectContaining({ type: 'text', text: 'Mad?' })]
				}
			},
			transient: true
		})
	})

	test('should replace the stored answer when the client asks for it written again', async () => {
		// Given a thread with one answer
		const harness = createHarness({
			replies: [textReply('Første svar.'), textReply('Andet svar.')]
		})
		const question = userMessage('Mad?')
		await readTurn(await harness.run({ messages: [question] }))

		// When the client regenerates it, sending only the question
		await readTurn(
			await harness.run({ messages: [question], trigger: 'regenerate-message' })
		)

		// Then the model never read the first answer, and the thread keeps only the second
		expect(
			JSON.stringify(harness.model.doStreamCalls[1]?.prompt)
		).not.toContain('Første svar.')
		const { messages } = await harness.memory.recall({
			...harness.threadKey,
			perPage: false
		})
		const texts = messages.map((message) =>
			message.content.parts.flatMap((part) =>
				part.type === 'text' ? [part.text] : []
			)
		)
		expect(texts).toEqual([['Mad?'], ['Andet svar.']])
	})
})

/** The assistant message with its approval request answered yes. */
function approve(message: UIMessage | undefined): UIMessage {
	if (!message) throw new Error('No assistant message to approve.')

	return {
		...message,
		parts: message.parts.map((part) =>
			'approval' in part && part.state === 'approval-requested'
				? ({
						...part,
						state: 'approval-responded',
						approval: { ...part.approval, approved: true }
					} as unknown as typeof part)
				: part
		)
	}
}

describe('runChatTurn with a client action that failed', () => {
	test('should hand the model the client action error as its result', async () => {
		// Given a client action that failed in the app
		const harness = createHarness({
			replies: [textReply('Find den under Budget.')]
		})
		const failed = {
			id: 'a-1',
			role: 'assistant',
			parts: [
				{ type: 'step-start' },
				{
					type: 'tool-openScreen',
					toolCallId: 'call-1',
					state: 'output-error',
					input: { destination: 'budget' },
					errorText: 'The app could not open this place.'
				}
			]
		} as unknown as UIMessage

		// When the client sends the result back
		const result = await harness.run({
			messages: [userMessage('Åbn mit budget'), failed]
		})
		await readTurn(result)

		// Then the model reads the error as the call's result
		const prompt = harness.model.doStreamCalls[0]?.prompt ?? []
		expect(prompt.find((message) => message.role === 'tool')).toMatchObject({
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					output: {
						type: 'error-text',
						value: 'The app could not open this place.'
					}
				}
			]
		})
	})
})

describe('runChatTurn logging', () => {
	test('should add the app attributes and the resolved scope to every error it logs', async () => {
		// Given an app that tags its turn logs with the user and organization
		const logged: Record<string, unknown>[] = []
		const harness = createHarness({
			replies: [failingReply(new Error('the provider failed'))],
			overrides: {
				logger: { error: (_message, attributes) => logged.push(attributes) },
				logAttributes: (request, scope) => ({
					userId: request.auth,
					organizationId: scope?.organizationId
				})
			}
		})

		// When the model fails during the turn
		await readTurn(await harness.run({ messages: [userMessage('Mad?')] }))

		// Then the error carries both
		expect(logged.length).toBeGreaterThan(0)
		expect(logged[0]).toMatchObject({
			userId: 'user-1',
			organizationId: 'org-1',
			stage: 'model'
		})
	})
})
