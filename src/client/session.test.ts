import { describe, expect, test } from 'bun:test'
import {
	createUIMessageStreamResponse,
	type UIMessage,
	type UIMessageChunk
} from 'ai'
import { z } from 'zod'

import {
	createHarness,
	DELETE_TOOL,
	type ModelStreamPart,
	textReply,
	toolCallReply
} from '../turn/turnFixtures.test'
import { defineClientAction } from './actions'
import { createChatFetch } from './fetch'
import { STRANDED_TOOL_ERROR } from './messages'
import {
	type ChatSession,
	type ChatSessionOptions,
	createChatSession
} from './session'

// HELPERS

interface Recorded {
	readonly method: string
	readonly url: string
	readonly body: Record<string, unknown> | undefined
}

type Reply = (request: Recorded) => Response | Promise<Response>

/** A server that answers each request with the next reply, recording what it got. */
function fakeServer(replies: Reply[]) {
	const requests: Recorded[] = []
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request: Recorded = {
			method: init?.method ?? 'GET',
			url: String(input),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		}
		requests.push(request)

		const reply = replies.shift()

		if (reply === undefined) {
			throw new Error(`No reply for ${request.method} ${request.url}`)
		}

		return reply(request)
	}

	return { requests, fetch }
}

function stream(chunks: readonly UIMessageChunk[]): Reply {
	return () =>
		createUIMessageStreamResponse({
			stream: new ReadableStream({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(chunk)
					}

					controller.close()
				}
			})
		})
}

/** A stream that sends its chunks and stays open: `send` adds more, `end` closes it. */
function heldStream(chunks: readonly UIMessageChunk[]) {
	let controller!: ReadableStreamDefaultController<UIMessageChunk>
	const send = (more: readonly UIMessageChunk[]) => {
		for (const chunk of more) {
			controller.enqueue(chunk)
		}
	}
	const reply: Reply = () =>
		createUIMessageStreamResponse({
			stream: new ReadableStream({
				start(streamController) {
					controller = streamController
					send(chunks)
				}
			})
		})

	return { reply, send, end: () => controller.close() }
}

/** A stream that sends its chunks, then drops the connection. */
function droppedStream(chunks: readonly UIMessageChunk[]): Reply {
	return () => {
		const encoder = new TextEncoder()

		return new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
						)
					}

					controller.error(new TypeError('Network connection was lost.'))
				}
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	}
}

function answer(text: string, messageId = 'answer-1'): UIMessageChunk[] {
	return [
		{ type: 'start', messageId },
		{ type: 'text-start', id: 't1' },
		{ type: 'text-delta', id: 't1', delta: text },
		{ type: 'text-end', id: 't1' },
		{ type: 'finish' }
	]
}

function json(status: number, body: unknown): Reply {
	return () => Response.json(body, { status })
}

function session(
	server: ReturnType<typeof fakeServer>,
	options: Partial<ChatSessionOptions> = {}
): ChatSession {
	let id = 0

	return createChatSession({
		threadId: 'thread-1',
		transport: {
			api: 'https://api.test/chat',
			fetch: createChatFetch({ fetch: server.fetch, delay: async () => {} })
		},
		generateId: () => `id-${++id}`,
		...options
	})
}

async function settled(
	chat: ChatSession,
	kinds: readonly string[] = ['idle', 'failed', 'waiting']
) {
	for (let tick = 0; tick < 200; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1))

		if (
			kinds.includes(chat.getSnapshot().turn.kind) &&
			chat.chat.status !== 'submitted' &&
			chat.chat.status !== 'streaming'
		) {
			return
		}
	}

	throw new Error(`Turn did not settle: ${chat.getSnapshot().turn.kind}`)
}

async function waitFor(condition: () => boolean) {
	for (let tick = 0; tick < 200; tick += 1) {
		if (condition()) {
			return
		}

		await new Promise((resolve) => setTimeout(resolve, 1))
	}

	throw new Error('The condition never held.')
}

function texts(messages: readonly UIMessage[]) {
	return messages.map((message) =>
		message.parts
			.flatMap((part) => (part.type === 'text' ? [part.text] : []))
			.join('')
	)
}

// TESTS

