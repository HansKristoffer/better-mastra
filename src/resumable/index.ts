import type { UIMessageChunk } from 'ai'
import { getErrorMessage, safeJsonParse, throttle, withTimeout } from 'hanzio'
import {
	type BlockingReader,
	noRedis,
	type ResumableRedis,
	type StreamEntry
} from './redis.js'

export { bunRedis, ioRedis, upstashRedis } from './redis.js'
export type {
	BlockingReader,
	ResumableRedis,
	StreamEntry,
	UpstashRedisLike
} from './redis.js'

export interface ResumableStreams {
	/** Takes over the model stream and returns the response stream for the request that started the turn. */
	start(input: {
		threadKey: string
		stream: ReadableStream<UIMessageChunk>
		abort: AbortController
	}): Promise<ReadableStream<UIMessageChunk>>
	/** Full replay of the current assistant message plus the live tail; `null` means answer 204. */
	reconnect(
		threadKey: string,
		signal?: AbortSignal
	): Promise<ReadableStream<UIMessageChunk> | null>
	/** Aborts the turn wherever it runs. `true` when a stop was delivered. */
	stop(threadKey: string): Promise<boolean>
	/** Waits for active turns (up to `drainTimeoutMs`), then releases timers and connections. */
	close(): Promise<void>
}

export interface ResumableLogger {
	warn(message: string, attributes?: Record<string, unknown>): void
}

/**
 * Where a thread's locator lives (which replica runs its turn), as an opaque
 * string. Defaults to a key of its own in `redis`. An app with its own
 * per-thread lock can keep the locator in the lock's value instead, so it
 * lives exactly as long as the lock and costs no extra key.
 */
export interface ResumableLocator {
	read(threadKey: string): Promise<string | null>
	/**
	 * Called when a turn starts, with `locatorTtlMs`. Resolve with the locator
	 * it replaced, if the store can tell, so a turn still running for the
	 * thread on another replica is aborted.
	 */
	write(
		threadKey: string,
		locator: string,
		ttlMs: number
	): Promise<string | null | void>
	/**
	 * Renews the locator while the turn runs (every third of `locatorTtlMs`),
	 * then shortens it to `graceMs` when the turn ends. Leave it out when the
	 * app's lock owns the lifetime: the locator is gone when the lock is released.
	 */
	expire?(threadKey: string, ttlMs: number): Promise<void>
}

export interface ResumableStreamsOptions {
	/**
	 * Shares turns across replicas. Leave it out for one process (local
	 * development, a single instance): turns are then resumable on it only.
	 */
	redis?: ResumableRedis
	/** Where the thread locator is kept; needs `redis`. Default: `${keyPrefix}loc:<threadKey>` in `redis`. */
	locator?: ResumableLocator
	/** How long a finished turn stays resumable. Default 30 s. */
	graceMs?: number
	/** Above this the turn keeps running but new reconnects get 204. Default 2 MB. */
	maxBufferBytes?: number
	/** TTL of the thread locator, renewed every third of it while the turn runs. Default 30 s. */
	locatorTtlMs?: number
	/** Batch window for mirroring chunks to a cross-replica reader. Default 50 ms. */
	spillFlushMs?: number
	/** A cross-replica reader without data this long checks whether the owner is still alive. Default 10 s. */
	idleTimeoutMs?: number
	/**
	 * How long a stopped turn may take to end its stream. After it the run ends
	 * with an `abort` chunk, so a tool that ignores its abort signal cannot
	 * keep the turn open. Default 5 s.
	 */
	stopTimeoutMs?: number
	/** Upper bound for `close()` to wait on active turns. Default 30 s. */
	drainTimeoutMs?: number
	/** Identifies this process. Default: a random UUID. */
	replicaId?: string
	keyPrefix?: string
	logger?: ResumableLogger
}

interface Locator {
	streamId: string
	owner: string
}

type Control =
	{ type: 'spill'; streamId: string } | { type: 'abort'; streamId: string }
