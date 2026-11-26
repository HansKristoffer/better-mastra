/**
 * The chat's HTTP adapter: one `POST {path}` turns a request into a turn. It
 * authenticates, parses the body and hands the request to the injected turn,
 * whose stream it sends as SSE with a heartbeat. With `resumable`, the run is
 * no longer bound to the request: a disconnect leaves it running,
 * `GET {path}/:threadId/stream` reconnects to it and
 * `POST {path}/:threadId/stop` ends it.
 */

import { type Context, type Env, Hono } from 'hono'

import type { RequestContext } from '@mastra/core/request-context'

import {
	type ChangePlanProgress,
	type ChangePlanRefusalCode,
	changePlanRefusalStatuses
} from '../protocol/index.js'
import {
	type ApplyChangePlanResult,
	applyChangePlan,
	discardChangePlan,
	type PlanTool,
	readChangePlan
} from '../tools/changePlans.js'
import { readTurnDataset } from '../tools/datasets.js'
import type { ChatRecordStore } from '../tools/records.js'
import { chatErrorResponse } from '../turn/errors.js'
import { SSE_HEARTBEAT_MS, toChatStreamResponse } from '../turn/response.js'
import type { ChatTurnRequest, ChatTurnResult } from '../turn/runChatTurn.js'
import type { ChatRefusal, ChatTurnBody } from '../turn/types.js'
import type { ResumableStreams } from '../resumable/index.js'
import { replayPrefixOf } from '../resumable/replay.js'
import { toUserFacingMessage } from '../turn/stream.js'

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
	/**
	 * Whether the thread is the caller's; required with `resumable`.
	 * `undefined` when no such thread exists yet, as for a thread the client
	 * opened but never sent to: reconnecting answers 204 and stop
	 * `{ stopped: false }`, while a thread of someone else is `not_found`.
	 */
	ownsThread?(threadId: string, auth: TAuth): Promise<boolean | undefined>
	readonly heartbeatMs?: number
	/**
	 * Adds the change plan routes, for the thread's owner only (`ownsThread`
	 * is required): `GET {path}/:threadId/plans/:planId` reads a plan,
	 * `POST …/apply` applies it and streams its progress as NDJSON
	 * (`ChangePlanProgress` per line), `POST …/discard` discards it. A plan
	 * that cannot be applied or discarded answers `{ error }` with
	 * `changePlanRefusalStatuses`.
	 */
	readonly changePlans?: {
		readonly store: ChatRecordStore
		/** The plan-tier tools steps may name; `DefinedTool`s. */
		readonly tools: readonly PlanTool[]
		/**
		 * The apply request's context, built from the caller as a turn builds
		 * it: each step's guard and hidden inputs read it.
		 */
		requestContext(
			auth: TAuth,
			threadId: string
			// biome-ignore lint/suspicious/noExplicitAny: a context the app typed is not a RequestContext<unknown>.
		): RequestContext<any> | Promise<RequestContext<any>>
		/** How long a runner holds a plan without renewing. Default 60 s. */
		readonly leaseMs?: number
		/** A read or write error the user does not see, for the log. */
		readonly onError?: (
			error: unknown,
			event: { readonly tool: string; readonly step: number }
		) => void
	}
	/**
	 * Adds `GET {path}/:threadId/datasets/:datasetId`, for the thread's owner
	 * only (`ownsThread` is required): a dataset's rows by id, for a client
	 * that shows a stored answer. `{ dataset }`, or 404.
	 */
	readonly datasets?: { readonly store: ChatRecordStore }
	/**
	 * The refusals the route answers itself, in the app's codes: a caller
	 * without `auth` (`unauthenticated`), a body `parseBody` rejects
	 * (`invalid_request`), a thread that is not the caller's on reconnect or
	 * stop (`not_found`). Each defaults to the built-in code.
	 */
	readonly refusals?: Partial<Record<RouteRefusal, ChatRefusal>>
}

/** The refusals `createChatRoute` answers without running a turn. */
export type RouteRefusal = 'unauthenticated' | 'invalid_request' | 'not_found'

/** The routes on a Hono app of their own; mount it with `app.route('/', createChatRoute(...))`. */
export function createChatRoute<
	TAuth,
	TBody extends ChatTurnBody,
	E extends Env = Env
