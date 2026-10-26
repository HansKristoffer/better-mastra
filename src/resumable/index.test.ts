import { afterEach, expect, test } from 'bun:test'
import { Redis } from '@upstash/redis'
import type { UIMessageChunk } from 'ai'
import {
	createResumableStreams,
	type ResumableRedis,
	type ResumableStreams,
	type StreamEntry,
	type UpstashRedisLike,
	upstashRedis
} from './index'

/** Shared in-memory Redis; each `client()` is one replica's connection with its own op counter. */
class FakeRedis {
	values = new Map<string, { value: string; expiresAt: number }>()
	streams = new Map<string, StreamEntry[]>()
	channels = new Map<string, Set<(message: string) => void>>()
	waiters = new Set<() => void>()
	seq = 0

	client() {
		/** `jitter` lands each command after a random delay, as concurrent HTTP requests may. */
		const view = { ops: 0, down: false, jitter: false }
		const op = async <T>(fn: () => T | Promise<T>): Promise<T> => {
			view.ops++
			if (view.jitter) await tick(Math.random() * 4)
			if (view.down) throw new Error('redis down')
			return fn()
		}
		const live = (key: string) => {
			const entry = this.values.get(key)
			if (entry && entry.expiresAt <= Date.now()) this.values.delete(key)
			return this.values.get(key)
		}
		const after = (key: string, id: string) =>
			(this.streams.get(key) ?? []).filter((e) => Number(e.id) > Number(id))
		const redis: ResumableRedis = {
			set: (key, value, ttlMs) =>
				op(() => {
					const replaced = live(key)?.value ?? null
					this.values.set(key, { value, expiresAt: Date.now() + ttlMs })
					return replaced
				}),
			get: (key) => op(() => live(key)?.value ?? null),
			del: (key) => op(() => void this.values.delete(key)),
			pexpire: (key, ttlMs) =>
				op(() => {
					const entry = live(key)
					if (entry) entry.expiresAt = Date.now() + ttlMs
				}),
			expire: (_key, _seconds) => op(() => undefined),
			publish: (channel, message) =>
				op(() => {
					for (const handler of this.channels.get(channel) ?? [])
						queueMicrotask(() => handler(message))
				}),
			subscribe: (channel, onMessage) =>
				op(() => {
					const handlers = this.channels.get(channel) ?? new Set()
					this.channels.set(channel, handlers.add(onMessage))
					return async () => void handlers.delete(onMessage)
				}),
			xadd: (key, value) =>
				op(() => {
					this.streams.set(key, [
						...(this.streams.get(key) ?? []),
						{ id: String(++this.seq), value }
					])
					for (const wake of this.waiters) wake()
				}),
			reader: () =>
				op(() => {
					let closed: (() => void) | undefined
					return {
						xread: (key, afterId, blockMs) =>
							op(
								() =>
									new Promise<StreamEntry[]>((resolve, reject) => {
										const check = () => {
											const entries = after(key, afterId)
											if (!entries.length) return false
											done(() => resolve(entries))
											return true
										}
										const timer = setTimeout(
											() => done(() => resolve([])),
											blockMs
										)
										const done = (settle: () => void) => {
											clearTimeout(timer)
											this.waiters.delete(wake)
											closed = undefined
											settle()
										}
										const wake = () => void check()
										closed = () =>
											done(() => reject(new Error('connection closed')))
										if (!check()) this.waiters.add(wake)
									})
							),
						close: () => closed?.()
					}
				})
		}
		return { redis, view }
	}
}

function source() {
	let controller!: ReadableStreamDefaultController<UIMessageChunk>
	const stream = new ReadableStream<UIMessageChunk>({
		start(c) {
			controller = c
		}
	})
	const abort = new AbortController()
	abort.signal.addEventListener('abort', () => {
		controller.enqueue({ type: 'abort' })
		controller.close()
	})
	return {
		stream,
		abort,
		write: (chunk: UIMessageChunk) => controller.enqueue(chunk),
		text: (delta: string) =>
			controller.enqueue({ type: 'text-delta', id: 't1', delta }),
		begin: () => {
			controller.enqueue({ type: 'start', messageId: 'm1' })
			controller.enqueue({ type: 'text-start', id: 't1' })
		},
		end: () => {
			controller.enqueue({ type: 'text-end', id: 't1' })
			controller.enqueue({ type: 'finish' })
			controller.close()
		}
	}
}

async function collect(stream: ReadableStream<UIMessageChunk> | null) {
	if (!stream) throw new Error('expected a stream')
	return Array.fromAsync(stream)
}

