/**
 * The chat's HTTP adapter: one `POST {path}` turns a request into a turn. It
 * authenticates, parses the body and hands the request to the injected turn,
 * whose stream it sends as SSE with a heartbeat. With `resumable`, the run is
 * no longer bound to the request: a disconnect leaves it running,
 * `GET {path}/:threadId/stream` reconnects to it and
 * `POST {path}/:threadId/stop` ends it.
 */

import { type Context, type Env, Hono } from 'hono'

import { chatErrorResponse } from '../turn/errors.js'
import { SSE_HEARTBEAT_MS, toChatStreamResponse } from '../turn/response.js'
import type { ChatTurnRequest, ChatTurnResult } from '../turn/runChatTurn.js'
import type { ChatTurnBody } from '../turn/types.js'
import type { ResumableStreams } from './types.js'

export interface ChatRouteOptions<
	TAuth,
	TBody extends ChatTurnBody,
	E extends Env = Env
> {
	readonly path: string
	/** The caller, or null for 401. */
	auth(c: Context<E>): Promise<TAuth | null>
	/** The checked body, or undefined for 400. A body that is not JSON arrives as undefined. */
	parseBody(
		json: unknown,
		auth: TAuth
	): Promise<TBody | undefined> | TBody | undefined
	runTurn(request: ChatTurnRequest<TAuth, TBody>): Promise<ChatTurnResult>
	/** Keeps a turn running past a disconnect, reachable again by its thread. */
	readonly resumable?: ResumableStreams
	/** Whether the thread is the caller's; required with `resumable`. */
	ownsThread?(threadId: string, auth: TAuth): Promise<boolean>
	readonly heartbeatMs?: number
}

/** The routes on a Hono app of their own; mount it with `app.route('/', createChatRoute(...))`. */
export function createChatRoute<
	TAuth,
	TBody extends ChatTurnBody,
	E extends Env = Env
>(options: ChatRouteOptions<TAuth, TBody, E>): Hono<E> {
	const app = new Hono<E>()
	const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS
	const { resumable } = options

	if (resumable && !options.ownsThread) {
		throw new Error('A resumable chat route needs ownsThread.')
	}

	app.post(options.path, async (c) => {
		const auth = await options.auth(c)

		if (!auth) return chatErrorResponse('unauthenticated')

		const json: unknown = await c.req.raw.json().catch(() => undefined)
		const body = await options.parseBody(json, auth)

		if (!body) return chatErrorResponse('invalid_request')

		keepConnectionOpen(c)

		// With a resumable stream, Stop and the turn's own end abort the run, never a disconnect.
		const abort = resumable ? new AbortController() : undefined
		const result = await options.runTurn({
			auth,
			body,
			headers: c.req.raw.headers,
			signal: abort?.signal ?? c.req.raw.signal
		})

		if (result.kind === 'refused') return result.response

		const stream = resumable
			? await resumable.start({
					threadKey: result.threadKey.threadId,
					stream: result.stream,
					abort: abort!
				})
			: result.stream

		return toChatStreamResponse(stream, heartbeatMs)
	})

	if (!resumable) return app

	const owned = async (c: Context<E>) => {
		const auth = await options.auth(c)
		const threadId = c.req.param('threadId')

		if (!auth) return { refusal: chatErrorResponse('unauthenticated') }

		if (!threadId || !(await options.ownsThread!(threadId, auth))) {
			return { refusal: chatErrorResponse('not_found') }
		}

		return { threadId }
	}

	app.get(`${options.path}/:threadId/stream`, async (c) => {
		const { refusal, threadId } = await owned(c)

		if (refusal) return refusal

		keepConnectionOpen(c)

		const stream = await resumable.reconnect(threadId, c.req.raw.signal)

		return stream
			? toChatStreamResponse(stream, heartbeatMs)
			: new Response(null, { status: 204 })
	})

	app.post(`${options.path}/:threadId/stop`, async (c) => {
		const { refusal, threadId } = await owned(c)

		if (refusal) return refusal

		return c.json({ stopped: await resumable.stop(threadId) })
	})

	return app
}

/**
 * The answer streams for as long as the turn runs, so Bun's idle timeout
 * (Bun passes its server as Hono's env) must not close a quiet connection.
 */
function keepConnectionOpen(c: Context): void {
	const server = c.env as
		| { timeout?: (request: Request, seconds: number) => void }
		| undefined

	if (typeof server?.timeout === 'function') {
		server.timeout(c.req.raw, 0)
	}
}
