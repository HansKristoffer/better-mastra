/**
 * Abuse strikes per user in Redis: each abusive message screening declines
 * is a strike, counted by category; enough strikes inside the window pause
 * the user. Only an HMAC of the user id and the category reach Redis, never
 * what the user wrote.
 */

import { createHmac } from 'node:crypto'
import { raceAbort } from 'hanzio'

import type { RunRedisScript } from './userRequests.js'

// KEYS: strikes counter, pause flag, category counts. ARGV: window seconds,
// strikes that pause, pause seconds, category. Returns the strikes in the
// window and the pause's seconds left (0 when not paused).
export const ABUSE_STRIKE_SCRIPT = `
local strikes = redis.call('INCR', KEYS[1])
if strikes == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
redis.call('HINCRBY', KEYS[3], ARGV[4], 1)
redis.call('EXPIRE', KEYS[3], ARGV[1])
if strikes >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
  redis.call('DEL', KEYS[1])
end
local left = redis.call('TTL', KEYS[2])
if left < 0 then left = 0 end
return { strikes, left }
`

// KEYS: pause flag. Returns the pause's seconds left, 0 when not paused.
export const ABUSE_PAUSE_SCRIPT = `
local left = redis.call('TTL', KEYS[1])
if left < 0 then return 0 end
return left
`

export type AbusePause =
	| { readonly kind: 'ok' }
	| { readonly kind: 'paused'; readonly retryAfterSeconds: number }
	| { readonly kind: 'unavailable'; readonly error: unknown }

export interface AbuseStrikes {
	/** Whether the user is paused, and for how long. */
	check(userId: string): Promise<AbusePause>
	/** Counts one strike; the result says whether it paused the user. */
	record(userId: string, category: string): Promise<AbusePause>
}

/**
 * Strikes for the screening port of `runChatTurn`. `maxStrikes` (3) abusive
 * messages inside `windowSeconds` (a day) pause the user for
 * `pauseSeconds` (an hour). A Redis that fails or does not answer within
 * `timeoutMs` (3 s) gives `unavailable`; `screeningStrikes` lets the user
 * through then.
 */
export function createAbuseStrikes(input: {
	readonly runScript: RunRedisScript
	/** Signs the user id in the keys. */
	readonly secret: string
	/** Such as `app:abuse`. */
	readonly keyPrefix: string
	readonly maxStrikes?: number
	readonly windowSeconds?: number
	readonly pauseSeconds?: number
	readonly timeoutMs?: number
}): AbuseStrikes {
	const maxStrikes = input.maxStrikes ?? 3
	const windowSeconds = input.windowSeconds ?? 86_400
	const pauseSeconds = input.pauseSeconds ?? 3_600
	const keysOf = (userId: string) => {
		const digest = createHmac('sha256', input.secret)
			.update(userId)
			.digest('hex')
		const prefix = `${input.keyPrefix}:{${digest}}`

		return {
			strikes: `${prefix}:strikes`,
			pause: `${prefix}:paused`,
			categories: `${prefix}:categories`
		}
	}
	const run = async (
		script: string,
		keys: string[],
		args: (string | number)[]
	) => {
		const signal = AbortSignal.timeout(input.timeoutMs ?? 3_000)

		return raceAbort(input.runScript(script, keys, args, signal), signal)
	}
	const pauseOf = (seconds: number): AbusePause =>
		seconds > 0
			? { kind: 'paused', retryAfterSeconds: seconds }
			: { kind: 'ok' }

	return {
		async check(userId) {
			try {
				return pauseOf(
					Number(await run(ABUSE_PAUSE_SCRIPT, [keysOf(userId).pause], []))
				)
			} catch (error) {
				return { kind: 'unavailable', error }
			}
		},
		async record(userId, category) {
			const keys = keysOf(userId)

			try {
				const result = (await run(
					ABUSE_STRIKE_SCRIPT,
					[keys.strikes, keys.pause, keys.categories],
					[
						windowSeconds,
						maxStrikes,
						pauseSeconds,
						category.slice(0, 40) || 'abusive'
					]
				)) as [number, number]

				return pauseOf(Number(result[1]))
			} catch (error) {
				return { kind: 'unavailable', error }
			}
		}
	}
}

/**
 * The `strikes` of `runChatTurn`'s screening over `createAbuseStrikes`: a
 * paused user is refused with `user_paused`; Redis being down lets the
 * user through, reported to `onUnavailable`.
 */
export function screeningStrikes<TScope>(
	strikes: AbuseStrikes,
	userIdOf: (scope: TScope) => string,
	options: { readonly onUnavailable?: (error: unknown) => void } = {}
): {
	check(scope: TScope): Promise<number | undefined>
	record(
		scope: TScope,
		verdict: { readonly category?: string }
	): Promise<unknown>
} {
	const secondsOf = (pause: AbusePause) => {
		if (pause.kind === 'unavailable') options.onUnavailable?.(pause.error)

		return pause.kind === 'paused' ? pause.retryAfterSeconds : undefined
	}

	return {
		check: async (scope) => secondsOf(await strikes.check(userIdOf(scope))),
		record: async (scope, verdict) =>
			secondsOf(
				await strikes.record(userIdOf(scope), verdict.category ?? 'abusive')
			)
	}
}