const textOf = (chunks: UIMessageChunk[]) =>
	chunks.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('')
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

const open: ResumableStreams[] = []
function setup(
	options: Partial<Parameters<typeof createResumableStreams>[0]> = {}
) {
	const fake = new FakeRedis()
	const replica = (replicaId: string) => {
		const { redis, view } = fake.client()
		const streams = createResumableStreams({
			redis,
			replicaId,
			logger: { warn() {} },
			...options
		})
		open.push(streams)
		return { streams, view }
	}
	return { fake, a: replica('a'), b: replica('b') }
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((s) => s.close()))
})

test('same-replica reconnect replays from memory with zero Redis ops', async () => {
	const { a } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	await tick()
	const opsAfterStart = a.view.ops
	turn.begin()
	turn.text('Hel')
	turn.text('lo')
	await tick()
	const resumed = await a.streams.reconnect('t')
	turn.text(' world')
	turn.end()
	const [original, replay] = await Promise.all([
		collect(response),
		collect(resumed)
	])
	expect(a.view.ops - opsAfterStart).toBe(1) // only the finish PEXPIRE: nothing per chunk, nothing to reconnect
	expect(textOf(original)).toBe('Hello world')
	expect(textOf(replay)).toBe('Hello world')
	expect(
		replay
			.filter((c) => c.type === 'text-delta')
			.map((c) => c.type === 'text-delta' && c.delta)
	).toEqual(['Hello', ' world'])
})

test('cross-replica reconnect mid-stream gets full ordered content once', async () => {
	const { a, b } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	for (let i = 0; i < 100; i++) turn.text(`${i},`)
	await tick()
	const resumed = await b.streams.reconnect('t')
	for (let i = 100; i < 200; i++) {
		turn.text(`${i},`)
		if (i % 20 === 0) await tick(5)
	}
	turn.end()
	const [original, remote] = await Promise.all([
		collect(response),
		collect(resumed)
	])
	const expected = Array.from({ length: 200 }, (_, i) => `${i},`).join('')
	expect(textOf(original)).toBe(expected)
	expect(textOf(remote)).toBe(expected)
	expect(remote[0]?.type).toBe('start')
	expect(remote.at(-1)?.type).toBe('finish')
})

test('reconnect after finish replays within grace, 204 after', async () => {
	const { a, b } = setup({ graceMs: 60 })
	const turn = source()
	await collect(
		await a.streams.start({ threadKey: 't', ...turn }).then((s) => {
			turn.begin()
			turn.text('done')
			turn.end()
			return s
		})
	)
	expect(textOf(await collect(await a.streams.reconnect('t')))).toBe('done')
	expect(textOf(await collect(await b.streams.reconnect('t')))).toBe('done')
	await tick(80)
	expect(await a.streams.reconnect('t')).toBeNull()
	expect(await b.streams.reconnect('t')).toBeNull()
})

test('stop from the other replica aborts the owner', async () => {
	const { a, b } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	await tick()
	expect(await b.streams.stop('t')).toBe(true)
	const chunks = await collect(response)
	expect(turn.abort.signal.aborted).toBe(true)
	expect(chunks.at(-1)?.type).toBe('abort')
	expect(await b.streams.stop('unknown')).toBe(false)
})

test('client disconnect does not abort the turn', async () => {
	const { a } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	await response.cancel()
	turn.begin()
	turn.text('still running')
	turn.end()
	expect(turn.abort.signal.aborted).toBe(false)
	expect(textOf(await collect(await a.streams.reconnect('t')))).toBe(
		'still running'
	)
})

test('owner crash ends the cross-replica reader with an error chunk', async () => {
	const { a, b } = setup({
		locatorTtlMs: 60,
		idleTimeoutMs: 40,
		drainTimeoutMs: 10
	})
	const turn = source()
	await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('partial')
	await tick()
	const resumed = await b.streams.reconnect('t')
	a.view.down = true // owner stops renewing its locator and writing chunks
	const chunks = await collect(resumed)
	expect(textOf(chunks)).toBe('partial')
	expect(chunks.at(-1)).toEqual({
		type: 'error',
		errorText: 'The stream owner stopped responding.'
	})
})

test('Redis down: the turn and same-replica reconnect still work, cross-replica returns null', async () => {
	const { a, b } = setup({ idleTimeoutMs: 20 })
	a.view.down = true
	b.view.down = true
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('hi')
	const resumed = await a.streams.reconnect('t')
	expect(await b.streams.reconnect('t')).toBeNull()
	expect(await b.streams.stop('t')).toBe(false)
	turn.end()
	expect(textOf(await collect(response))).toBe('hi')
	expect(textOf(await collect(resumed))).toBe('hi')
})

