import { raceAbort, promiseTimeout, safeJsonParse, tryCatch } from 'hanzio'
/**
 * The chat's fetch: the platform's fetch (`expo/fetch` on React Native, which
 * streams a body) with the headers the app adds, one connect retry for a
 * request that never reached the server, one retry for a server that is
 * draining for a deploy, and a response body that fails as a lost connection
 * whatever error the platform gives it. A response that is not OK reaches the
 * AI SDK unchanged, which fails the request with an `APICallError` carrying
 * its status and body.
 */

// TYPES

/** A fetch the AI SDK transport can call. `expo/fetch` fits once its response is cast. */
export type ChatFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>

/** A response that is not OK, with its body read as JSON when it is JSON. */
export interface ChatErrorResponse {
	readonly status: number
	readonly body: unknown
}

export interface ChatFetchOptions {
	/** The platform fetch; `globalThis.fetch` when left out. */
	readonly fetch?: ChatFetch
	/** Headers every request carries, read per request: a session cookie, an origin. */
	readonly headers?: () =>
		HeadersInit | undefined | Promise<HeadersInit | undefined>
	readonly retry?: {
		/** Wait before retrying a request the network dropped before any response. */
		readonly connect?: number | false
		/** Wait before retrying a request a draining server turned away (`503 { status: 'draining' }`). */
		readonly draining?: number | false
		/** Maximum retries on `503 { status: 'draining' }`. Default 2. */
		readonly drainingRetries?: number
	}
	/** Hears of every response that is not OK, after the retries. */
	readonly onErrorResponse?: (response: ChatErrorResponse) => void
	/** The session is gone: sign the user out. */
	readonly onUnauthorized?: () => void
	/** Waits before a retry. */
	readonly delay?: (ms: number) => Promise<void>
}

/** An abort signal, structurally: React Native declares its own global `AbortSignal`. */
type SignalLike = { readonly aborted: boolean } | null | undefined

/** Headers in any form `Headers` takes. */
export type HeadersInit = ConstructorParameters<typeof Headers>[0]

// CONSTANTS

/** Wait before retrying a request that never reached the server. */
export const CHAT_CONNECT_RETRY_DELAY_MS = 300

/** Wait before retrying a request a draining server turned away: its `Retry-After` is one second. */
export const CHAT_DRAINING_RETRY_DELAY_MS = 1_000

/** Errors that happen before the server can receive the request (safe to retry on POST). */
const PRE_RECEIPT_NETWORK_ERROR_WORDS = [
	'network',
	'offline',
	'failed to fetch',
	'fetch failed',
	'load failed',
	'could not connect',
	'failed to connect',
	'unable to resolve host',
	'hostname could not be found'
] as const

/**
 * Words in the messages fetch implementations give a request the network
 * dropped: browsers, Node, and the iOS and Android errors `expo/fetch` passes on.
 */
const TRANSIENT_NETWORK_ERROR_WORDS = [
	...PRE_RECEIPT_NETWORK_ERROR_WORDS,
	'timed out',
	'timeout',
	'connection reset',
	'connection abort',
	'unexpected end of stream'
] as const

// ERRORS

/**
 * A request that got no response, or whose answer stopped arriving: the
 * network, not the server, failed it. A `TypeError` whose message names the
 * network, the way platform fetches fail, so the AI SDK reports it with
 * `isDisconnect` and keeps the stream's state for `resumeStream()`.
 */
export class ChatConnectionLostError extends TypeError {
	constructor(cause: unknown) {
		super('The network connection to the chat was lost.', { cause })
		this.name = 'ChatConnectionLostError'
	}
}

// FUNCTIONS

