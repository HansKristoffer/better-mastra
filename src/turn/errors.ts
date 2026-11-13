import { chatErrorStatuses } from '../protocol/index.js'
import type { ChatRefusal } from './types.js'

/** The refusal's code and HTTP status, and when to try again if it says. */
export function chatRefusal(refusal: ChatRefusal): {
	readonly code: string
	readonly status: number
	readonly retryAfterSeconds?: number
} {
	return typeof refusal === 'string'
		? { code: refusal, status: chatErrorStatuses[refusal] }
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
