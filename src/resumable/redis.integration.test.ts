import { afterAll, describe, expect, test } from 'bun:test'
import type { UIMessageChunk } from 'ai'
import { RedisClient } from 'bun'
import Redis from 'ioredis'
import {
	bunRedis,
	createResumableStreams,
	createThreadLock,
	ioRedis,
	type ResumableRedis,
	type ThreadLockRedis
} from './index'

const url = process.env.REDIS_URL

describe.skipIf(!url)('real Redis', () => {
	const bun = new RedisClient(url)
	const io = new Redis(url as string)
	afterAll(() => {
		bun.close()
		io.disconnect()
	})

	// Owner on Bun, reader on ioredis: exercises both adapters and both XREAD reply shapes.
	test.each([
		['bun → ioredis', bunRedis(bun), ioRedis(io)],
		['ioredis → bun', ioRedis(io), bunRedis(bun)]
	] as [string, ResumableRedis, ResumableRedis][])(
		'cross-replica reconnect and stop (%s)',
		async (_, ownerRedis, readerRedis) => {
			const keyPrefix = `resumable-test:${crypto.randomUUID()}:`
			const owner = createResumableStreams({
				redis: ownerRedis,
				replicaId: 'owner',
				keyPrefix
			})
			const reader = createResumableStreams({
				redis: readerRedis,
				replicaId: 'reader',
				keyPrefix
			})
			let controller!: ReadableStreamDefaultController<UIMessageChunk>
			const abort = new AbortController()
			abort.signal.addEventListener('abort', () => {
				controller.enqueue({ type: 'abort' })
				controller.close()
			})
			const stream = new ReadableStream<UIMessageChunk>({
				start(c) {
					controller = c
				}
			})
			const response = await owner.start({ threadKey: 't', stream, abort })
			controller.enqueue({ type: 'start' })
			controller.enqueue({ type: 'text-start', id: 'x' })
			controller.enqueue({ type: 'text-delta', id: 'x', delta: 'before ' })
			await Bun.sleep(50) // locator SET and control SUBSCRIBE land

			const resumed = await reader.reconnect('t')
			controller.enqueue({ type: 'text-delta', id: 'x', delta: 'after' })
			await Bun.sleep(100)
			expect(await reader.stop('t')).toBe(true)

			const [original, remote] = await Promise.all([
				Array.fromAsync(response),
				Array.fromAsync(resumed!)
			])
			const text = (chunks: UIMessageChunk[]) =>
				chunks.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('')
			expect(text(original)).toBe('before after')
			expect(text(remote)).toBe('before after')
			expect(remote.at(-1)?.type).toBe('abort')
			await Promise.all([owner.close(), reader.close()])
		}
	)
	// Claimed on one client, contended and renewed on the other: both adapters' SET NX and scripts.
	test.each([
		['bun → ioredis', bunRedis(bun), ioRedis(io)],
		['ioredis → bun', ioRedis(io), bunRedis(bun)]
	] as [string, ThreadLockRedis, ThreadLockRedis][])(
		'a thread lock held across replicas (%s)',
		async (_, holderRedis, otherRedis) => {
			const keyPrefix = `thread-lock-test:${crypto.randomUUID()}:`
			const holder = createThreadLock({
				redis: holderRedis,
				keyPrefix,
				ttlMs: 300
			})
			const other = createThreadLock({
				redis: otherRedis,
				keyPrefix,
				ttlMs: 300
			})

			const release = await holder({ threadId: 't' })
			expect(release).not.toBeNull()
			expect(await other({ threadId: 't' })).toBeNull()

			// Past the TTL the renewal still holds it.
			await new Promise((resolve) => setTimeout(resolve, 700))
			expect(await other({ threadId: 't' })).toBeNull()

			await release?.()
			const next = await other({ threadId: 't' })
			expect(next).not.toBeNull()

			// A release by one that no longer holds it changes nothing.
			await holderRedis.deleteIfEquals(`${keyPrefix}t`, 'not-the-token')
			expect(await holder({ threadId: 't' })).toBeNull()
			await next?.()
		}
	)
})
