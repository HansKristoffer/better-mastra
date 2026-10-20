/**
 * Mastra's API for Studio, on a developer's machine only: Mastra's routes on
 * a sub-app at `path` (served under `{path}/api/...`), for trying an agent,
 * reading traces and running datasets. The mount registers every Mastra
 * route, tool execution and memory included, so it never runs in production
 * and answers only requests from this machine.
 *
 * Studio's pages run on their own port and call this API across origins:
 *
 *     bunx mastra studio --port 3111 --server-port <API_PORT> --server-api-prefix <path>/api
 *
 * A chat agent runs only in a prepared turn, so the routes that start an agent
 * run hand Studio's request context form to `prepareRequestContext`, which
 * builds the run's request context (and its turn plan) as that user.
 */

import type { Mastra } from '@mastra/core/mastra'
import type { RequestContext } from '@mastra/core/request-context'
import type { MastraServer } from '@mastra/hono'
import {
	type Context,
	type Env,
	Hono,
	type MiddlewareHandler,
	type Next
} from 'hono'
import { cors } from 'hono/cors'

export interface MountStudioOptions {
	readonly mastra: Mastra
	/**
	 * The run's request context from Studio's form values, or a refusal shown
	 * in Studio. Called for the routes that start an agent run.
	 */
	prepareRequestContext(
		form: Readonly<Record<string, unknown>>,
		agentId: string
	): Promise<
		RequestContext | { readonly error: string; readonly status: 400 | 403 }
	>
	/** Where the sub-app is mounted. Default `/ai`. */
	readonly path?: string
	/** Studio's own port, the only origin CORS allows. Default 3111. */
	readonly studioPort?: number
	/** Whether to mount at all. Default: `NODE_ENV` is not `production`. */
	readonly enabled?: boolean
	/** The caller's address; the default reads Bun's server from Hono's env. */
	remoteAddress?(c: Context): string | undefined
}

/** The routes that start an agent run: stream and generate in every variant, and the message routes Studio's chat sends to. */
const AGENT_RUN_ROUTE =
	/\/api\/agents\/([^/]+)\/(stream|generate|send-message|queue-message)/

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
	'127.0.0.1',
	'::1',
	'::ffff:127.0.0.1'
])

/** The part of a message route's body that holds Studio's form. */
interface StudioMessageBody {
	readonly ifIdle?: {
		readonly streamOptions?: {
			readonly requestContext?: Readonly<Record<string, unknown>>
		}
	}
}

/** Mounts Studio's API on `app`; returns false, loading nothing, when not enabled. */
export async function mountStudio<E extends Env>(
	app: Hono<E>,
	options: MountStudioOptions
): Promise<boolean> {
	const enabled = options.enabled ?? process.env.NODE_ENV !== 'production'

	if (!enabled) return false

	const path = options.path ?? '/ai'
	const port = options.studioPort ?? 3111
	const remoteAddress = options.remoteAddress ?? bunRemoteAddress
	// Loaded on use, so a production bundle never carries the adapter.
	const { MastraServer } = (await import(
		'@mastra/hono' as string
	)) as typeof import('@mastra/hono')
	const studio = new Hono()

	studio.use('*', async (c, next) => {
		const address = remoteAddress(c)

		if (address === undefined || !LOOPBACK_ADDRESSES.has(address)) {
			return c.json(
				{ error: 'Studio answers only requests from this machine.' },
				403
			)
		}

		return next()
	})
	studio.use(
		'*',
		cors({
			origin: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
			credentials: true
		})
	)

	const server = createStudioServer(MastraServer, {
		app: studio,
		mastra: options.mastra,
		prepare: options.prepareRequestContext
	})

	await server.init()
	app.route(path, studio)

	return true
}

/**
 * Mastra's Hono adapter with the bridge inside its context middleware: the
 * route handlers read the request context that middleware sets and never call
 * `next`, so a middleware of our own before it would be overwritten and one
 * after it would never run.
 */
function createStudioServer(
	Server: typeof MastraServer,
	input: {
		readonly app: Hono
		readonly mastra: Mastra
		readonly prepare: MountStudioOptions['prepareRequestContext']
	}
): MastraServer {
	class StudioServer extends Server {
		override createContextMiddleware(): MiddlewareHandler {
			const setRequestContext = super.createContextMiddleware()

			return (c, next) =>
				setRequestContext(c, () => bridgeAgentRun(c, next, input.prepare))
		}
	}

	return new StudioServer({ app: input.app, mastra: input.mastra })
}

async function bridgeAgentRun(
	c: Context,
	next: Next,
	prepare: MountStudioOptions['prepareRequestContext']
): Promise<void> {
	const agentId =
		c.req.method === 'POST' ? AGENT_RUN_ROUTE.exec(c.req.path)?.[1] : undefined

	if (!agentId) return next()

	const prepared = await prepare(await readStudioForm(c), agentId)

	if ('error' in prepared) {
		c.res = c.json({ error: prepared.error }, prepared.status)
		return
	}

	c.set('requestContext', prepared)
	return next()
}

/**
 * Studio's form values: the run routes carry them as the body's
 * `requestContext`, which Mastra has already read; the message routes carry
 * them in `ifIdle.streamOptions.requestContext`.
 */
async function readStudioForm(c: Context): Promise<Record<string, unknown>> {
	// A clone: Mastra reads the body again when it handles the route.
	const body = (await c.req.raw
		.clone()
		.json()
		.catch(() => ({}))) as StudioMessageBody
	const current = c.get('requestContext') as RequestContext | undefined

	return {
		...(current && Object.fromEntries(current.entries())),
		...body.ifIdle?.streamOptions?.requestContext
	}
}

function bunRemoteAddress(c: Context): string | undefined {
	const server = c.env as
		| { requestIP?: (request: Request) => { address: string } | null }
		| undefined

	return server?.requestIP?.(c.req.raw)?.address
}
