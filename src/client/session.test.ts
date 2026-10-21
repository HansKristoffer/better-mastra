import { describe, expect, test } from 'bun:test'
import {
	createUIMessageStreamResponse,
	type UIMessage,
	type UIMessageChunk
} from 'ai'
import { z } from 'zod'

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
