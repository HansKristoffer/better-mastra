import type { UIMessageChunk } from 'ai'
import { getErrorMessage, safeJsonParse, throttle, withTimeout } from 'hanzio'
import { createThreadLock, type ThreadLock } from './lock.js'
import {
	type BlockingReader,
	noRedis,
	type ResumableRedis,
	type StreamEntry,
	type ThreadLockRedis
} from './redis.js'

export {
	createThreadLock,
	type ThreadLock,
	type ThreadLockLogger,
	type ThreadLockOptions
} from './lock.js'
export { bunRedis, ioRedis, toEmbeddingCache, upstashRedis } from './redis.js'
export { replayPrefixOf } from './replay.js'
export type {
	BlockingReader,
	ResumableRedis,
	StreamEntry,
	ThreadLockRedis,
	UpstashRedisLike
} from './redis.js'

/**
 * Why the registry aborted a turn, as its `abort` signal's `reason`: the
 * user's Stop, a newer turn on the same thread, or `close()` once the drain
 * window passed. `runChatTurn` reports only `stop` as the user stopping.
 */
export type TurnAbortReason = 'stop' | 'superseded' | 'shutdown'

export interface ResumableStreams {
	/** True from `close()` on: `start` throws, and the chat route turns new turns away with `503 { status: 'draining' }`. */
	readonly draining: boolean
	/** Takes over the model stream and returns the response stream for the request that started the turn. */
	start(input: {
		threadKey: string
		/** Owner resource id of the thread, stored on the active run/locator so turn-1 reconnects and stops can verify ownership before Postgres persists the thread row. */
		resourceId?: string
		stream: ReadableStream<UIMessageChunk>
		abort: AbortController
		/**
		 * For a turn that goes on with an earlier answer: the chunks that rebuild
		 * that answer (`replayPrefixOf(body.messages)`). A reconnecting reader
		 * gets them right after the turn's `start`, so the replay is the whole
		 * answer; the request that started the turn already shows it and gets
		 * the turn's own chunks only.
		 */
		replayPrefix?: readonly UIMessageChunk[]
	}): Promise<ReadableStream<UIMessageChunk>>
	/** Full replay of the current assistant message plus the live tail; `null` means answer 204. */
	reconnect(
		threadKey: string,
		signal?: AbortSignal
	): Promise<ReadableStream<UIMessageChunk> | null>
	/** Aborts the turn wherever it runs. `true` when a stop was delivered. */
	stop(threadKey: string): Promise<boolean>
	/** Returns the recorded `resourceId` of an active/in-grace stream for `threadKey`, or `null` if unknown. */
	resourceOf?(threadKey: string): Promise<string | null>
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
	): Promise<string | null> | Promise<undefined> | Promise<void>
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
	 * Upper bound on each Redis command before degrading cleanly, so a stalled
	 * Redis socket never hangs a turn or reconnect. Default 2 s (0 disables).
	 */
	commandTimeoutMs?: number
	/**
	 * How long a stopped turn may take to end its stream. After it the run ends
	 * with an `abort` chunk, so a tool that ignores its abort signal cannot
	 * keep the turn open. Default 5 s.
	 */
	stopTimeoutMs?: number
	/**
	 * Upper bound for `close()` to wait on active turns. Default 90 s, past
	 * `createChatAgent`'s 80 s turn timeout, so a deploy lets a turn the
	 * agent allows finish. Keep the platform's own shutdown grace longer still.
	 */
	drainTimeoutMs?: number
	/** Identifies this process. Default: a random UUID. */
	replicaId?: string
	keyPrefix?: string
	logger?: ResumableLogger
}

interface Locator {
	streamId: string
	owner: string
	resourceId?: string
}

/** One spill stream entry: monotonic sequence number, chunks, the end marker, or both. */
interface SpillEntry {
	s?: number
	c?: UIMessageChunk[]
	end?: 'done' | 'unavailable'
}

