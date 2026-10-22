import type { UIMessageChunk } from 'ai'
import { getErrorMessage, safeJsonParse } from 'hanzio'
import type { BlockingReader, ResumableRedis, StreamEntry } from './redis.js'

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
	/** Called when a turn starts, with `locatorTtlMs`. */
	write(threadKey: string, locator: string, ttlMs: number): Promise<void>
	/**
	 * Renews the locator while the turn runs (every third of `locatorTtlMs`),
	 * then shortens it to `graceMs` when the turn ends. Leave it out when the
	 * app's lock owns the lifetime: the locator is gone when the lock is released.
	 */
	expire?(threadKey: string, ttlMs: number): Promise<void>
}

export interface ResumableStreamsOptions {
	redis: ResumableRedis
	/** Where the thread locator is kept. Default: `${keyPrefix}loc:<threadKey>` in `redis`. */
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
	| { type: 'spill'; streamId: string; key: string }
	| { type: 'abort'; streamId: string }
type SpillEntry = { c: UIMessageChunk[] } | { end: 'done' | 'unavailable' }
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
	spillKeys: string[]
	pending: UIMessageChunk[]
	flushTimer?: ReturnType<typeof setTimeout> | undefined
	renewTimer?: ReturnType<typeof setInterval>
	evictTimer?: ReturnType<typeof setTimeout>
	finished: Promise<void>
	resolveFinished: () => void
}

const SPILL_TTL_SECONDS = 60
const ownerGone: UIMessageChunk = {
	type: 'error',
	errorText: 'The stream owner stopped responding.'
}