describe('createChatSession', () => {
	test('sends only the new user message with the thread id and ends the turn answered', async () => {
		const server = fakeServer([stream(answer('Hej!'))])
		const chat = session(server)

		expect(chat.send('Hej')).toBe(true)
		await settled(chat)

		expect(server.requests).toHaveLength(1)
		expect(server.requests[0]?.body).toMatchObject({
			threadId: 'thread-1',
			trigger: 'submit-message',
			messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hej' }] }]
		})
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
		expect(texts(chat.chat.messages)).toEqual(['Hej', 'Hej!'])
	})

	test('shapes the body with prepareBody', async () => {
		const server = fakeServer([stream(answer('Ok'))])
		const chat = session(server, {
			prepareBody: ({ messages }) => ({ messages, locale: 'da' })
		})

		chat.send('Hej')
		await settled(chat)

		expect(Object.keys(server.requests[0]?.body ?? {}).sort()).toEqual([
			'locale',
			'messages'
		])
	})

	test("adds the app's fields to the default body, and reports the saved answer once", async () => {
		const server = fakeServer([
			stream(answer('Ok')),
			json(429, { error: 'usage_limited' })
		])
		const saved: (string | undefined)[] = []
		const chat = session(server, {
			prepareBody: (_request, body) => ({ ...body, locale: 'da' }),
			onSaved: ({ message }) => saved.push(message?.id)
		})

		chat.send('Hej')
		await settled(chat)
		chat.send('Igen')
		await settled(chat)

		expect(server.requests[0]?.body).toMatchObject({
			threadId: 'thread-1',
			trigger: 'submit-message',
			locale: 'da'
		})
		expect(saved).toEqual(['answer-1'])
	})

	test('types the resume data prepareBody reads and resumeRun takes', () => {
		type Answer = { readonly answer: 'yes' | 'no' }
		const typed = createChatSession<Answer>({
			threadId: 'thread-1',
			transport: { api: '/chat' },
			prepareBody: ({ messages, resume }) => ({
				messages,
				...(resume ? { runId: resume.runId, answer: resume.data.answer } : {})
			})
		})
		// A typed session is still a session for the React and Vue bindings.
		const plain: ChatSession = typed

		typed.resumeRun({ runId: 'run-1', data: { answer: 'yes' } })
		// @ts-expect-error data must be the session's resume type
		typed.resumeRun({ runId: 'run-1', data: { answer: 'maybe' } })
		plain.dispose()
	})

	test('carries out a client action when its request ends and sends its result as the follow-up', async () => {
		const opened: string[] = []
		const openScreen = defineClientAction({
			name: 'openScreen',
			description: 'Opens a screen.',
			inputSchema: z.object({ screen: z.string(), tab: z.string().optional() }),
			handler: async ({ screen }) => {
				opened.push(screen)

				return { status: 'opened' }
			}
		})
		const server = fakeServer([
			stream([
				{ type: 'start', messageId: 'answer-1' },
				{ type: 'start-step' },
				{
					type: 'tool-input-available',
					toolCallId: 'call-1',
					toolName: 'openScreen',
					input: { screen: 'budget', tab: null },
					dynamic: true
				},
				{ type: 'finish-step' },
				{ type: 'finish' }
			]),
			stream(answer('Der er du.', 'answer-1'))
		])
		const chat = session(server, { clientActions: [openScreen] })

		chat.send('Vis mit budget')
		await settled(chat)

		expect(opened).toEqual(['budget'])
		expect(server.requests).toHaveLength(2)
		expect(server.requests[0]?.body?.clientTools).toEqual([
			expect.objectContaining({ name: 'openScreen' })
		])

		const followUp = server.requests[1]?.body?.messages as UIMessage[]

		expect(followUp.map((message) => message.role)).toEqual([
			'user',
			'assistant'
		])
		expect(followUp[1]?.parts).toContainEqual(
			expect.objectContaining({
				toolCallId: 'call-1',
				state: 'output-available',
				output: { status: 'opened' }
			})
		)
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('answers a server call stranded beside a client action with an error, so the turn goes on', async () => {
		const action = defineClientAction({
			name: 'openScreen',
			description: 'Opens a screen.',
			inputSchema: z.object({}),
			handler: async () => ({ status: 'opened' })
		})
		const server = fakeServer([
			stream([
				{ type: 'start', messageId: 'answer-1' },
				{ type: 'start-step' },
				{
					type: 'tool-input-available',
					toolCallId: 'server-1',
					toolName: 'listGoals',
					input: {},
					dynamic: true
				},
				{
					type: 'tool-input-available',
					toolCallId: 'call-1',
					toolName: 'openScreen',
					input: {},
					dynamic: true
				},
				{ type: 'finish-step' },
				{ type: 'finish' }
			]),
			stream(answer('Ok', 'answer-1'))
		])
		const chat = session(server, { clientActions: [action] })

		chat.send('Hej')
		await settled(chat)

		const parts = (
			server.requests[1]?.body?.messages as UIMessage[] | undefined
		)?.[1]?.parts

		expect(parts).toContainEqual(
			expect.objectContaining({
				toolCallId: 'server-1',
				state: 'output-error',
				errorText: STRANDED_TOOL_ERROR
			})
		)
	})

	test('queues a message typed mid-answer and sends it when the answer ends', async () => {
		const server = fakeServer([
			stream(answer('Første')),
			stream(answer('Anden', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Et')
		chat.send('To')
		await settled(chat)
		await settled(chat)

		expect(server.requests).toHaveLength(2)
		expect(texts(chat.chat.messages)).toEqual(['Et', 'Første', 'To', 'Anden'])
	})

	test('reads a refusal from the response and offers Try again by its code', async () => {
		const reports: unknown[] = []
		const server = fakeServer([
			json(409, { error: 'turn_in_progress' }),
			stream(answer('Nu'))
		])
		const chat = session(server, {
			onFailure: (report) => reports.push(report)
		})

		chat.send('Hej')
		await settled(chat)

		expect(chat.getSnapshot().turn).toEqual({
			kind: 'failed',
			failure: {
				kind: 'refused',
				refusal: { code: 'turn_in_progress', canTryAgain: true, expired: false }
			}
		})
		expect(reports).toEqual([{ code: 'turn_in_progress', retrying: false }])

		chat.tryAgain()
		await settled(chat)

		expect(server.requests[1]?.body?.trigger).toBe('regenerate-message')
		expect(texts(chat.chat.messages)).toEqual(['Hej', 'Nu'])
	})

	test('fails the turn as truncated when the model was cut off inside a tool call, and Try again asks for the answer again', async () => {
		const reports: unknown[] = []
		const saved: unknown[] = []
		const server = fakeServer([
			// What a turn streams when the output-token limit ends the model call
			// inside a tool's input: the call never becomes available.
			stream([
				{ type: 'start', messageId: 'answer-1' },
				{ type: 'start-step' },
				{ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'file' },
				{
					type: 'tool-input-delta',
					toolCallId: 'call-1',
					inputTextDelta: '{"title":"Mod'
				},
				{ type: 'finish-step' },
				{ type: 'finish', finishReason: 'length' }
			]),
			stream(answer('Sendt som #31', 'answer-2'))
		])
		const chat = session(server, {
			onFailure: (report) => reports.push(report),
			onSaved: ({ message }) => saved.push(message?.id)
		})

		chat.send('En lang rapport')
		await settled(chat)

		expect(chat.getSnapshot().turn).toEqual({
			kind: 'failed',
			failure: { kind: 'truncated' }
		})
		expect(reports).toEqual([{ code: 'truncated', retrying: false }])
		expect(saved).toEqual([])

		chat.tryAgain()
		await settled(chat)

		expect(server.requests[1]?.body?.trigger).toBe('regenerate-message')
		expect(saved).toEqual(['answer-2'])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
		expect(texts(chat.chat.messages)).toEqual([
			'En lang rapport',
			'Sendt som #31'
		])
	})

	test('retries once when the network drops before any response, then fails as connection lost', async () => {
		const unreachable: Reply = () => {
			throw new TypeError('Network request failed')
		}
		const server = fakeServer([
			unreachable,
			unreachable,
			unreachable,
			unreachable
		])
		const chat = session(server)

		chat.send('Hej')
		await settled(chat)

		// The fetch's connect retry, then the turn's own retry with its connect retry.
		expect(server.requests).toHaveLength(4)
		expect(chat.getSnapshot().turn).toEqual({
			kind: 'failed',
			failure: { kind: 'connection-lost' }
		})
	})

	test('fails at once when the stream drops after part of the answer was shown', async () => {
		const server = fakeServer([
			droppedStream([
				{ type: 'start', messageId: 'answer-1' },
				{ type: 'text-start', id: 't1' },
				{ type: 'text-delta', id: 't1', delta: 'Halv' }
			])
		])
		const chat = session(server)

		chat.send('Hej')
		await settled(chat)

		expect(chat.getSnapshot().turn).toEqual({
			kind: 'failed',
			failure: { kind: 'connection-lost' }
		})
	})

	test('with resume, reattaches a dropped stream once and shows the replayed answer once', async () => {
		const chunks = answer('Hele svaret')
		const server = fakeServer([
			droppedStream(chunks.slice(0, 3)),
			stream(chunks)
		])
		const chat = session(server, { resume: true })

		chat.send('Hej')
		await settled(chat)

		expect(
			server.requests.map((request) => `${request.method} ${request.url}`)
		).toEqual([
			'POST https://api.test/chat',
			'GET https://api.test/chat/thread-1/stream'
		])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
		expect(texts(chat.chat.messages)).toEqual(['Hej', 'Hele svaret'])
	})

	test('with resume, Stop also tells the server to stop', async () => {
		let release = () => {}
		const hanging: Reply = ({ body }) =>
			new Response(
				new ReadableStream({
					start(controller) {
						release = () => controller.close()
						void body
					}
				}),
				{ headers: { 'content-type': 'text/event-stream' } }
			)
		const server = fakeServer([hanging, json(200, {})])
		const chat = session(server, { resume: true })

		chat.send('Hej')
		await new Promise((resolve) => setTimeout(resolve, 5))
		chat.stop()
		release()
		await settled(chat)

		expect(
			server.requests.map((request) => `${request.method} ${request.url}`)
		).toEqual([
			'POST https://api.test/chat',
			'POST https://api.test/chat/thread-1/stop'
		])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('with resume, reattaches to a running answer on request and stays quiet when none runs', async () => {
		const server = fakeServer([
			() => new Response(null, { status: 204 }),
			stream(answer('Fra serveren'))
		])
		const signals: (() => void)[] = []
		const chat = session(server, {
			resume: true,
			resumeOn: [
				(resume) => {
					signals.push(resume)

					return () => {}
				}
			]
		})

		chat.resumeStream()
		await settled(chat)

		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })

		signals[0]?.()
		await settled(chat)

		expect(server.requests.map((request) => request.method)).toEqual([
			'GET',
			'GET'
		])
		expect(texts(chat.chat.messages)).toEqual(['Fra serveren'])
	})

	test('with resume, a reattached answer shows the question the thread had not stored yet', async () => {
		const question: UIMessage = {
			id: 'question-2',
			role: 'user',
			parts: [{ type: 'text', text: 'Og i går?' }]
		}
		const [start, ...rest] = answer('I går: 3', 'answer-2')
		const server = fakeServer([
			stream([
				start!,
				{
					type: 'data-user-message',
					data: { message: question },
					transient: true
				} as UIMessageChunk,
				...rest
			])
		])
		const chat = session(server, {
			resume: true,
			messages: [
				{ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Hej' }] },
				{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hej!' }] }
			]
		})

		chat.resumeStream()
		await settled(chat)

		expect(texts(chat.chat.messages)).toEqual([
			'Hej',
			'Hej!',
			'Og i går?',
			'I går: 3'
		])
	})

	test('regenerate writes the newest answer again from the user message, once nothing runs', async () => {
		const server = fakeServer([
			stream(answer('Hej!')),
			stream(answer('Hej igen!', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Hej')
		await settled(chat)
		chat.regenerate()
		await settled(chat)

		expect(server.requests[1]?.body).toMatchObject({
			trigger: 'regenerate-message',
			messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hej' }] }]
		})
		expect(texts(chat.chat.messages)).toEqual(['Hej', 'Hej igen!'])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('waits for an approval and sends the answer only for the turn that waits', async () => {
		const server = fakeServer([
			stream([
				{ type: 'start', messageId: 'answer-1' },
				{
					type: 'tool-input-available',
					toolCallId: 'call-1',
					toolName: 'updateGoal',
					input: { amount: 5 },
					dynamic: true
				},
				{
					type: 'tool-approval-request',
					approvalId: 'run-1::call-1',
					toolCallId: 'call-1'
				},
				{ type: 'finish' }
			]),
			stream([
				{ type: 'start', messageId: 'answer-1' },
				{
					type: 'tool-output-available',
					toolCallId: 'call-1',
					output: { ok: true }
				},
				{ type: 'text-start', id: 't2' },
				{ type: 'text-delta', id: 't2', delta: 'Gjort.' },
				{ type: 'text-end', id: 't2' },
				{ type: 'finish' }
			])
		])
		const results: string[] = []
		const chat = session(server, {
			onToolResult: ({ toolName }) => results.push(toolName)
		})

		chat.send('Hæv målet')
		await settled(chat)

		const turn = chat.getSnapshot().turn

		expect(turn.kind).toBe('waiting')
		expect(turn.kind === 'waiting' && turn.changes).toEqual([
			{
				kind: 'approval',
				runId: 'run-1',
				toolCallId: 'call-1',
				toolName: 'updateGoal',
				approvalId: 'run-1::call-1',
				input: { amount: 5 }
			}
		])

		chat.answerApproval({ approvalId: 'run-1::call-1', approved: true })
		await settled(chat, ['idle', 'failed'])

		expect(server.requests).toHaveLength(2)
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
		expect(results).toEqual(['updateGoal'])
	})

	test('sends the answer to the first of two approvals in one step, then asks about the second', async () => {
		// Given a model that deletes two budgets in one step, run by the real
		// turn: Mastra asks about the first and leaves the second queued
		const one = toolCallReply(DELETE_TOOL, { budgetId: 'b-1' }, 'call-1')
		const two = toolCallReply(DELETE_TOOL, { budgetId: 'b-2' }, 'call-2')
		const step = [...one.slice(0, -1), two[1], one[2]] as ModelStreamPart[]
		const harness = createHarness({ replies: [step, textReply('Slettet.')] })
		const sent: unknown[] = []
		const results: string[] = []
		const chat = session(
			{
				requests: [],
				fetch: async (_input, init) => {
					const body = JSON.parse(String(init?.body))
					sent.push(body)
					const result = await harness.run(body)

					return result.kind === 'stream'
						? createUIMessageStreamResponse({ stream: result.stream })
						: Response.json({ code: result.code }, { status: 409 })
				}
			},
			{ onToolResult: ({ toolName }) => results.push(toolName) }
		)
		const waiting = () => {
			const turn = chat.getSnapshot().turn

			return turn.kind === 'waiting' ? turn.changes : []
		}

		chat.send('Slet begge budgetter')
		await settled(chat)

		expect(waiting().map((change) => change.toolCallId)).toEqual(['call-1'])

		// When the user confirms the one card that asks
		const [first] = waiting()
		if (first?.kind !== 'approval') throw new Error('No approval waits.')
		chat.answerApproval({ approvalId: first.approvalId, approved: true })
		await settled(chat)

		// Then the answer goes out and the second call asks in the same answer
		expect(sent).toHaveLength(2)
		const [second] = waiting()
		expect(second?.toolCallId).toBe('call-2')
		if (second?.kind !== 'approval') throw new Error('No approval waits.')

		// And answering it carries out both changes, with the run's older answer
		// to the first still in the message
		chat.answerApproval({ approvalId: second.approvalId, approved: true })
		await settled(chat, ['idle', 'failed'])

		expect(sent).toHaveLength(3)
		expect(results).toEqual([DELETE_TOOL, DELETE_TOOL])
		expect(texts(chat.chat.messages)).toEqual([
			'Slet begge budgetter',
			'Slettet.'
		])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('shows a stored page with its pending approval waiting, never sending on its own', async () => {
		const server = fakeServer([])
		const chat = session(server)
		const stored: UIMessage[] = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hæv målet' }] },
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: 'dynamic-tool',
						toolName: 'updateGoal',
						toolCallId: 'call-1',
						state: 'approval-requested',
						input: {},
						approval: { id: 'run-1::call-1' }
					}
				]
			}
		]

		chat.showStored({
			messages: stored,
			pendingChanges: [
				{
					kind: 'approval',
					runId: 'run-1',
					toolCallId: 'call-1',
					toolName: 'updateGoal',
					approvalId: 'run-1::call-1'
				}
			]
		})

		expect(chat.getSnapshot().turn.kind).toBe('waiting')
		expect(server.requests).toEqual([])
	})

	test('keeps the latest reply suggestions until the user writes', async () => {
		const server = fakeServer([
			stream([
				...answer('Svar').slice(0, -1),
				{
					type: 'data-reply-suggestions',
					data: { suggestions: ['Ja', ' ja ', 'Nej'] },
					transient: true
				},
				{ type: 'finish' }
			]),
			stream(answer('Ok', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Hej')
		await settled(chat)

		expect(chat.getSnapshot().replySuggestions).toEqual(['Ja', 'Nej'])

		chat.send('Ja')

		expect(chat.getSnapshot().replySuggestions).toEqual([])
		await settled(chat)
	})

	test('marks the answer complete when the server says so, until the next request', async () => {
		const server = fakeServer([
			stream([
				...answer('Svar').slice(0, -1),
				{ type: 'data-answer-complete', data: {}, transient: true },
				{ type: 'finish' }
			]),
			stream(answer('Ok', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Hej')
		await settled(chat)

		expect(chat.getSnapshot().answerComplete).toBe(true)

		chat.send('Tak')

		expect(chat.getSnapshot().answerComplete).toBe(false)
		await settled(chat)
	})

	test('ends the turn at the answer and still takes the replies that follow its finish', async () => {
		const first = heldStream([
			...answer('Svar'),
			{ type: 'data-answer-complete', data: {}, transient: true }
		])
		const server = fakeServer([first.reply])
		const saved: (string | undefined)[] = []
		const chat = session(server, {
			onSaved: ({ message }) => saved.push(message?.id)
		})

		chat.send('Hej')
		await waitFor(() => chat.getSnapshot().turn.kind === 'idle')

		// The stream is still open, yet the turn is over and the answer saved
		expect(chat.chat.status).toBe('streaming')
		expect(chat.getSnapshot().answerComplete).toBe(true)
		expect(saved).toEqual(['answer-1'])

		first.send([
			{
				type: 'data-reply-suggestions',
				data: { suggestions: ['Ja', 'Nej'] },
				transient: true
			}
		])
		first.end()
		await settled(chat)

		expect(chat.getSnapshot().replySuggestions).toEqual(['Ja', 'Nej'])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
		expect(saved).toEqual(['answer-1'])
		expect(texts(chat.chat.messages)).toEqual(['Hej', 'Svar'])
	})

	test('takes the replies a real turn streams after its finish', async () => {
		// Given the real turn with a suggestions agent, which finishes the
		// answer before it writes the replies
		const harness = createHarness({
			replies: [textReply('Du brugte 4.200 kr.')],
			suggestions: [textReply('{"suggestions":["Og i september?"]}')],
			overrides: { replySuggestions: { agentId: 'chat-suggestions' } }
		})
		const chat = session({
			requests: [],
			fetch: async (_input, init) => {
				const result = await harness.run(JSON.parse(String(init?.body)))

				if (result.kind !== 'stream') throw new Error('The turn was refused.')

				return createUIMessageStreamResponse({ stream: result.stream })
			}
		})

		chat.send('Mad?')
		await settled(chat)

		expect(texts(chat.chat.messages)).toEqual(['Mad?', 'Du brugte 4.200 kr.'])
		expect(chat.getSnapshot().replySuggestions).toEqual(['Og i september?'])
		expect(chat.getSnapshot().answerComplete).toBe(true)
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('sends a new message while the replies still stream, and drops those replies', async () => {
		const first = heldStream([
			...answer('Første'),
			{ type: 'data-answer-complete', data: {}, transient: true }
		])
		const server = fakeServer([
			first.reply,
			stream(answer('Anden', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Et')
		await waitFor(() => chat.getSnapshot().turn.kind === 'idle')

		chat.send('To')
		await settled(chat)

		expect(server.requests).toHaveLength(2)
		expect(server.requests[1]?.body).toMatchObject({
			messages: [{ role: 'user', parts: [{ type: 'text', text: 'To' }] }]
		})
		expect(texts(chat.chat.messages)).toEqual(['Et', 'Første', 'To', 'Anden'])
		expect(chat.getSnapshot().replySuggestions).toEqual([])
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})

	test('sends a message queued mid-answer as soon as the answer is complete', async () => {
		const first = heldStream([
			{ type: 'start', messageId: 'answer-1' },
			{ type: 'text-start', id: 't1' },
			{ type: 'text-delta', id: 't1', delta: 'Første' }
		])
		const server = fakeServer([
			first.reply,
			stream(answer('Anden', 'answer-2'))
		])
		const chat = session(server)

		chat.send('Et')
		await waitFor(() => chat.getSnapshot().turn.kind === 'streaming')
		chat.send('To')

		// The answer ends, and its stream stays open for the replies
		first.send([
			{ type: 'text-end', id: 't1' },
			{ type: 'finish' },
			{ type: 'data-answer-complete', data: {}, transient: true }
		])
		await settled(chat)

		expect(server.requests).toHaveLength(2)
		expect(texts(chat.chat.messages)).toEqual(['Et', 'Første', 'To', 'Anden'])
	})

	test('stops and restores the message of a session that is not on screen', () => {
		const server = fakeServer([])
		const chat = session(server)

		chat.setFocused(false)
		chat.send('Hej')

		expect(server.requests).toEqual([])
		expect(chat.getSnapshot().restoredDraft).toEqual({
			text: 'Hej',
			sequence: 1
		})
		expect(chat.getSnapshot().turn).toEqual({ kind: 'idle' })
	})
})
