/**
 * Per-user request windows in Redis: charges one request against every
 * window of a user's operation at once, without running the work, so a
 * streamed chat turn, an import or a one-shot model call can share a quota.
 */

import { createHmac } from 'node:crypto'

/** One counting window: at most `limit` requests in `seconds`. */
export interface UserRequestWindow {
	/** The key suffix, such as `minute` or `day`. */
	readonly name: string
	readonly seconds: number
	readonly limit: number
}

/** Runs a Lua script, as `EVAL script keys args`. */
export type RunRedisScript = (
	script: string,
	keys: readonly string[],
	args: readonly (string | number)[],
	signal: AbortSignal
) => Promise<unknown>

export type UserRequestAdmission =
	| { readonly kind: 'admitted' }
	/** Refused until the fullest window has room again. */
	| { readonly kind: 'limited'; readonly retryAfterSeconds: number }
	/** Redis failed or did not answer in time; the caller decides what the user sees. */
	| { readonly kind: 'unavailable'; readonly error: unknown }

// Check every window, then charge them all. ARGV holds each window's limit and
// seconds in KEYS order. A refusal returns minus the seconds until the fullest
// full window expires and extends no window. A charged request stays charged
// when the work fails, because a failed provider call may still cost money.
export const USER_REQUEST_ADMISSION_SCRIPT = `
local retryAfter = 0
for index, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[index * 2 - 1]) then
    retryAfter = math.max(retryAfter, 1, redis.call('TTL', key))
  end
end
if retryAfter > 0 then return -retryAfter end
for index, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then redis.call('EXPIRE', key, ARGV[index * 2]) end
end
return 1
`

/**
 * Charges one request of `userId` against every window of `operation`, or
 * refuses it. No user id reaches Redis: the keys carry an HMAC of it under
 * `secret`, in one hash slot per user. Each operation counts on its own.
 */
export async function admitUserRequest(input: {
	readonly runScript: RunRedisScript
	/** Signs the user id in the keys; changing it starts every count from zero. */
	readonly secret: string
	/** Such as `app:ai-usage`. A new prefix starts the counts from zero. */
	readonly keyPrefix: string
	/** Such as `receipt` or `assistant`. */
	readonly operation: string
	readonly userId: string
	readonly windows: readonly UserRequestWindow[]
	/** Default 3 seconds. */
	readonly timeoutMs?: number
}): Promise<UserRequestAdmission> {
	const digest = createHmac('sha256', input.secret)
		.update(input.userId)
		.digest('hex')
	const prefix = `${input.keyPrefix}:{${digest}}:${input.operation}`

	const signal = AbortSignal.timeout(input.timeoutMs ?? 3_000)

	try {
		// The deadline holds even for a client that ignores the signal.
		const result = await Promise.race([
			input.runScript(
				USER_REQUEST_ADMISSION_SCRIPT,
				input.windows.map((window) => `${prefix}:${window.name}`),
				input.windows.flatMap((window) => [window.limit, window.seconds]),
				signal
			),
			new Promise<never>((_, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true
				})
			)
		])

		return result === 1
			? { kind: 'admitted' }
			: { kind: 'limited', retryAfterSeconds: Math.max(0, -Number(result)) }
	} catch (error) {
		return { kind: 'unavailable', error }
	}
}