/** Appends a chunk, merging consecutive text deltas of the same part. Returns the bytes added. */
function append(chunks: UIMessageChunk[], chunk: UIMessageChunk): number {
	const last = chunks.at(-1)
	if (
		chunk.type === 'text-delta' &&
		last?.type === 'text-delta' &&
		last.id === chunk.id &&
		!last.providerMetadata &&
		!chunk.providerMetadata
	) {
		chunks[chunks.length - 1] = { ...last, delta: last.delta + chunk.delta }
		return chunk.delta.length
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
		redis,
		graceMs = 30_000,
		maxBufferBytes = 2_000_000,
		locatorTtlMs = 30_000,
		spillFlushMs = 50,
		idleTimeoutMs = 10_000,
		drainTimeoutMs = 30_000,
		replicaId = crypto.randomUUID(),
		keyPrefix = 'resumable:',
		logger = {
			// biome-ignore lint/suspicious/noConsole: default logger
			warn: (message, attributes) => console.warn(message, attributes)
		}
	} = options
	const runs = new Map<string, LiveRun>()
	const readers = new Set<BlockingReader>()
	const locatorKey = (threadKey: string) => `${keyPrefix}loc:${threadKey}`
	const locatorStore: ResumableLocator = options.locator ?? {
		read: (threadKey) => redis.get(locatorKey(threadKey)),
		write: (threadKey, locator, ttlMs) =>
			redis.set(locatorKey(threadKey), locator, ttlMs),
		expire: (threadKey, ttlMs) => redis.pexpire(locatorKey(threadKey), ttlMs)
	}
	const controlChannel = (owner: string) => `${keyPrefix}ctl:${owner}`
	let unsubscribe: Promise<(() => Promise<void>) | undefined> | undefined
	let closed = false

	/** Redis failures never fail a turn: log and degrade. */
	const soft = <T>(op: string, promise: Promise<T>): Promise<T | undefined> =>
		promise.catch((error) => {
			logger.warn(`resumable: redis ${op} failed`, { error: String(error) })
			return undefined
		})

	function ensureSubscribed() {
		unsubscribe ??= redis
			.subscribe(controlChannel(replicaId), onControl)
			.catch((error) => {
				logger.warn('resumable: control channel subscribe failed', {
					error: String(error)
				})
				unsubscribe = undefined
				return undefined
			})
	}

	function writeSpill(key: string, entry: SpillEntry) {
		void soft('xadd', redis.xadd(key, JSON.stringify(entry)))
		void soft('expire', redis.expire(key, SPILL_TTL_SECONDS))
	}

	function onControl(message: string) {
		const control = parse<Control>(message)
		if (!control) return
		const run = [...runs.values()].find((r) => r.streamId === control.streamId)
		if (control.type === 'abort') return void run?.abort.abort()
		if (!run || run.overflow)
			return writeSpill(control.key, { end: 'unavailable' })
		// One XADD with the whole buffer; commands on one connection stay ordered, so batches follow it.
		writeSpill(control.key, { c: run.chunks })
		if (run.done) writeSpill(control.key, { end: 'done' })
		else run.spillKeys.push(control.key)
	}

	function flush(run: LiveRun) {
		if (!run.pending.length) return
		const entry = { c: run.pending }
		run.pending = []
		for (const key of run.spillKeys) writeSpill(key, entry)
	}

	/** Leading edge immediately, then at most one batch per `spillFlushMs`. */
	function scheduleFlush(run: LiveRun) {
		if (run.flushTimer) return
		flush(run)
		run.flushTimer = setTimeout(() => {
			run.flushTimer = undefined
			if (run.pending.length) scheduleFlush(run)
		}, spillFlushMs)
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
		if (run.spillKeys.length) {
			append(run.pending, chunk)
			scheduleFlush(run)
		}
	}

	function finish(run: LiveRun) {
		run.done = true
		clearTimeout(run.flushTimer)
		clearInterval(run.renewTimer)
		flush(run)
		for (const key of run.spillKeys) writeSpill(key, { end: 'done' })
		run.spillKeys = []
		for (const listener of run.listeners) listener(null)
		run.listeners.clear()
		if (locatorStore.expire)
			void soft('pexpire', locatorStore.expire(run.threadKey, graceMs))
		run.evictTimer = setTimeout(() => {
			if (runs.get(run.threadKey) === run) runs.delete(run.threadKey)
		}, graceMs)
		run.evictTimer.unref?.()
		run.resolveFinished()
	}

	async function pump(run: LiveRun, stream: ReadableStream<UIMessageChunk>) {
		const reader = stream.getReader()
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
		const key = `${keyPrefix}spill:${locator.streamId}:${crypto.randomUUID()}`
		const spill: Control = { type: 'spill', streamId: locator.streamId, key }
		let entries: StreamEntry[] = []
		try {
			await redis.publish(controlChannel(locator.owner), JSON.stringify(spill))
			entries = await reader.xread(key, '0', idleTimeoutMs)
		} catch (error) {
			if (!released)
				logger.warn('resumable: cross-replica reconnect failed', {
					error: String(error)
				})
		}
		const first = parse<SpillEntry>(entries[0]?.value)
		if (!first || 'end' in first) {
			release()
			return null
		}
		let lastId = '0'
		return new ReadableStream<UIMessageChunk>({
			async pull(controller) {
				try {
					while (!entries.length) {
						entries = await reader.xread(key, lastId, idleTimeoutMs)
						if (entries.length) break
						const current = parse<Locator>(await locatorStore.read(threadKey))
						if (current?.streamId === locator.streamId) continue
						controller.enqueue(ownerGone)
						throw new Error('owner gone')
					}
					for (const entry of entries.splice(0)) {
						lastId = entry.id
						const spillEntry = parse<SpillEntry>(entry.value)
						if (!spillEntry || 'end' in spillEntry) throw new Error('end')
						for (const chunk of spillEntry.c) controller.enqueue(chunk)
					}
				} catch {
					release()
					closeQuietly(controller)
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
			const previous = runs.get(threadKey)
			if (previous) clearTimeout(previous.evictTimer)
			const run: LiveRun = {
				threadKey,
				streamId: crypto.randomUUID(),
				abort,
				chunks: [],
				bytes: 0,
				overflow: false,
				done: false,
				listeners: new Set(),
				spillKeys: [],
				pending: [],
				finished,
				resolveFinished
			}
			runs.set(threadKey, run)
			ensureSubscribed()
			const locator: Locator = { streamId: run.streamId, owner: replicaId }
			void soft(
				'set',
				locatorStore.write(threadKey, JSON.stringify(locator), locatorTtlMs)
			)
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
			let timer: ReturnType<typeof setTimeout> | undefined
			const active = [...runs.values()]
				.filter((run) => !run.done)
				.map((run) => run.finished)
			await Promise.race([
				Promise.all(active),
				new Promise((resolve) => (timer = setTimeout(resolve, drainTimeoutMs)))
			])
			clearTimeout(timer)
			for (const run of runs.values()) {
				if (!run.done) run.abort.abort()
				clearTimeout(run.evictTimer)
			}
			runs.clear()
			for (const reader of readers) reader.close()
			readers.clear()
			const off = await unsubscribe
			if (off) await soft('unsubscribe', off())
		}
	}
}