type Control =
	| { type: 'spill'; streamId: string; subscriber?: string }
	| { type: 'spill-data'; streamId: string; entry: SpillEntry }
	| { type: 'spill-sync'; streamId: string }
	| { type: 'abort'; streamId: string; reason?: TurnAbortReason }

type Listener = (chunk: UIMessageChunk | null) => void

interface RemoteSubscriber {
	onEntry(entry: SpillEntry): void
	onSync(): void
}

interface LiveRun {
	threadKey: string
	resourceId?: string
	streamId: string
	abort: AbortController
	/** What a replay holds after its `start` and the request that started the turn never gets. */
	prefix: readonly UIMessageChunk[]
	/** The reader of the request that started the turn. */
	starter?: Listener
	chunks: ChunkBuffer
	bytes: number
	overflow: boolean
	done: boolean
	listeners: Set<Listener>
	/** Mirroring to the run's one spill stream, shared by every cross-replica reader. */
	spill: 'off' | 'live' | 'ended'
	/** True once at least one spill entry has landed in Redis. */
	spillWritten: boolean
	/** Monotonic sequence counter for spill entries so multiplexed subscribers detect gaps. */
	spillSeq: number
	/** Replicas subscribed to receive live spill entries over their shared control channel. */
	spillSubscribers: Set<string>
	/** An XADD is in flight; chunks arriving meanwhile go out together after it. */
	writing: boolean
	pending: ChunkBuffer
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

type ActiveDelta =
	| {
			readonly type: 'text-delta' | 'reasoning-delta'
			readonly id: string
			readonly parts: string[]
	  }
	| {
			readonly type: 'tool-input-delta'
			readonly toolCallId: string
			readonly parts: string[]
	  }

interface ChunkBuffer {
	chunks: UIMessageChunk[]
	active: ActiveDelta | undefined
}

function createChunkBuffer(initial: UIMessageChunk[] = []): ChunkBuffer {
	return { chunks: initial, active: undefined }
}

function hasBufferedChunks(buffer: ChunkBuffer): boolean {
	return buffer.chunks.length > 0 || buffer.active !== undefined
}

function sealBuffer(buffer: ChunkBuffer): UIMessageChunk[] {
	const { active } = buffer
	if (active) {
		buffer.active = undefined
		buffer.chunks.push(
			active.type === 'tool-input-delta'
				? {
						type: 'tool-input-delta',
						toolCallId: active.toolCallId,
						inputTextDelta: active.parts.join('')
					}
				: {
						type: active.type,
						id: active.id,
						delta: active.parts.join('')
					}
		)
	}
	return buffer.chunks
}

function takeChunks(buffer: ChunkBuffer): UIMessageChunk[] {
	const sealed = sealBuffer(buffer)
	buffer.chunks = []
	return sealed
}

/** Fast byte-size estimate without allocating a full JSON string per structural chunk. */
function estimateChunkBytes(value: unknown, limit: number): number {
	let total = 0
	const stack: unknown[] = [value]
	while (stack.length > 0 && total <= limit) {
		const item = stack.pop()
		if (typeof item === 'string') {
			total += item.length + 2
		} else if (typeof item === 'number' || typeof item === 'boolean') {
			total += 8
		} else if (item === null || item === undefined) {
			total += 4
		} else if (Array.isArray(item)) {
			total += 2
			for (let i = 0; i < item.length; i += 1) stack.push(item[i])
		} else if (typeof item === 'object') {
			total += 2
			for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
				total += k.length + 4
				stack.push(v)
			}
		}
	}
	return total
}