>(options: ChatRouteOptions<TAuth, TBody, E>): Hono<E> {
	const app = new Hono<E>()
	const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS
	const { resumable } = options
	const refuse = (refusal: RouteRefusal) =>
		chatErrorResponse(options.refusals?.[refusal] ?? refusal)

	if (resumable && !options.ownsThread) {
		throw new Error('A resumable chat route needs ownsThread.')
	}

	if (options.changePlans && !options.ownsThread) {
		throw new Error('A chat route with change plans needs ownsThread.')
	}

	if (options.datasets && !options.ownsThread) {
		throw new Error('A chat route with datasets needs ownsThread.')
	}

	app.post(options.path, async (c) => {
		const auth = await options.auth(c)

		if (!auth) return refuse('unauthenticated')

		const json: unknown = await c.req.raw.json().catch(() => undefined)
		const body = await options.parseBody(json, auth)

		if (!body) return refuse('invalid_request')

		// A turn started now would be cut off at the end of the drain: the client tries again on the next process.
		if (resumable?.draining) return drainingResponse()

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

		let stream = result.stream

		if (resumable) {
			try {
				stream = await resumable.start({
					threadKey: result.threadKey.threadId,
					resourceId: result.threadKey.resourceId,
					stream: result.stream,
					abort: abort!,
					// A turn that goes on with an earlier answer streams only what it adds.
					replayPrefix: replayPrefixOf(body.messages.map(toUserFacingMessage))
				})
			} catch (error) {
				// The run is already going and nothing reads it: end it rather than leave it to the process's exit.
				abort!.abort('shutdown')
				await result.stream.cancel().catch(() => {})
				if (resumable.draining) return drainingResponse()
				throw error
			}
		}

		return toChatStreamResponse(stream, heartbeatMs)
	})

	const owned = async (c: Context<E>) => {
		const auth = await options.auth(c)
		const threadId = c.req.param('threadId')

		if (!auth) return { refusal: refuse('unauthenticated') }

		if (!threadId) return { refusal: refuse('not_found') }

		const owns = await options.ownsThread!(threadId, auth)

		if (owns === false) return { refusal: refuse('not_found') }

		return { threadId, exists: owns === true, auth }
	}

	if (options.changePlans)
		mountChangePlans(app, options.path, options.changePlans, owned)

	const datasets = options.datasets

	if (datasets) {
		app.get(`${options.path}/:threadId/datasets/:datasetId`, async (c) => {
			const { refusal, threadId, exists } = await owned(c)

			if (refusal) return refusal

			const dataset = exists
				? await readTurnDataset({
						store: datasets.store,
						datasetId: c.req.param('datasetId') ?? '',
						threadId
					})
				: null

			return dataset
				? c.json({ dataset }, 200, { 'Cache-Control': 'private, max-age=3600' })
				: refuse('not_found')
		})
	}

	if (!resumable) return app

	app.get(`${options.path}/:threadId/stream`, async (c) => {
		const { refusal, threadId, exists } = await owned(c)

		if (refusal) return refusal

		if (!exists) return new Response(null, { status: 204 })

		keepConnectionOpen(c)

		const stream = await resumable.reconnect(threadId, c.req.raw.signal)

		return stream
			? toChatStreamResponse(stream, heartbeatMs)
			: new Response(null, { status: 204 })
	})

	app.post(`${options.path}/:threadId/stop`, async (c) => {
		const { refusal, threadId, exists } = await owned(c)

		if (refusal) return refusal

		return c.json({ stopped: exists && (await resumable.stop(threadId)) })
	})

	return app
}

type OwnedThread<TAuth> =
	| {
			readonly refusal: Response
			readonly threadId?: undefined
			readonly exists?: undefined
			readonly auth?: undefined
	  }
	| {
			readonly refusal?: undefined
			readonly threadId: string
			readonly exists: boolean
			readonly auth: TAuth
	  }

