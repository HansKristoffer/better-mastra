import { once } from 'hanzio'
/** One stream entry: its id and the single value stored under field `d`. */
export interface StreamEntry {
	id: string
	value: string
}

/** A dedicated connection for blocking reads, so `XREAD BLOCK` never stalls other commands. */
export interface BlockingReader {
	/** `XREAD BLOCK blockMs STREAMS key afterId`; resolves `[]` when the block times out. */
	xread(key: string, afterId: string, blockMs: number): Promise<StreamEntry[]>
	close(): void
}

/** The few Redis commands resumable streams need. Use `bunRedis` or `ioRedis`, or implement it. */
export interface ResumableRedis {
	/** `SET key value PX ttlMs GET` (Redis 6.2+): resolves with the value it replaced. */
	set(key: string, value: string, ttlMs: number): Promise<string | null>
	get(key: string): Promise<string | null>
	del(key: string): Promise<void>
	pexpire(key: string, ttlMs: number): Promise<void>
	expire(key: string, seconds: number): Promise<void>
	publish(channel: string, message: string): Promise<void>
	/** Subscribes on a separate connection. Resolves with an unsubscribe function. */
	subscribe(
		channel: string,
		onMessage: (message: string) => void
	): Promise<() => Promise<void>>
	xadd(key: string, value: string): Promise<void>
	/** Opens a dedicated connection for one reader. */
	reader(): Promise<BlockingReader>
}

/** Stands in when there is no Redis: no locator is ever found, so every turn stays on its own process. */
export const noRedis: ResumableRedis = {
	set: async () => null,
	get: async () => null,
	del: async () => {},
	pexpire: async () => {},
	expire: async () => {},
	publish: async () => {},
	subscribe: async () => async () => {},
	xadd: async () => {},
	reader: () => Promise.reject(new Error('resumable: no redis'))
}

type Send = (command: string, args: string[]) => Promise<unknown>

/** RESP2 replies are `[[key, entries]]`; Bun's RESP3 replies are `{ key: entries }`. */
function parseXread(reply: unknown): StreamEntry[] {
	if (!reply) return []
	const streams = Array.isArray(reply)
		? reply.map((s) => s[1])
		: Object.values(reply)
	const entries = (streams[0] ?? []) as [string, string[]][]
	return entries.map(([id, fields]) => ({ id, value: fields[1] ?? '' }))
}

function fromSend(
	send: Send,
	rest: Pick<ResumableRedis, 'subscribe' | 'reader'>
): ResumableRedis {
	return {
		set: async (key, value, ttlMs) =>
			((await send('SET', [key, value, 'PX', String(ttlMs), 'GET'])) as
				string | null) ?? null,
		get: async (key) => ((await send('GET', [key])) as string | null) ?? null,
		del: async (key) => void (await send('DEL', [key])),
		pexpire: async (key, ttlMs) =>
			void (await send('PEXPIRE', [key, String(ttlMs)])),
		expire: async (key, seconds) =>
			void (await send('EXPIRE', [key, String(seconds)])),
		publish: async (channel, message) =>
			void (await send('PUBLISH', [channel, message])),
		xadd: async (key, value) =>
			void (await send('XADD', [key, '*', 'd', value])),
		...rest
	}
}

const xreadArgs = (key: string, afterId: string, blockMs: number) => [
	'BLOCK',
	String(blockMs),
	'STREAMS',
	key,
	afterId
]

interface BunRedisLike {
	send(command: string, args: string[]): Promise<unknown>
	duplicate(): Promise<BunRedisLike>
	subscribe(
		channel: string,
		listener: (message: string) => void
	): Promise<unknown>
	close(): void
}

/** Adapter for Bun's built-in `RedisClient`. */
export function bunRedis(client: BunRedisLike): ResumableRedis {
	return fromSend((command, args) => client.send(command, args), {
		async subscribe(channel, onMessage) {
			const subscriber = await client.duplicate()
			await subscriber.subscribe(channel, onMessage)
			return async () => subscriber.close()
		},
		async reader() {
			const connection = await client.duplicate()
			return {
				xread: async (key, afterId, blockMs) =>
					parseXread(
						await connection.send('XREAD', xreadArgs(key, afterId, blockMs))
					),
				close: () => connection.close()
			}
		}
	})
}

