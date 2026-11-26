/**
 * Spend per user per period in Redis: each turn's cost in USD is added to
 * every window of the user, and a new request is refused while any window
 * has reached its limit. Like `admitUserRequest`, the keys hold an HMAC of
 * the user id, never the id itself.
 */

import { createHmac } from 'node:crypto'
import { raceAbort } from 'hanzio'

import type { RunRedisScript, UserRequestAdmission } from './userRequests.js'

/** One spending window: at most `limitUsd` in `seconds`. */
export interface SpendWindow {
	/** The key suffix, such as `day` or `month`. */
	readonly name: string
	readonly seconds: number
	readonly limitUsd: number
}

// KEYS: one counter per window. ARGV: each window's limit (micro-USD).
// Returns minus the seconds until the fullest full window expires, or 1.
export const SPEND_ADMISSION_SCRIPT = `
local retryAfter = 0
for index, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[index]) then
    retryAfter = math.max(retryAfter, 1, redis.call('TTL', key))
  end
end
if retryAfter > 0 then return -retryAfter end
return 1
`

// KEYS: one counter per window. ARGV: the amount (micro-USD), then each window's seconds.
export const SPEND_RECORD_SCRIPT = `
for index, key in ipairs(KEYS) do
  if redis.call('INCRBY', key, ARGV[1]) == tonumber(ARGV[1]) then
    redis.call('EXPIRE', key, ARGV[index + 1])
  end
end
return 1
`

export interface SpendLimit {
	/** Admits the request while every window is under its limit; the answer `admissionRefusal` takes. */
	admit(userId: string): Promise<UserRequestAdmission>
	/** Adds what a turn cost. A spend of zero, negative or null adds nothing. */
	record(userId: string, usd: number | null | undefined): Promise<void>
}

/**
 * A spending cap per user and period, for the turn's `admit` and
 * `sinks.usage`. Amounts are kept as whole micro-dollars, so counters stay
 * exact. The turn that crosses a limit finishes; the next one is refused.
 *
 * ```ts
 * const spend = createSpendLimit({ runScript, secret, keyPrefix: 'app:spend',
 *   windows: [{ name: 'day', seconds: 86_400, limitUsd: 2 }, { name: 'month', seconds: 2_592_000, limitUsd: 20 }] })
 *
 * admit: async (scope) => admissionRefusal(await spend.admit(scope.userId), { whenUnavailable: 'admit' }),
 * sinks: { usage: async (event) => spend.record(event.scope.userId, (await llms.cost({ modelId: event.modelId, steps: event.steps, usage: readStreamTextUsage(event.totalUsage) })).usd) }
 * ```
 */
export function createSpendLimit(input: {
	readonly runScript: RunRedisScript
	readonly secret: string
	readonly keyPrefix: string
	readonly windows: readonly SpendWindow[]
	/** Default 3 seconds. */
	readonly timeoutMs?: number
}): SpendLimit {
	const keysOf = (userId: string) => {
		const digest = createHmac('sha256', input.secret)
			.update(userId)
			.digest('hex')

		return input.windows.map(
			(window) => `${input.keyPrefix}:{${digest}}:${window.name}`
		)
	}
	const run = (script: string, keys: string[], args: (string | number)[]) => {
		const signal = AbortSignal.timeout(input.timeoutMs ?? 3_000)

		return raceAbort(input.runScript(script, keys, args, signal), signal)
	}

	return {
		async admit(userId) {
			try {
				const result = await run(
					SPEND_ADMISSION_SCRIPT,
					keysOf(userId),
					input.windows.map((window) => toMicroUsd(window.limitUsd))
				)

				return result === 1
					? { kind: 'admitted' }
					: { kind: 'limited', retryAfterSeconds: Math.max(0, -Number(result)) }
			} catch (error) {
				return { kind: 'unavailable', error }
			}
		},
		async record(userId, usd) {
			const micro = toMicroUsd(usd ?? 0)

			if (micro <= 0) return

			await run(SPEND_RECORD_SCRIPT, keysOf(userId), [
				micro,
				...input.windows.map((window) => window.seconds)
			])
		}
	}
}

function toMicroUsd(usd: number): number {
	return Math.round(usd * 1_000_000)
}