/** Appends a chunk in O(1), buffering consecutive delta strings without per-token string copies. Returns estimated bytes added. */
function append(
	buffer: ChunkBuffer,
	chunk: UIMessageChunk,
	limit: number
): number {
	if (
		(chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
		!chunk.providerMetadata
	) {
		const { active } = buffer
		if (active && active.type === chunk.type && active.id === chunk.id) {
			active.parts.push(chunk.delta)
			return chunk.delta.length
		}
		sealBuffer(buffer)
		buffer.active = { type: chunk.type, id: chunk.id, parts: [chunk.delta] }
		return chunk.delta.length + 32
	}
	if (chunk.type === 'tool-input-delta') {
		const { active } = buffer
		if (
			active &&
			active.type === 'tool-input-delta' &&
			active.toolCallId === chunk.toolCallId
		) {
			active.parts.push(chunk.inputTextDelta)
			return chunk.inputTextDelta.length
		}
		sealBuffer(buffer)
		buffer.active = {
			type: 'tool-input-delta',
			toolCallId: chunk.toolCallId,
			parts: [chunk.inputTextDelta]
		}
		return chunk.inputTextDelta.length + 32
	}
	sealBuffer(buffer)
	buffer.chunks.push(chunk)
	return estimateChunkBytes(chunk, limit)
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
		commandTimeoutMs = 2_000,
		stopTimeoutMs = 5_000,
		drainTimeoutMs = 90_000,
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
	/** Active multiplexed cross-replica subscribers on this replica, keyed by stream id. */
	const remoteSubscribers = new Map<string, Set<RemoteSubscriber>>()
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

	/** Redis failures (and stalls past `commandTimeoutMs`) never fail a turn: log and degrade. */
	const soft = <T>(op: string, promise: Promise<T>): Promise<T | undefined> => {
		const guarded =
			commandTimeoutMs > 0 ? withTimeout(promise, commandTimeoutMs) : promise
		return guarded.catch((error) => {
			logger.warn(`resumable: redis ${op} failed`, {
				error: getErrorMessage(error)
			})
			return undefined
		})
	}

	function ensureSubscribed() {
		unsubscribe ??= (
			commandTimeoutMs > 0
				? withTimeout(
						redis.subscribe(controlChannel(replicaId), onControl),
						commandTimeoutMs
					)
				: redis.subscribe(controlChannel(replicaId), onControl)
		).catch((error) => {
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

	function notifySpillSubscribers(
		subscribers: Iterable<string>,
		control: Control
	) {
		const payload = JSON.stringify(control)
		for (const subscriber of subscribers) {
			void soft('publish', redis.publish(controlChannel(subscriber), payload))
		}
	}

	function onControl(message: string) {
		const control = parse<Control>(message)
		if (!control) return
		if (control.type === 'spill-data') {
			for (const sub of remoteSubscribers.get(control.streamId) ?? []) {
				sub.onEntry(control.entry)
			}
			return
		}
		if (control.type === 'spill-sync') {
			for (const sub of remoteSubscribers.get(control.streamId) ?? []) {
				sub.onSync()
			}
			return
		}
		const run = streams.get(control.streamId)
		// A finished turn's signal may still guard its epilogue (reply suggestions).
		if (control.type === 'abort')
			return void (
				run &&
				!run.done &&
				run.abort.abort(control.reason ?? ('stop' satisfies TurnAbortReason))
			)
		if (run && control.subscriber) {
			run.spillSubscribers.add(control.subscriber)
		}
		// Already mirroring: once at least one entry is in Redis, tell the late
		// subscriber to catch up from the spill stream; if the very first write is
		// still in flight, it will push entry 1 to `run.spillSubscribers` when done.
		if (run && run.spill !== 'off') {
			if (control.subscriber && run.spillWritten) {
				notifySpillSubscribers([control.subscriber], {
					type: 'spill-sync',
					streamId: control.streamId
				})
			}
			return
		}
		if (!run || run.overflow) {
			const unavailable: SpillEntry = { s: 1, end: 'unavailable' }
			void writeSpill(spillKey(control.streamId), unavailable, true)
			if (control.subscriber) {
				notifySpillSubscribers([control.subscriber], {
					type: 'spill-data',
					streamId: control.streamId,
					entry: unavailable
				})
			}
			return
		}
		run.spill = 'live'
		run.pending = createChunkBuffer(sealBuffer(run.chunks).slice())
		flush(run)
	}

	/** Mirrors the run to its spill stream one XADD at a time, so entries land in order on any client. */
	function flush(run: LiveRun) {
		if (run.spill !== 'live' || run.writing) return
		if (!hasBufferedChunks(run.pending) && !run.done) return
		const key = spillKey(run.streamId)
		const seq = ++run.spillSeq
		const batch = takeChunks(run.pending)
		const entry: SpillEntry = run.done
			? { s: seq, c: batch, end: 'done' }
			: { s: seq, c: batch }
		const first = !run.spillTimer
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
			run.spillWritten = true
			if (run.spillSubscribers.size > 0) {
				notifySpillSubscribers(run.spillSubscribers, {
					type: 'spill-data',
					streamId: run.streamId,
					entry
				})
			}
			run.writing = false
			flush(run)
		})
	}

	/** The turn's own chunk, and after its first `start` the replay prefix, which the starter never gets. */
	function push(run: LiveRun, chunk: UIMessageChunk) {
		record(run, chunk)
		if (chunk.type !== 'start' || !run.prefix.length) return
		const { prefix, starter } = run
		run.prefix = []
		for (const replayed of prefix) record(run, replayed, starter)
	}

	function record(run: LiveRun, chunk: UIMessageChunk, except?: Listener) {
		for (const listener of [...run.listeners]) {
			if (listener === except) continue
			try {
				listener(chunk)
			} catch {
				// A listener whose stream closed before `cancel` must never break fanout or `pump`.
				run.listeners.delete(listener)
			}
		}
		if (!run.overflow) {
			run.bytes += append(run.chunks, chunk, maxBufferBytes)
			if (run.bytes > maxBufferBytes) {
				run.overflow = true
				run.chunks = createChunkBuffer()
				logger.warn(
					'resumable: buffer cap reached, turn is no longer resumable',
					{ threadKey: run.threadKey }
				)
			}
		}
		if (run.spill === 'live') {
			append(run.pending, chunk, maxBufferBytes)
			run.scheduleFlush()
		}
	}

	function finish(run: LiveRun) {
		run.done = true
		sealBuffer(run.chunks)
		run.scheduleFlush.cancel()
		clearInterval(run.renewTimer)
		flush(run)
		for (const listener of [...run.listeners]) {
			try {
				listener(null)
			} catch {}
		}
		run.listeners.clear()
		// A turn a newer one replaced, here or on another replica, must not
		// shorten the newer turn's locator, which may be the app's thread lock.
		const replaced =
			runs.get(run.threadKey) !== run ||
			run.abort.signal.reason === ('superseded' satisfies TurnAbortReason)
		if (locatorStore.expire && !replaced)
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
		signal?: AbortSignal,
		starter = false
	): ReadableStream<UIMessageChunk> | null {
		if (run.overflow || signal?.aborted) return null
		let listener: Listener | undefined
		let onAbort: (() => void) | undefined
		const detach = () => {
			if (onAbort) {
				signal?.removeEventListener('abort', onAbort)
				onAbort = undefined
			}
			return listener ? run.listeners.delete(listener) : false
		}
		return new ReadableStream<UIMessageChunk>({
			start(controller) {
				for (const chunk of sealBuffer(run.chunks)) controller.enqueue(chunk)
				if (run.done) return controller.close()
				listener = (chunk) => {
					if (chunk) {
						controller.enqueue(chunk)
					} else {
						detach()
						closeQuietly(controller)
					}
				}
				run.listeners.add(listener)
				if (starter) run.starter = listener
				if (signal) {
					onAbort = () => {
						if (detach()) closeQuietly(controller)
					}
					signal.addEventListener('abort', onAbort, { once: true })
				}
			},
			cancel: () => void detach()
		})
	}

	/**
	 * O(1)-connection cross-replica reader: receives live spill batches over the
	 * replica's single shared control Pub/Sub subscriber and catches up missed
	 * entries via non-blocking `XREAD` on the shared command client.
	 */
	async function remoteMultiplexed(
		threadKey: string,
		locator: Locator,
		xread: NonNullable<ResumableRedis['xread']>,
		signal?: AbortSignal
	): Promise<ReadableStream<UIMessageChunk> | null> {
		if (signal?.aborted) return null
		const subscribed = await ensureSubscribed()
		if (!subscribed) return remoteWithReader(threadKey, locator, signal)

		const key = spillKey(locator.streamId)
		const queue: SpillEntry[] = []
		let lastSeq = 0
		let lastStreamId = '0'
		let needsSync = false
		let released = false
		let wake: (() => void) | undefined

		const notify = () => {
			const fn = wake
			wake = undefined
			fn?.()
		}

		const sub: RemoteSubscriber = {
			onEntry(entry) {
				if (released) return
				queue.push(entry)
				notify()
			},
			onSync() {
				if (released) return
				needsSync = true
				notify()
			}
		}

		let group = remoteSubscribers.get(locator.streamId)
		if (!group) {
			group = new Set()
			remoteSubscribers.set(locator.streamId, group)
		}
		group.add(sub)

		const onAbort = () => release()
		const release = () => {
			if (released) return
			released = true
			signal?.removeEventListener('abort', onAbort)
			const subs = remoteSubscribers.get(locator.streamId)
			subs?.delete(sub)
			if (subs && subs.size === 0) remoteSubscribers.delete(locator.streamId)
			notify()
		}
		signal?.addEventListener('abort', onAbort, { once: true })

		const catchUp = async (): Promise<boolean> => {
			const entries = await soft('xread', xread(key, lastStreamId))
			if (entries === undefined) return false
			for (const entry of entries) {
				lastStreamId = entry.id
				const parsed = parse<SpillEntry>(entry.value)
				if (!parsed) return false
				queue.push(parsed)
			}
			needsSync = false
			return true
		}

		const waitSignal = (ms: number) =>
			new Promise<void>((resolve) => {
				if (released || queue.length > 0 || needsSync) return resolve()
				const timer = setTimeout(() => {
					wake = undefined
					resolve()
				}, ms)
				timer.unref?.()
				wake = () => {
					clearTimeout(timer)
					resolve()
				}
			})

		const spill: Control = {
			type: 'spill',
			streamId: locator.streamId,
			subscriber: replicaId
		}
		const published = await soft(
			'publish',
			redis
				.publish(controlChannel(locator.owner), JSON.stringify(spill))
				.then(() => true)
		)
		if (!published) {
			release()
			return null
		}

		// Wait for the owner's first push or sync ack, catching up from the stream if needed.
		const ackDeadline = Date.now() + Math.min(idleTimeoutMs, SPILL_ACK_MS)
		while (!released) {
			if (needsSync) {
				const ok = await catchUp()
				if (!ok) {
					release()
					return null
				}
				if (queue.length > 0) break
			}
			if (queue.length > 0) {
				if (queue[0]?.s !== undefined && queue[0].s > 1) {
					const ok = await catchUp()
					if (!ok) {
						release()
						return null
					}
				}
				break
			}
			const remaining = ackDeadline - Date.now()
			if (remaining <= 0) {
				const ok = await catchUp()
				if (!ok || queue.length === 0) {
					release()
					return null
				}
				break
			}
			await waitSignal(remaining)
		}
		if (released) return null

		// Order buffered entries by sequence number if present.
		const sortQueue = () => {
			if (queue.length > 1) {
				queue.sort((a, b) => (a.s ?? 0) - (b.s ?? 0))
			}
		}
		sortQueue()

		if (queue[0]?.end === 'unavailable') {
			release()
			return null
		}

		return new ReadableStream<UIMessageChunk>({
			async pull(controller) {
				const end = (error?: UIMessageChunk) => {
					if (error && !released) controller.enqueue(error)
					release()
					closeQuietly(controller)
				}
				try {
					for (;;) {
						if (released) return closeQuietly(controller)
						if (needsSync) {
							if (!(await catchUp())) return end(interrupted)
						}
						sortQueue()
						// Drop entries we already emitted.
						while (
							queue.length > 0 &&
							queue[0]?.s !== undefined &&
							queue[0].s <= lastSeq
						) {
							queue.shift()
						}
						// Gap detected (e.g. a late push landed ahead of an earlier batch): catch up from Redis stream.
						if (
							queue.length > 0 &&
							queue[0]?.s !== undefined &&
							queue[0].s > lastSeq + 1
						) {
							if (!(await catchUp())) return end(interrupted)
							sortQueue()
							while (
								queue.length > 0 &&
								queue[0]?.s !== undefined &&
								queue[0].s <= lastSeq
							) {
								queue.shift()
							}
						}

						if (queue.length > 0) {
							const next = queue.shift()!
							if (next.s !== undefined) lastSeq = Math.max(lastSeq, next.s)
							for (const chunk of next.c ?? []) controller.enqueue(chunk)
							if (next.end) return end()
							return
						}

						await waitSignal(idleTimeoutMs)
						if (released) return closeQuietly(controller)
						if (queue.length > 0 || needsSync) continue

						// Quiet for `idleTimeoutMs`: catch up once in case Pub/Sub dropped, then check owner liveness.
						if (!(await catchUp())) return end(interrupted)
						if (queue.length > 0) continue

						const current = await soft('get', locatorStore.read(threadKey))
						if (current === undefined) continue
						if (parse<Locator>(current)?.streamId === locator.streamId) continue
						return end(ownerGone)
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

	async function remoteWithReader(
		threadKey: string,
		locator: Locator,
		signal?: AbortSignal
	) {
		const reader = await soft('reader', redis.reader())
		if (!reader) return null
		readers.add(reader)
		let released = false
		const onAbort = () => release()
		const release = () => {
			if (released) return
			released = true
			signal?.removeEventListener('abort', onAbort)
			readers.delete(reader)
			reader.close()
		}
		signal?.addEventListener('abort', onAbort, { once: true })
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

	async function remote(
		threadKey: string,
		locator: Locator,
		signal?: AbortSignal
	) {
		return redis.xread
			? remoteMultiplexed(threadKey, locator, redis.xread, signal)
			: remoteWithReader(threadKey, locator, signal)
	}

	return {
		get draining() {
			return closed
		},

		async start({ threadKey, resourceId, stream, abort, replayPrefix = [] }) {
			if (closed) throw new Error('resumable: start() called after close()')
			let resolveFinished = () => {}
			const finished = new Promise<void>((resolve) => {
				resolveFinished = resolve
			})
			// A new turn supersedes one still running on the thread, which nothing could reach or stop anymore.
			const previous = runs.get(threadKey)
			if (previous && !previous.done)
				previous.abort.abort('superseded' satisfies TurnAbortReason)
			const run: LiveRun = {
				threadKey,
				...(resourceId !== undefined && { resourceId }),
				streamId: crypto.randomUUID(),
				abort,
				prefix: replayPrefix,
				chunks: createChunkBuffer(),
				bytes: 0,
				overflow: false,
				done: false,
				listeners: new Set(),
				spill: 'off',
				spillWritten: false,
				spillSeq: 0,
				spillSubscribers: new Set(),
				writing: false,
				pending: createChunkBuffer(),
				scheduleFlush: throttle(() => flush(run), spillFlushMs),
				finished,
				resolveFinished
			}
			runs.set(threadKey, run)
			streams.set(run.streamId, run)
			const locator = JSON.stringify({
				streamId: run.streamId,
				owner: replicaId,
				...(resourceId !== undefined && { resourceId })
			} satisfies Locator)
			// Point other replicas here only once spill and stop requests can reach this one.
			void ensureSubscribed().then(async (subscribed) => {
				// Guard against a newer turn superseding this one while subscribing.
				if (!subscribed || runs.get(threadKey) !== run) return
				const replaced = await soft(
					'set',
					Promise.resolve(
						locatorStore.write(
							threadKey,
							locator,
							run.done ? graceMs : locatorTtlMs
						)
					)
				)
				// A turn the thread ran on another replica would keep running there, unreachable.
				const before = typeof replaced === 'string' && parse<Locator>(replaced)
				if (!before || before.owner === replicaId) return
				const abortControl: Control = {
					type: 'abort',
					streamId: before.streamId,
					reason: 'superseded'
				}
				void soft(
					'publish',
					redis.publish(
						controlChannel(before.owner),
						JSON.stringify(abortControl)
					)
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
			const response = local(run, undefined, true)!
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
				run.abort.abort('stop' satisfies TurnAbortReason)
				return true
			}
			const locator = parse<Locator>(
				await soft('get', locatorStore.read(threadKey))
			)
			if (!locator || locator.owner === replicaId) return false
			const abortControl: Control = {
				type: 'abort',
				streamId: locator.streamId,
				reason: 'stop'
			}
			const sent = redis
				.publish(controlChannel(locator.owner), JSON.stringify(abortControl))
				.then(() => true)
			return (await soft('publish', sent)) ?? false
		},

		async resourceOf(threadKey) {
			const run = runs.get(threadKey)
			if (run?.resourceId) return run.resourceId
			const raw = await soft('get', locatorStore.read(threadKey))
			return parse<Locator>(raw)?.resourceId ?? null
		},

		async close() {
			closed = true
			const active = [...streams.values()]
				.filter((run) => !run.done)
				.map((run) => run.finished)
			// Runs still going after the drain window are aborted below.
			await withTimeout(Promise.all(active), drainTimeoutMs).catch(() => {})
			for (const run of streams.values()) {
				if (!run.done) run.abort.abort('shutdown' satisfies TurnAbortReason)
				clearTimeout(run.evictTimer)
				clearInterval(run.spillTimer)
			}
			runs.clear()
			streams.clear()
			remoteSubscribers.clear()
			for (const reader of readers) reader.close()
			readers.clear()
			const off = await unsubscribe
			if (off) await soft('unsubscribe', off())
		}
	}
}

const GRACE_PREFIX = 'grace|'
const CLAIM_COORDINATED_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v or string.sub(v, 1, 6) == 'grace|' then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`
const WRITE_LOCATOR_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, #ARGV[1] + 1) == ARGV[1] .. '|' then
  local prev = string.sub(v, #ARGV[1] + 2)
  redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
  return prev
end
if v == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
  return nil
end
return nil
`
const RENEW_COORDINATED_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v and (v == ARGV[1] or string.sub(v, 1, #ARGV[1] + 1) == ARGV[1] .. '|') then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`
const RELEASE_COORDINATED_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
if v == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
if string.sub(v, 1, #ARGV[1] + 1) == ARGV[1] .. '|' then
  local loc = string.sub(v, #ARGV[1] + 2)
  if tonumber(ARGV[2]) > 0 and #loc > 0 then
    redis.call('SET', KEYS[1], 'grace|' .. loc, 'PX', ARGV[2])
  else
    redis.call('DEL', KEYS[1])
  end
  return 1
end
return 0
`

export interface ChatCoordinatorOptions extends Omit<
	ResumableStreamsOptions,
	'locator' | 'redis'
> {
	/** Shared Redis adapter (`bunRedis`, `ioRedis`, `upstashRedis`). Omit for single-process mode. */
	readonly redis?: ResumableRedis & ThreadLockRedis
	/** Lock/locator TTL while a turn runs. Default 30 s. */
	readonly ttlMs?: number
}

export interface ChatCoordinator {
	readonly lock: ThreadLock
	readonly resumable: ResumableStreams
	close(): Promise<void>
}

/**
 * Pairs a thread lock and resumable streams on a single shared Redis key and
 * single renewal timer per active turn (instead of two keys and two timers).
 * Releasing the lock transitions the key into a short grace locator that never
 * blocks the next turn's lock acquisition.
 */
export function createChatCoordinator(
	options: ChatCoordinatorOptions = {}
): ChatCoordinator {
	const {
		redis,
		ttlMs = options.locatorTtlMs ?? 30_000,
		graceMs = 30_000,
		commandTimeoutMs = 2_000,
		keyPrefix = 'chat:',
		logger = {
			// biome-ignore lint/suspicious/noConsole: default logger
			warn: (message, attributes) => console.warn(message, attributes)
		},
		...rest
	} = options

	if (!redis?.eval) {
		const lock = createThreadLock({
			...(redis && { redis }),
			ttlMs,
			commandTimeoutMs,
			keyPrefix: `${keyPrefix}lock:`,
			logger
		})
		const resumable = createResumableStreams({
			...(redis && { redis }),
			graceMs,
			locatorTtlMs: ttlMs,
			commandTimeoutMs,
			keyPrefix,
			logger,
			...rest
		})
		return { lock, resumable, close: () => resumable.close() }
	}

	const keyOf = (threadId: string) => `${keyPrefix}turn:${threadId}`
	const heldTokens = new Map<string, string>()
	const soft = async <T>(
		op: string,
		work: Promise<T>
	): Promise<T | undefined> => {
		try {
			return commandTimeoutMs > 0
				? await withTimeout(work, commandTimeoutMs)
				: await work
		} catch (error) {
			logger.warn(`chat coordinator: redis ${op} failed`, {
				error: getErrorMessage(error)
			})
			return undefined
		}
	}

	const lock: ThreadLock = async ({ threadId }) => {
		if (heldTokens.has(threadId)) return null
		const token = crypto.randomUUID()
		heldTokens.set(threadId, token)

		const key = keyOf(threadId)
		const claimed = await soft(
			'claim',
			redis.eval!(CLAIM_COORDINATED_SCRIPT, [key], [token, ttlMs])
		)

		if (claimed === 0) {
			heldTokens.delete(threadId)
			return null
		}

		const renewal =
			claimed === 1
				? setInterval(async () => {
						const renewed = await soft(
							'renewal',
							redis.eval!(RENEW_COORDINATED_SCRIPT, [key], [token, ttlMs])
						)
						if (renewed === 0) {
							clearInterval(renewal)
							logger.warn(
								'chat coordinator: the claim was lost before its release',
								{ threadId }
							)
						}
					}, ttlMs / 3)
				: undefined
		renewal?.unref?.()

		return async () => {
			clearInterval(renewal)
			if (heldTokens.get(threadId) === token) heldTokens.delete(threadId)
			await soft(
				'release',
				redis.eval!(RELEASE_COORDINATED_SCRIPT, [key], [token, graceMs])
			)
		}
	}

	const locator: ResumableLocator = {
		async read(threadKey) {
			const raw = await redis.get(keyOf(threadKey))
			if (!raw) return null
			const sep = raw.indexOf('|')
			return sep === -1 ? null : raw.slice(sep + 1) || null
		},
		async write(threadKey, value, writeTtlMs) {
			const token = heldTokens.get(threadKey)
			if (!token) {
				// Fallback when `resumable.start()` is called without holding `lock`.
				const prev = await redis.set(
					keyOf(threadKey),
					`${GRACE_PREFIX}${value}`,
					writeTtlMs
				)
				if (!prev) return null
				const sep = prev.indexOf('|')
				return sep === -1 ? null : prev.slice(sep + 1) || null
			}
			const prev = await redis.eval!(
				WRITE_LOCATOR_SCRIPT,
				[keyOf(threadKey)],
				[token, value, writeTtlMs]
			)
			return typeof prev === 'string' && prev.length > 0 ? prev : null
		}
	}

	const resumable = createResumableStreams({
		redis,
		locator,
		graceMs,
		locatorTtlMs: ttlMs,
		commandTimeoutMs,
		keyPrefix,
		logger,
		...rest
	})

	return {
		lock,
		resumable,
		close: () => resumable.close()
	}
}