test('buffer cap: turn keeps streaming but is no longer resumable', async () => {
	const { a, b } = setup({ maxBufferBytes: 100, idleTimeoutMs: 20 })
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	for (let i = 0; i < 50; i++) turn.text('xxxx')
	await tick()
	expect(await a.streams.reconnect('t')).toBeNull()
	expect(await b.streams.reconnect('t')).toBeNull()
	turn.end()
	expect(textOf(await collect(response))).toBe('x'.repeat(200))
})

test('close() waits for active turns', async () => {
	const { a } = setup()
	const turn = source()
	await a.streams.start({ threadKey: 't', ...turn })
	let closed = false
	const closing = a.streams.close().then(() => (closed = true))
	await tick(10)
	expect(closed).toBe(false)
	turn.begin()
	turn.end()
	await closing
	expect(turn.abort.signal.aborted).toBe(false)
	await expect(
		a.streams.start({ threadKey: 'x', ...source() })
	).rejects.toThrow()
})

test('locator hook: the locator lives in the app lock value and dies with it', async () => {
	// The app's per-thread lock holds `token|locator`; releasing the lock drops the locator.
	const locks = new Map<string, string>()
	const locator = {
		read: async (threadKey: string) =>
			locks.get(threadKey)?.split('|')[1] ?? null,
		write: async (threadKey: string, value: string) => {
			const held = locks.get(threadKey)
			if (held) locks.set(threadKey, `${held.split('|')[0]}|${value}`)
		}
	}
	const { fake, a, b } = setup({ locator })
	locks.set('t', 'token-1')
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('Hello')
	await tick()
	expect(locks.get('t')).toStartWith('token-1|{')
	const resumed = await b.streams.reconnect('t')
	turn.text(' there')
	turn.end()
	expect(textOf(await collect(resumed))).toBe('Hello there')
	await collect(response)
	expect([...fake.values.keys()].some((key) => key.includes('loc:'))).toBe(
		false
	)
	locks.delete('t') // the turn releases its lock
	expect(await b.streams.reconnect('t')).toBeNull()
})

test('repeated cross-replica reconnects share one spill stream', async () => {
	const { fake, a, b } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('Hel')
	await tick()
	const first = await b.streams.reconnect('t')
	await first?.cancel() // a flaky client drops the stream and reconnects
	turn.text('lo')
	await tick(5)
	const second = await b.streams.reconnect('t')
	turn.text('!')
	turn.end()
	expect(textOf(await collect(second))).toBe('Hello!')
	await collect(response)
	expect([...fake.streams.keys()]).toHaveLength(1)
})

test('a silent owner answers a cross-replica reconnect with null quickly', async () => {
	const { fake, b } = setup({ idleTimeoutMs: 10_000 })
	// The owner crashed; its locator has not expired yet.
	fake.values.set('resumable:loc:t', {
		value: JSON.stringify({ streamId: 's', owner: 'gone' }),
		expiresAt: Date.now() + 30_000
	})
	const started = Date.now()
	expect(await b.streams.reconnect('t')).toBeNull()
	expect(Date.now() - started).toBeLessThan(3_000)
})

test('no locator until the owner listens on its control channel', async () => {
	const fake = new FakeRedis()
	const { redis } = fake.client()
	let failSubscribe = true
	const a = createResumableStreams({
		redis: {
			...redis,
			subscribe: (channel, onMessage) =>
				failSubscribe
					? Promise.reject(new Error('subscribe failed'))
					: redis.subscribe(channel, onMessage)
		},
		logger: { warn() {} }
	})
	open.push(a)
	const turn = source()
	await a.start({ threadKey: 't', ...turn })
	await tick()
	expect(fake.values.has('resumable:loc:t')).toBe(false)
	turn.end()
	failSubscribe = false
	const next = source()
	await a.start({ threadKey: 'u', ...next }) // subscribing is retried
	await tick()
	expect(fake.values.has('resumable:loc:u')).toBe(true)
	next.end()
})

