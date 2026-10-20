import { describe, expect, test } from 'bun:test'
import type { UIMessageChunk } from 'ai'
import { Hono } from 'hono'

import type { ChatTurnRequest } from '../turn/runChatTurn.js'
import { refused } from '../turn/runChatTurn.js'
import type { ChatTurnBody } from '../turn/types.js'
import { createChatRoute } from './chatRoute.js'
import type { ResumableStreams } from './types.js'

const THREAD = { threadId: 'thread-1', resourceId: 'org:user' }

function answer(): ReadableStream<UIMessageChunk> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: 'start' })
			controller.enqueue({ type: 'finish' })
			controller.close()
		}
	})
}

function appWith(options: {
	readonly resumable?: ResumableStreams
	readonly seen?: ChatTurnRequest<string, ChatTurnBody>[]
}) {
	return new Hono().route(
		'/',
		createChatRoute<string, ChatTurnBody>({
			path: '/chat',
			auth: async (c) => c.req.header('authorization') ?? null,
			parseBody: (json) =>
				typeof json === 'object' && json && 'messages' in json
					? (json as ChatTurnBody)
					: undefined,
			runTurn: async (request) => {
				options.seen?.push(request)
				return request.body.messages.length === 0
					? refused('turn_in_progress')
					: { kind: 'stream', threadKey: THREAD, stream: answer() }
			},
			...(options.resumable && {
				resumable: options.resumable,
				ownsThread: async (threadId, auth) =>
					threadId === 'thread-1' && auth === 'user'
			})
		})
	)
}

const post = (body: unknown, auth = 'user') =>
	new Request('http://test/chat', {
		method: 'POST',
		headers: { authorization: auth, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})

const MESSAGE = {
	id: 'm',
	role: 'user',
	parts: [{ type: 'text', text: 'Hej' }]
}

describe('createChatRoute', () => {
	test('should refuse without a caller, with a bad body, and pass the turn refusal on', async () => {
		const app = appWith({})

		expect(
			(await app.request(new Request('http://test/chat', { method: 'POST' })))
				.status
		).toBe(401)
		expect((await app.request(post({ nope: true }))).status).toBe(400)
		expect((await app.request(post({ messages: [] }))).status).toBe(409)
	})

	test('should stream the turn as SSE, bound to the request signal', async () => {
		const seen: ChatTurnRequest<string, ChatTurnBody>[] = []
		const request = post({ messages: [MESSAGE] })

		const response = await appWith({ seen }).request(request)

		expect(response.headers.get('content-type')).toContain('text/event-stream')
		expect(await response.text()).toContain('"type":"finish"')
		expect(seen[0]?.signal).toBe(request.signal)
	})

	test('with resumable streams should run past the request and add reconnect and stop', async () => {
		const started: { threadKey: string; abort: AbortController }[] = []
		const resumable: ResumableStreams = {
			start: async ({ threadKey, stream, abort }) => {
				started.push({ threadKey, abort })
				return stream
			},
			reconnect: async (threadKey) =>
				threadKey === 'thread-1' && started.length > 0 ? answer() : null,
			stop: async () => {
				started[0]?.abort.abort()
				return true
			},
			close: async () => {}
		}
		const seen: ChatTurnRequest<string, ChatTurnBody>[] = []
		const app = appWith({ resumable, seen })
		const auth = { headers: { authorization: 'user' } }

		expect((await app.request('/chat/thread-1/stream', auth)).status).toBe(204)
		const request = post({ messages: [MESSAGE] })
		await (await app.request(request)).text()
		const reconnected = await app.request('/chat/thread-1/stream', auth)
		const stopped = await app.request('/chat/thread-1/stop', {
			method: 'POST',
			...auth
		})

		expect(seen[0]?.signal).not.toBe(request.signal)
		expect(started[0]?.threadKey).toBe('thread-1')
		expect(reconnected.status).toBe(200)
		expect(await stopped.json()).toEqual({ stopped: true })
		expect(seen[0]?.signal.aborted).toBe(true)
		expect((await app.request('/chat/thread-2/stream', auth)).status).toBe(404)
	})
})