interface IoRedisLike {
	call(command: string, ...args: string[]): Promise<unknown>
	duplicate(): IoRedisLike
	subscribe(channel: string): Promise<unknown>
	on(
		event: 'message',
		listener: (channel: string, message: string) => void
	): unknown
	disconnect(): void
}

/** Adapter for `ioredis`. */
export function ioRedis(client: IoRedisLike): ResumableRedis {
	return fromSend((command, args) => client.call(command, ...args), {
		async subscribe(channel, onMessage) {
			const subscriber = client.duplicate()
			subscriber.on(
				'message',
				(from, message) => from === channel && onMessage(message)
			)
			await subscriber.subscribe(channel)
			return async () => subscriber.disconnect()
		},
		async reader() {
			const connection = client.duplicate()
			return {
				xread: async (key, afterId, blockMs) =>
					parseXread(
						await connection.call('XREAD', ...xreadArgs(key, afterId, blockMs))
					),
				close: () => connection.disconnect()
			}
		}
	})
}

/** The `@upstash/redis` `Redis` methods the adapter uses. */
export interface UpstashRedisLike {
	get(key: string): Promise<unknown>
	set(
		key: string,
		value: string,
		options: { px: number; get: true }
	): Promise<unknown>
	del(key: string): Promise<unknown>
	pexpire(key: string, milliseconds: number): Promise<unknown>
	expire(key: string, seconds: number): Promise<unknown>
	publish(channel: string, message: string): Promise<unknown>
	subscribe(channel: string): {
		on(
			type: 'message',
			listener: (event: { channel: string; message: unknown }) => void
		): void
		unsubscribe(): Promise<void>
	}
	xadd(key: string, id: '*', entries: Record<string, string>): Promise<unknown>
	xread(key: string, id: string): Promise<unknown>
}

/**
 * With `automaticDeserialization` on (Upstash's default) a JSON value comes
 * back parsed; the streams want the text they wrote.
 */
const asText = (value: unknown): string | null =>
	value === null || value === undefined
		? null
		: typeof value === 'string'
			? value
			: JSON.stringify(value)

/**
 * Adapter for `@upstash/redis`. Upstash speaks HTTP and has no blocking
 * `XREAD`, so a cross-replica reader polls every `pollMs` (default 200 ms).
 * Pass a function to create the client on first use, so a process without
 * Upstash credentials still runs turns (only not resumable across replicas).
 */
export function upstashRedis(
	client: UpstashRedisLike | (() => UpstashRedisLike),
	options: { pollMs?: number } = {}
): ResumableRedis {
	const { pollMs = 200 } = options
	const redis = once(() => (typeof client === 'function' ? client() : client))
	return {
		set: async (key, value, ttlMs) =>
			asText(await redis().set(key, value, { px: ttlMs, get: true })),
		get: async (key) => asText(await redis().get(key)),
		del: async (key) => void (await redis().del(key)),
		pexpire: async (key, ttlMs) => void (await redis().pexpire(key, ttlMs)),
		expire: async (key, seconds) => void (await redis().expire(key, seconds)),
		publish: async (channel, message) =>
			void (await redis().publish(channel, message)),
		async subscribe(channel, onMessage) {
			const subscriber = redis().subscribe(channel)
			subscriber.on('message', ({ message }) =>
				onMessage(asText(message) ?? '')
			)
			return () => subscriber.unsubscribe()
		},
		xadd: async (key, value) =>
			void (await redis().xadd(key, '*', { d: value })),
		async reader() {
			let closed = false
			let wake: (() => void) | undefined
			return {
				async xread(key, afterId, blockMs) {
					const deadline = Date.now() + blockMs
					while (!closed) {
						const entries = parseXread(await redis().xread(key, afterId)).map(
							(entry) => ({ ...entry, value: asText(entry.value) ?? '' })
						)
						if (entries.length || Date.now() >= deadline) return entries
						await new Promise<void>((resolve) => {
							wake = resolve
							setTimeout(resolve, Math.min(pollMs, deadline - Date.now()))
						})
					}
					return []
				},
				close() {
					closed = true
					wake?.()
				}
			}
		}
	}
}