test('spill entries stay ordered on a client that reorders commands', async () => {
	const { a, b } = setup()
	const turn = source()
	const response = await a.streams.start({ threadKey: 't', ...turn })
	await tick(10)
	a.view.jitter = true
	turn.begin()
	for (let i = 0; i < 20; i++) turn.text(`${i},`)
	const resumed = await b.streams.reconnect('t')
	for (let i = 20; i < 60; i++) {
		turn.text(`${i},`)
		await tick(1)
	}
	turn.end()
	const expected = Array.from({ length: 60 }, (_, i) => `${i},`).join('')
	expect(textOf(await collect(resumed))).toBe(expected)
	await collect(response)
})

test('a new turn on the thread aborts the one still running', async () => {
	const { a } = setup()
	const old = source()
	const oldResponse = await a.streams.start({ threadKey: 't', ...old })
	old.begin()
	const next = source()
	await a.streams.start({ threadKey: 't', ...next })
	expect(old.abort.signal.aborted).toBe(true)
	expect((await collect(oldResponse)).at(-1)?.type).toBe('abort')
	expect(next.abort.signal.aborted).toBe(false)
	next.end()
})

test('reasoning and tool input deltas are merged in the replay', async () => {
	const { a } = setup()
	const turn = source()
	await a.streams.start({ threadKey: 't', ...turn })
	turn.write({ type: 'reasoning-start', id: 'r' })
	for (const delta of ['thi', 'nk'])
		turn.write({ type: 'reasoning-delta', id: 'r', delta })
	turn.write({ type: 'tool-input-start', toolCallId: 'c', toolName: 'x' })
	for (const inputTextDelta of ['{"a"', ':1}'])
		turn.write({ type: 'tool-input-delta', toolCallId: 'c', inputTextDelta })
	turn.end()
	await tick()
	const replay = await collect(await a.streams.reconnect('t'))
	expect(replay.filter((c) => c.type === 'reasoning-delta')).toEqual([
		{ type: 'reasoning-delta', id: 'r', delta: 'think' }
	])
	expect(replay.filter((c) => c.type === 'tool-input-delta')).toEqual([
		{ type: 'tool-input-delta', toolCallId: 'c', inputTextDelta: '{"a":1}' }
	])
})

test('without redis: one process resumes and stops its own turns', async () => {
	const streams = createResumableStreams({ logger: { warn() {} } })
	open.push(streams)
	const turn = source()
	await streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('hi')
	await tick()
	const resumed = await streams.reconnect('t')
	expect(await streams.reconnect('other')).toBeNull()
	expect(await streams.stop('t')).toBe(true)
	const chunks = await collect(resumed)
	expect(textOf(chunks)).toBe('hi')
	expect(chunks.at(-1)?.type).toBe('abort')
})

test('a new turn on another replica aborts the one still running', async () => {
	const { a, b } = setup()
	const old = source()
	const oldResponse = await a.streams.start({ threadKey: 't', ...old })
	old.begin()
	await tick()
	const next = source()
	await b.streams.start({ threadKey: 't', ...next })
	expect((await collect(oldResponse)).at(-1)?.type).toBe('abort')
	expect(next.abort.signal.aborted).toBe(false)
	next.end()
})

test('a stop that reaches a finished turn leaves its signal alone', async () => {
	const { a, b } = setup()
	const turn = source()
	await collect(
		await a.streams.start({ threadKey: 't', ...turn }).then((s) => {
			turn.begin()
			turn.end()
			return s
		})
	)
	expect(await b.streams.stop('t')).toBe(true)
	await tick()
	expect(turn.abort.signal.aborted).toBe(false)
})

test('a stopped turn whose stream ignores the abort ends after stopTimeoutMs', async () => {
	const { a } = setup({ stopTimeoutMs: 20 })
	let controller!: ReadableStreamDefaultController<UIMessageChunk>
	const stream = new ReadableStream<UIMessageChunk>({
		start(c) {
			controller = c
		}
	})
	const abort = new AbortController()
	const response = await a.streams.start({ threadKey: 't', stream, abort })
	controller.enqueue({ type: 'start' })
	await a.streams.stop('t') // a tool that ignores the signal keeps the stream open
	const chunks = await collect(response)
	expect(chunks.map((c) => c.type)).toEqual(['start', 'abort'])
})

test('a failed liveness read keeps a cross-replica reader waiting', async () => {
	const values = new Map<string, string>()
	let failReads = false
	const locator = {
		read: async (threadKey: string) => {
			if (failReads) throw new Error('redis blip')
			return values.get(threadKey) ?? null
		},
		write: async (threadKey: string, value: string) => {
			const replaced = values.get(threadKey) ?? null
			values.set(threadKey, value)
			return replaced
		}
	}
	const { a, b } = setup({ locator, idleTimeoutMs: 10 })
	const turn = source()
	await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('Hel')
	await tick()
	const reading = collect(await b.streams.reconnect('t'))
	failReads = true
	await tick(50) // several idle checks fail
	failReads = false
	turn.text('lo')
	turn.end()
	const chunks = await reading
	expect(textOf(chunks)).toBe('Hello')
	expect(chunks.at(-1)?.type).toBe('finish')
})

