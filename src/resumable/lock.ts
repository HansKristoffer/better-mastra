/**
 * One turn per thread: the lock `runChatTurn` and `createThreadHandlers` take
 * as their `lock` port. A claim is a key only its holder can release, renewed
 * while it is held and left to expire if the process dies, so a crash blocks
 * the thread for at most `ttlMs`.
 *
 * It follows the resumable streams' rule that Redis never fails a turn: when
 * Redis does not answer, the claim is logged and the turn runs under the
 * process's own lock alone, which still keeps two turns of one thread apart
 * on this replica.
 */

import { getErrorMessage } from 'hanzio'

import type { ThreadLockRedis } from './redis.js'

export interface ThreadLockLogger {
	warn(message: string, attributes?: Record<string, unknown>): void
}

export interface ThreadLockOptions {
	/**
	 * Shares the lock across replicas: `bunRedis`, `ioRedis` or `upstashRedis`.
	 * Leave it out for one process (local development, a single instance).
	 */
	readonly redis?: ThreadLockRedis
	/**
	 * How long a claim lives without renewal, which happens every third of
	 * it: how long a thread stays held after its process died. Default 30 s.
	 */
	readonly ttlMs?: number
	readonly keyPrefix?: string
	readonly logger?: ThreadLockLogger
}

/** Claims a thread: its release, or null while another turn holds it. */
export type ThreadLock = (thread: {
	readonly threadId: string
}) => Promise<(() => Promise<void>) | null>

/** A thread lock for `runChatTurn`'s and `createThreadHandlers`' `lock`. */
export function createThreadLock(options: ThreadLockOptions = {}): ThreadLock {
	const {
		redis,
		ttlMs = 30_000,
		keyPrefix = 'thread-lock:',
		logger = {
			// biome-ignore lint/suspicious/noConsole: default logger
			warn: (message, attributes) => console.warn(message, attributes)
		}
	} = options
	/** The threads this process holds, so two turns here never both ask Redis. */
	const held = new Set<string>()

	const soft = async <T>(
		op: string,
		work: Promise<T>
	): Promise<T | undefined> => {
		try {
			return await work
		} catch (error) {
			logger.warn(`thread lock: redis ${op} failed`, {
				error: getErrorMessage(error)
			})

			return undefined
		}
	}

	return async ({ threadId }) => {
		const key = keyPrefix + threadId

		// Taken before any await, so two claims in one tick cannot both pass.
		if (held.has(key)) return null
		held.add(key)

		if (!redis) return async () => void held.delete(key)

		const token = crypto.randomUUID()
		const claimed = await soft('claim', redis.setIfAbsent(key, token, ttlMs))

		if (claimed === false) {
			held.delete(key)

			return null
		}

		// A claim that never answered runs unrenewed: this process cannot tell
		// whether it holds the key.
		const renewal =
			claimed === true
				? setInterval(async () => {
						const renewed = await soft(
							'renewal',
							redis.expireIfEquals(key, token, ttlMs)
						)

						if (renewed === false) {
							// Expired and possibly taken: nothing here can take it back.
							clearInterval(renewal)
							logger.warn(
								'thread lock: the claim was lost before its release',
								{ threadId }
							)
						}
					}, ttlMs / 3)
				: undefined
		renewal?.unref?.()

		return async () => {
			clearInterval(renewal)
			held.delete(key)
			// Also after a claim that never answered: it may have gone through.
			await soft('release', redis.deleteIfEquals(key, token))
		}
	}
}