/** The fetch the chat transport goes out on. */
export function createChatFetch(options: ChatFetchOptions = {}): ChatFetch {
	const baseFetch: ChatFetch =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const hasCustomDelay = options.delay !== undefined
	const wait = async (ms: number, signal: SignalLike): Promise<void> => {
		if (options.delay) {
			await options.delay(ms)
			throwIfAborted(signal)
			return
		}
		if (signal && 'addEventListener' in signal) {
			await raceAbort(promiseTimeout(ms), signal as AbortSignal).catch(
				(error) => {
					if (isAbort(error, signal)) throwIfAborted(signal)
					throw error
				}
			)
		} else {
			await promiseTimeout(ms)
			throwIfAborted(signal)
		}
	}
	const connectDelay = options.retry?.connect ?? CHAT_CONNECT_RETRY_DELAY_MS
	const drainingDelay = options.retry?.draining ?? CHAT_DRAINING_RETRY_DELAY_MS
	const maxDrainingRetries = options.retry?.drainingRetries ?? 2

	const send = async (
		input: string | URL | Request,
		init: RequestInit | undefined,
		connectRetries: number,
		drainingRetries: number
	): Promise<Response> => {
		let response: Response
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase()
		const isIdempotent = method === 'GET' || method === 'HEAD'

		try {
			response = await baseFetch(input, init)
		} catch (error) {
			if (isAbort(error, init?.signal)) {
				throw error
			}

			const canRetryConnect =
				connectRetries === 0 &&
				connectDelay !== false &&
				(isIdempotent
					? isTransientNetworkError(error)
					: isPreReceiptNetworkError(error))

			if (canRetryConnect) {
				await wait(connectDelay, init?.signal)

				return send(input, init, connectRetries + 1, drainingRetries)
			}

			throw new ChatConnectionLostError(error)
		}

		if (response.ok) {
			return withLostConnectionBody(response, init?.signal)
		}

		const text = await readText(response)
		const parsed = safeJsonParse(text)
		const body = parsed.ok ? parsed.data : undefined

		if (
			drainingRetries < maxDrainingRetries &&
			drainingDelay !== false &&
			isDraining(response.status, body)
		) {
			const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'))
			const baseMs = retryAfter ?? drainingDelay
			// Spread deploy reconnects across a +/-25% jitter window to prevent thundering herds.
			const jitteredMs = hasCustomDelay
				? baseMs
				: Math.round(baseMs * (0.75 + Math.random() * 0.5))
			await wait(jitteredMs, init?.signal)

			return send(input, init, connectRetries, drainingRetries + 1)
		}

		if (response.status === 401) {
			options.onUnauthorized?.()
		}

		options.onErrorResponse?.({ status: response.status, body })

		// The body is read; the AI SDK reads it again from this copy.
		return new Response(text, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		})
	}

	return async (input, init) =>
		send(input, await withHeaders(init, options), 0, 0)
}

function isPreReceiptNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === 'AbortError') {
		return false
	}
	const message = error.message.toLowerCase()
	return PRE_RECEIPT_NETWORK_ERROR_WORDS.some((word) => message.includes(word))
}

function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined
	const seconds = Number(header.trim())
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined
}

/** Whether an error looks like the network dropped the request, which a retry may get past. An abort never does. */
export function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === 'AbortError') {
		return false
	}

	if (error instanceof ChatConnectionLostError) {
		return true
	}

	const message = error.message.toLowerCase()

	return TRANSIENT_NETWORK_ERROR_WORDS.some((word) => message.includes(word))
}

async function withHeaders(
	init: RequestInit | undefined,
	options: ChatFetchOptions
): Promise<RequestInit | undefined> {
	const extra = await options.headers?.()

	if (extra === undefined) {
		return init
	}

	const headers = new Headers(init?.headers)

	for (const [key, value] of new Headers(extra)) {
		headers.set(key, value)
	}

	// A plain record: `expo/fetch` takes no `Headers` instance.
	return { ...init, headers: Object.fromEntries(headers) }
}

/**
 * The response with a body whose read fails as a lost connection for any
 * reason but Stop. A proxy rather than a new `Response`, because React
 * Native's `Response` cannot wrap a stream.
 */
function withLostConnectionBody(
	response: Response,
	signal: SignalLike
): Response {
	if (response.body === null) {
		return response
	}

	const body = failAsLostConnection(response.body, signal)

	return new Proxy(response, {
		get: (target, key) => {
			if (key === 'body') {
				return body
			}

			const value = Reflect.get(target, key, target)

			return typeof value === 'function' ? value.bind(target) : value
		}
	})
}

function failAsLostConnection(
	stream: ReadableStream<Uint8Array>,
	signal: SignalLike
): ReadableStream<Uint8Array> {
	const reader = stream.getReader()

	return new ReadableStream<Uint8Array>({
		pull: async (controller) => {
			try {
				const chunk = await reader.read()

				if (chunk.done) {
					controller.close()
				} else {
					controller.enqueue(chunk.value)
				}
			} catch (error) {
				controller.error(
					isAbort(error, signal) ? error : new ChatConnectionLostError(error)
				)
			}
		},
		cancel: (reason) => reader.cancel(reason)
	})
}

function isDraining(status: number, body: unknown): boolean {
	return (
		status === 503 &&
		(body as { status?: unknown } | undefined)?.status === 'draining'
	)
}

async function readText(response: Response): Promise<string> {
	return (await tryCatch(() => response.text())).data ?? ''
}

function isAbort(error: unknown, signal: SignalLike): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === 'AbortError')
	)
}

/** Stop pressed during the wait ends the request instead of retrying it. */
function throwIfAborted(signal: SignalLike): void {
	if (signal?.aborted !== true) {
		return
	}

	const error = new Error('The chat request was aborted.')
	error.name = 'AbortError'

	throw error
}
