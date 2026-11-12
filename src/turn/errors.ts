import type { ChatErrorCode, ChatRefusal } from './types.js'

const STATUS: Readonly<Record<ChatErrorCode, number>> = {
	invalid_request: 400,
	message_too_long: 413,
	unauthenticated: 401,
	forbidden: 403,
	unavailable: 403,
	consent_required: 403,
	not_found: 404,
	turn_in_progress: 409,
	change_expired: 409,
	usage_limited: 429,
	temporarily_unavailable: 503
}

/** The refusal's code and HTTP status, and when to try again if it says. */
export function chatRefusal(refusal: ChatRefusal): {
	readonly code: string
	readonly status: number
	readonly retryAfterSeconds?: number
} {
	return typeof refusal === 'string'
		? { code: refusal, status: STATUS[refusal] }
		: refusal
}

/**
 * A JSON response `{ error: code }` with the refusal's status and
 * `Cache-Control: no-store`; with `retryAfterSeconds`, also `Retry-After` and
 * the body's `retryAfterSeconds`.
 */
export function chatErrorResponse(refusal: ChatRefusal): Response {
	const { code, status, retryAfterSeconds } = chatRefusal(refusal)
	const retryAfter =
		retryAfterSeconds === undefined
			? undefined
			: Math.max(0, Math.ceil(retryAfterSeconds))

	return Response.json(
		{
			error: code,
			...(retryAfter !== undefined && { retryAfterSeconds: retryAfter })
		},
		{
			status,
			headers: {
				'Cache-Control': 'no-store',
				...(retryAfter !== undefined && { 'Retry-After': String(retryAfter) })
			}
		}
	)
}