test('a failed cross-replica read ends the stream with an error chunk', async () => {
	const { a, b } = setup()
	const turn = source()
	await a.streams.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('Hel')
	await tick()
	const resumed = await b.streams.reconnect('t')
	b.view.down = true // the reader's XREAD fails
	const chunks = await collect(resumed)
	expect(textOf(chunks)).toBe('Hel')
	expect(chunks.at(-1)).toEqual({
		type: 'error',
		errorText: 'The resumed stream was interrupted.'
	})
	turn.end()
})

/** `@upstash/redis` with its default `automaticDeserialization`: JSON values come back parsed. */
function fakeUpstash() {
	const values = new Map<string, string>()
	const streams = new Map<string, [string, string[]][]>()
	const channels = new Map<string, Set<(message: unknown) => void>>()
	let seq = 0
	let xreads = 0
	const parsed = (value: string): unknown => {
		try {
			return JSON.parse(value)
		} catch {
			return value
		}
	}
	const client = (): UpstashRedisLike => ({
		get: async (key) => {
			const value = values.get(key)
			return value === undefined ? null : parsed(value)
		},
		set: async (key, value) => {
			const replaced = values.get(key)
			values.set(key, value)
			return replaced === undefined ? null : parsed(replaced)
		},
		del: async (key) => void values.delete(key),
		pexpire: async () => 1,
		expire: async () => 1,
		publish: async (channel, message) => {
			for (const handler of channels.get(channel) ?? [])
				queueMicrotask(() => handler(parsed(message)))
		},
		subscribe: (channel) => {
			const handlers = channels.get(channel) ?? new Set()
			channels.set(channel, handlers)
			let handler: ((message: unknown) => void) | undefined
			return {
				on: (_type, listener) => {
					handler = (message) => listener({ channel, message })
					handlers.add(handler)
				},
				unsubscribe: async () => void (handler && handlers.delete(handler))
			}
		},
		xadd: async (key, _id, entries) => {
			streams.set(key, [
				...(streams.get(key) ?? []),
				[`${++seq}-0`, ['d', entries.d ?? '']]
			])
		},
		xread: async (key, id) => {
			xreads++
			const after = Number(id.split('-')[0])
			const entries = (streams.get(key) ?? [])
				.filter(([entryId]) => Number(entryId.split('-')[0]) > after)
				.map(([entryId, [field, value]]) => [
					entryId,
					[field, parsed(value ?? '')]
				])
			return entries.length ? [[key, entries]] : []
		}
	})
	return { client, xreads: () => xreads }
}

test('upstashRedis takes an @upstash/redis client as is', () => {
	// Constructing the client sends nothing; this pins the structural type.
	expect(
		upstashRedis(new Redis({ url: 'https://example.invalid', token: 't' }))
	).toBeDefined()
})

test('upstashRedis: cross-replica reconnect and stop by polling', async () => {
	const upstash = fakeUpstash()
	let created = 0
	const replica = (replicaId: string) => {
		const streams = createResumableStreams({
			redis: upstashRedis(
				() => {
					created++
					return upstash.client()
				},
				{ pollMs: 5 }
			),
			replicaId,
			logger: { warn() {} }
		})
		open.push(streams)
		return streams
	}
	const a = replica('a')
	const b = replica('b')
	expect(created).toBe(0) // the client is created on first use
	const turn = source()
	const response = await a.start({ threadKey: 't', ...turn })
	turn.begin()
	turn.text('Hel')
	await tick()
	const reading = collect(await b.reconnect('t'))
	const pollsBefore = upstash.xreads()
	await tick(30)
	expect(upstash.xreads()).toBeGreaterThan(pollsBefore + 2) // no blocking XREAD: it polls
	turn.text('lo')
	turn.end()
	const chunks = await reading
	expect(textOf(chunks)).toBe('Hello')
	expect(chunks.at(-1)?.type).toBe('finish')
	await collect(response)

	const second = source()
	const running = await a.start({ threadKey: 'u', ...second })
	second.begin()
	await tick()
	expect(await b.stop('u')).toBe(true)
	expect((await collect(running)).at(-1)?.type).toBe('abort')
})