/** One spill stream entry: chunks, the end marker, or both. */
interface SpillEntry {
	c?: UIMessageChunk[]
	end?: 'done' | 'unavailable'
}
type Listener = (chunk: UIMessageChunk | null) => void

interface LiveRun {
	threadKey: string
	streamId: string
	abort: AbortController
	chunks: UIMessageChunk[]
	bytes: number
	overflow: boolean
	done: boolean
	listeners: Set<Listener>
	/** Mirroring to the run's one spill stream, shared by every cross-replica reader. */
	spill: 'off' | 'live' | 'ended'
	/** An XADD is in flight; chunks arriving meanwhile go out together after it. */
	writing: boolean
	pending: UIMessageChunk[]
	/** Flushes `pending` on the leading edge, then at most once per `spillFlushMs`. */
	scheduleFlush: (() => void) & { cancel(): void }
	renewTimer?: ReturnType<typeof setInterval>
	spillTimer?: ReturnType<typeof setInterval>
	evictTimer?: ReturnType<typeof setTimeout>
	finished: Promise<void>
	resolveFinished: () => void
}

const SPILL_TTL_SECONDS = 60
/** The owner answers a spill request within a round trip; a silent one is gone. */
const SPILL_ACK_MS = 2_000
const ownerGone: UIMessageChunk = {
	type: 'error',
	errorText: 'The stream owner stopped responding.'
}
const interrupted: UIMessageChunk = {
	type: 'error',
	errorText: 'The resumed stream was interrupted.'
}

type Delta = Extract<UIMessageChunk, { type: 'text-delta' | 'reasoning-delta' }>
const isDelta = (chunk: UIMessageChunk): chunk is Delta =>
	chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'

/** Appends a chunk, merging consecutive deltas of the same part. Returns the bytes added. */
function append(chunks: UIMessageChunk[], chunk: UIMessageChunk): number {
	const last = chunks.at(-1)
	if (
		last &&
		isDelta(last) &&
		isDelta(chunk) &&
		last.type === chunk.type &&
		last.id === chunk.id &&
		!last.providerMetadata &&
		!chunk.providerMetadata
	) {
		chunks[chunks.length - 1] = { ...last, delta: last.delta + chunk.delta }
		return chunk.delta.length
	}
	if (
		last?.type === 'tool-input-delta' &&
		chunk.type === 'tool-input-delta' &&
		last.toolCallId === chunk.toolCallId
	) {
		chunks[chunks.length - 1] = {
			...last,
			inputTextDelta: last.inputTextDelta + chunk.inputTextDelta
		}
		return chunk.inputTextDelta.length
	}
	chunks.push(chunk)
	return JSON.stringify(chunk).length
}

/** Closing an already cancelled stream throws; there is nothing left to tell the reader. */
function closeQuietly(
	controller: ReadableStreamDefaultController<UIMessageChunk>
) {
	try {
		controller.close()
	} catch {}
}

function parse<T>(raw: string | null | undefined): T | null {
	return raw ? safeJsonParse<T>(raw).data : null
}