function mountChangePlans<TAuth, E extends Env>(
	app: Hono<E>,
	path: string,
	plans: NonNullable<ChatRouteOptions<TAuth, ChatTurnBody, E>['changePlans']>,
	owned: (c: Context<E>) => Promise<OwnedThread<TAuth>>
): void {
	const planPath = `${path}/:threadId/plans/:planId`
	// A plan lives in a thread that exists; any other answer is not found.
	const ownedPlan = async (
		c: Context<E>
	): Promise<
		| {
				readonly refusal: Response
				readonly threadId?: undefined
				readonly planId?: undefined
				readonly auth?: undefined
		  }
		| {
				readonly refusal?: undefined
				readonly threadId: string
				readonly planId: string
				readonly auth: TAuth
		  }
	> => {
		const thread = await owned(c)

		if (thread.refusal) return { refusal: thread.refusal }

		if (!thread.exists) return { refusal: planRefusal('not_found') }

		return {
			threadId: thread.threadId,
			auth: thread.auth,
			planId: c.req.param('planId') ?? ''
		}
	}

	app.get(planPath, async (c) => {
		const { refusal, threadId, planId } = await ownedPlan(c)

		if (refusal) return refusal

		const plan = await readChangePlan({ store: plans.store, planId, threadId })

		return plan ? c.json({ plan }) : planRefusal('not_found')
	})

	app.post(`${planPath}/discard`, async (c) => {
		const { refusal, threadId, planId } = await ownedPlan(c)

		if (refusal) return refusal

		const result = await discardChangePlan({
			store: plans.store,
			planId,
			threadId
		})

		return result.kind === 'refused'
			? planRefusal(result.code)
			: c.json({ plan: result.plan })
	})

	app.post(`${planPath}/apply`, async (c) => {
		const { refusal, threadId, planId, auth } = await ownedPlan(c)

		if (refusal) return refusal

		keepConnectionOpen(c)

		const requestContext = await plans.requestContext(auth, threadId)

		return streamApply((onProgress) =>
			applyChangePlan({
				store: plans.store,
				planId,
				threadId,
				tools: plans.tools,
				requestContext,
				onProgress,
				...(plans.leaseMs !== undefined && { leaseMs: plans.leaseMs }),
				...(plans.onError && { onError: plans.onError })
			})
		)
	})
}

/**
 * Runs the apply and answers once it is known whether the plan was claimed:
 * a refusal as `{ error }` with its status, a claimed plan as an NDJSON
 * stream of its progress. The plan runs to its end even when the caller goes
 * away; another window follows it with the GET route.
 */
async function streamApply(
	run: (
		onProgress: (event: ChangePlanProgress) => void
	) => Promise<ApplyChangePlanResult>
): Promise<Response> {
	const encoder = new TextEncoder()
	const buffered: ChangePlanProgress[] = []
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	let started: () => void = () => {}
	const firstEvent = new Promise<'started'>((resolve) => {
		started = () => resolve('started')
	})
	const send = (event: ChangePlanProgress) => {
		try {
			controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
		} catch {
			// The caller went away; the plan goes on.
		}
	}
	const running = run((event) => {
		started()
		if (controller) send(event)
		else buffered.push(event)
	})
	const first = await Promise.race([firstEvent, running])

	if (first !== 'started' && first.kind === 'refused')
		return planRefusal(first.code)

	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController
			for (const event of buffered.splice(0)) send(event)
			running
				.catch(() => {})
				.finally(() => {
					try {
						streamController.close()
					} catch {
						// Already closed by a gone caller.
					}
				})
		}
	})

	return new Response(body, {
		headers: {
			'Content-Type': 'application/x-ndjson',
			'Cache-Control': 'no-store'
		}
	})
}

function planRefusal(code: ChangePlanRefusalCode): Response {
	return Response.json(
		{ error: code },
		{ status: changePlanRefusalStatuses[code] }
	)
}

/** What the chat client retries once on its own, after a second (`createChatFetch`'s `retry.draining`). */
function drainingResponse(): Response {
	return Response.json(
		{ status: 'draining' },
		{
			status: 503,
			headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' }
		}
	)
}

/**
 * The answer streams for as long as the turn runs, so Bun's idle timeout
 * (Bun passes its server as Hono's env) must not close a quiet connection.
 */
function keepConnectionOpen(c: Context): void {
	const server = c.env as
		{ timeout?: (request: Request, seconds: number) => void } | undefined

	if (typeof server?.timeout === 'function') {
		server.timeout(c.req.raw, 0)
	}
}