export function createResumableStreams(
	options: ResumableStreamsOptions
): ResumableStreams {
	const {
		redis = noRedis,
		graceMs = 30_000,
		maxBufferBytes = 2_000_000,
		locatorTtlMs = 30_000,
		spillFlushMs = 50,
		idleTimeoutMs = 10_000,
		stopTimeoutMs = 5_000,
		drainTimeoutMs = 30_000,
		replicaId = crypto.randomUUID(),
		keyPrefix = 'resumable:',
		logger = {
			// biome-ignore lint/suspicious/noConsole: default logger
			warn: (message, attributes) => console.warn(message, attributes)
		}
	} = options
	/** The thread's current run, by thread key. */
	const runs = new Map<string, LiveRun>()
	/** Every run still in memory, including one a newer turn replaced, by stream id. */
	const streams = new Map<string, LiveRun>()
	const readers = new Set<BlockingReader>()
	const locatorKey = (threadKey: string) => `${keyPrefix}loc:${threadKey}`
	const locatorStore: ResumableLocator = options.locator ?? {
		read: (threadKey) => redis.get(locatorKey(threadKey)),
		write: (threadKey, locator, ttlMs) =>
			redis.set(locatorKey(threadKey), locator, ttlMs),
		expire: (threadKey, ttlMs) => redis.pexpire(locatorKey(threadKey), ttlMs)
	}
	const controlChannel = (owner: string) => `${keyPrefix}ctl:${owner}`
	const spillKey = (streamId: string) => `${keyPrefix}spill:${streamId}`
	const spillTtlSeconds = Math.ceil(graceMs / 1000) + SPILL_TTL_SECONDS
	let unsubscribe: Promise<(() => Promise<void>) | undefined> | undefined
	let closed = false

	/** Redis failures never fail a turn: log and degrade. */
	const soft = <T>(op: string, promise: Promise<T>): Promise<T | undefined> =>
		promise.catch((error) => {
			logger.warn(`resumable: redis ${op} failed`, {
				error: getErrorMessage(error)
			})
			return undefined
		})

	function ensureSubscribed() {
		unsubscribe ??= redis
			.subscribe(controlChannel(replicaId), onControl)
			.catch((error) => {
				logger.warn('resumable: control channel subscribe failed', {
					error: getErrorMessage(error)
				})
				unsubscribe = undefined
				return undefined
			})
		return unsubscribe
	}

	/** Awaited in turn, so the XADD creates the key before EXPIRE on clients that do not keep order (HTTP). */
	async function writeSpill(key: string, entry: SpillEntry, expire: boolean) {
		await soft('xadd', redis.xadd(key, JSON.stringify(entry)))
		if (expire) await soft('expire', redis.expire(key, spillTtlSeconds))
	}

	function onControl(message: string) {
		const control = parse<Control>(message)
		if (!control) return
		const run = streams.get(control.streamId)
		// A finished turn's signal may still guard its epilogue (reply suggestions).
		if (control.type === 'abort')
			return void (run && !run.done && run.abort.abort())
		// Already mirroring: the stream holds the run from its first chunk.
		if (run && run.spill !== 'off') return
		if (!run || run.overflow)
			return void writeSpill(
				spillKey(control.streamId),
				{ end: 'unavailable' },
				true
			)
		run.spill = 'live'
		run.pending = run.chunks.slice()
		flush(run)
	}

	/** Mirrors the run to its spill stream one XADD at a time, so entries land in order on any client. */
	function flush(run: LiveRun) {
		if (run.spill !== 'live' || run.writing) return
		if (!run.pending.length && !run.done) return
		const key = spillKey(run.streamId)
		const entry: SpillEntry = run.done
			? { c: run.pending, end: 'done' }
			: { c: run.pending }
		const first = !run.spillTimer
		run.pending = []
		if (run.done) {
			run.spill = 'ended'
			clearInterval(run.spillTimer)
		} else if (first) {
			// The TTL outlives a quiet stretch (a long tool call) without an EXPIRE per batch.
			run.spillTimer = setInterval(
				() => void soft('expire', redis.expire(key, spillTtlSeconds)),
				(spillTtlSeconds * 1000) / 3
			)
			run.spillTimer.unref?.()
		}
		run.writing = true
		void writeSpill(key, entry, first || run.done).then(() => {
			run.writing = false
			flush(run)
		})
	}

	function push(run: LiveRun, chunk: UIMessageChunk) {
		for (const listener of run.listeners) listener(chunk)
		if (!run.overflow) {
			run.bytes += append(run.chunks, chunk)
			if (run.bytes > maxBufferBytes) {
				run.overflow = true
				run.chunks = []
				logger.warn(
					'resumable: buffer cap reached, turn is no longer resumable',
					{ threadKey: run.threadKey }
				)
			}
		}
		if (run.spill === 'live') {
			append(run.pending, chunk)
			run.scheduleFlush()
		}
	}

	function finish(run: LiveRun) {
		run.done = true
		run.scheduleFlush.cancel()
		clearInterval(run.renewTimer)
		flush(run)
		for (const listener of run.listeners) listener(null)
		run.listeners.clear()
		if (locatorStore.expire)
			void soft('pexpire', locatorStore.expire(run.threadKey, graceMs))
		run.evictTimer = setTimeout(() => {
			streams.delete(run.streamId)
			if (runs.get(run.threadKey) === run) runs.delete(run.threadKey)
		}, graceMs)
		run.evictTimer.unref?.()
		run.resolveFinished()
	}

	async function pump(run: LiveRun, stream: ReadableStream<UIMessageChunk>) {
		const reader = stream.getReader()
		let deadline: ReturnType<typeof setTimeout> | undefined
		const onAbort = () => {
			deadline = setTimeout(() => {
				push(run, { type: 'abort' })
				void reader.cancel().catch(() => {})
			}, stopTimeoutMs)
			deadline.unref?.()
		}
		run.abort.signal.addEventListener('abort', onAbort, { once: true })
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				push(run, value)
			}
		} catch (error) {
			if (!run.abort.signal.aborted)
				push(run, {
					type: 'error',
					errorText: getErrorMessage(error)
				})
		} finally {
			clearTimeout(deadline)
			run.abort.signal.removeEventListener('abort', onAbort)
			finish(run)
		}
	}

	function local(
		run: LiveRun,
		signal?: AbortSignal
	): ReadableStream<UIMessageChunk> | null {
		if (run.overflow || signal?.aborted) return null
		let listener: Listener | undefined
		const detach = () => listener && run.listeners.delete(listener)
		return new ReadableStream<UIMessageChunk>({
			start(controller) {
				for (const chunk of run.chunks) controller.enqueue(chunk)
				if (run.done) return controller.close()
				listener = (chunk) =>
					chunk ? controller.enqueue(chunk) : controller.close()
				run.listeners.add(listener)
				signal?.addEventListener(
					'abort',
					() => detach() && closeQuietly(controller)
				)
			},
			cancel: () => void detach()
		})
	}

	async function remote(
		threadKey: string,
		locator: Locator,
		signal?: AbortSignal
	) {
		const reader = await soft('reader', redis.reader())
		if (!reader) return null
		readers.add(reader)
		let released = false
		const release = () => {
			if (released) return
			released = true
			readers.delete(reader)
			reader.close()
		}
		signal?.addEventListener('abort', release)
		const key = spillKey(locator.streamId)
		const spill: Control = { type: 'spill', streamId: locator.streamId }
		let entries: StreamEntry[] = []
		try {
			await redis.publish(controlChannel(locator.owner), JSON.stringify(spill))
			entries = await reader.xread(
				key,
				'0',
				Math.min(idleTimeoutMs, SPILL_ACK_MS)
			)
		} catch (error) {
			if (!released)
				logger.warn('resumable: cross-replica reconnect failed', {
					error: getErrorMessage(error)
				})
		}
		const first = parse<SpillEntry>(entries[0]?.value)
		if (!first || first.end === 'unavailable') {
			release()
			return null
		}
		let lastId = '0'
		return new ReadableStream<UIMessageChunk>({
			async pull(controller) {
				/** Ends the stream; an `error` chunk tells the client to reload the thread. */
				const end = (error?: UIMessageChunk) => {
					if (error && !released) controller.enqueue(error)
					release()
					closeQuietly(controller)
				}
				try {
					while (!entries.length) {
						entries = await reader.xread(key, lastId, idleTimeoutMs)
						if (entries.length) break
						// A failed read is a Redis blip, not a dead owner: keep waiting.
						const current = await soft('get', locatorStore.read(threadKey))
						if (current === undefined) continue
						if (parse<Locator>(current)?.streamId === locator.streamId) continue
						return end(ownerGone)
					}
					for (const entry of entries.splice(0)) {
						lastId = entry.id
						const spillEntry = parse<SpillEntry>(entry.value)
						if (!spillEntry) return end(interrupted)
						for (const chunk of spillEntry.c ?? []) controller.enqueue(chunk)
						if (spillEntry.end) return end()
					}
				} catch (error) {
					if (!released)
						logger.warn('resumable: cross-replica read failed', {
							error: getErrorMessage(error)
						})
					end(interrupted)
				}
			},
			cancel: release
		})
	}

	return {
		async start({ threadKey, stream, abort }) {
			if (closed) throw new Error('resumable: start() called after close()')
			let resolveFinished = () => {}
			const finished = new Promise<void>((resolve) => {
				resolveFinished = resolve
			})
			// A new turn supersedes one still running on the thread, which nothing could reach or stop anymore.
			const previous = runs.get(threadKey)
			if (previous && !previous.done) previous.abort.abort()
			const run: LiveRun = {
				threadKey,
				streamId: crypto.randomUUID(),
				abort,
				chunks: [],
				bytes: 0,
				overflow: false,
				done: false,
				listeners: new Set(),
				spill: 'off',
				writing: false,
				pending: [],
				scheduleFlush: throttle(() => flush(run), spillFlushMs),
				finished,
				resolveFinished
			}
			runs.set(threadKey, run)
			streams.set(run.streamId, run)
			const locator = JSON.stringify({
				streamId: run.streamId,
				owner: replicaId
			} satisfies Locator)
			// Point other replicas here only once spill and stop requests can reach this one.
			void ensureSubscribed().then(async (subscribed) => {
				if (!subscribed) return
				const replaced = await soft(
					'set',
					locatorStore.write(
						threadKey,
						locator,
						run.done ? graceMs : locatorTtlMs
					)
				)
				// A turn the thread ran on another replica would keep running there, unreachable.
				const before = typeof replaced === 'string' && parse<Locator>(replaced)
				if (!before || before.owner === replicaId) return
				const abort: Control = { type: 'abort', streamId: before.streamId }
				void soft(
					'publish',
					redis.publish(controlChannel(before.owner), JSON.stringify(abort))
				)
			})
			const { expire } = locatorStore
			if (expire) {
				run.renewTimer = setInterval(
					() => void soft('pexpire', expire(threadKey, locatorTtlMs)),
					locatorTtlMs / 3
				)
				run.renewTimer.unref?.()
			}
			const response = local(run)!
			void pump(run, stream)
			return response
		},

		async reconnect(threadKey, signal) {
			const run = runs.get(threadKey)
			// Active turn on this replica: memory only, zero Redis ops.
			if (run && !run.done) return local(run, signal)
			const raw = await soft('get', locatorStore.read(threadKey))
			if (raw === undefined) return run ? local(run, signal) : null
			const locator = parse<Locator>(raw)
			// A finished turn in grace is only current if no newer turn took the thread.
			if (run && (!locator || locator.streamId === run.streamId))
				return local(run, signal)
			if (!locator || locator.owner === replicaId) return null
			return remote(threadKey, locator, signal)
		},

		async stop(threadKey) {
			const run = runs.get(threadKey)
			if (run && !run.done) {
				run.abort.abort()
				return true
			}
			const locator = parse<Locator>(
				await soft('get', locatorStore.read(threadKey))
			)
			if (!locator || locator.owner === replicaId) return false
			const abort: Control = { type: 'abort', streamId: locator.streamId }
			const sent = redis
				.publish(controlChannel(locator.owner), JSON.stringify(abort))
				.then(() => true)
			return (await soft('publish', sent)) ?? false
		},

		async close() {
			closed = true
			const active = [...streams.values()]
				.filter((run) => !run.done)
				.map((run) => run.finished)
			// Runs still going after the drain window are aborted below.
			await withTimeout(Promise.all(active), drainTimeoutMs).catch(() => {})
			for (const run of streams.values()) {
				if (!run.done) run.abort.abort()
				clearTimeout(run.evictTimer)
				clearInterval(run.spillTimer)
			}
			runs.clear()
			streams.clear()
			for (const reader of readers) reader.close()
			readers.clear()
			const off = await unsubscribe
			if (off) await soft('unsubscribe', off())
		}
	}
}
