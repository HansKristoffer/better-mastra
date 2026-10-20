import type { ChatErrorCode, ChatRefusal } from './types.js'

const STATUS: Readonly<Record<ChatErrorCode, number>> = {
	invalid_request: 400,
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

/** The refusal's code and HTTP status. */
export function chatRefusal(refusal: ChatRefusal): {
	readonly code: string
	readonly status: number
} {
	return typeof refusal === 'string'
		? { code: refusal, status: STATUS[refusal] }
		: refusal
}

/** A JSON response `{ error: code }` with the refusal's status and `Cache-Control: no-store`. */
export function chatErrorResponse(refusal: ChatRefusal): Response {
	const { code, status } = chatRefusal(refusal)

	return Response.json(
		{ error: code },
		{ status, headers: { 'Cache-Control': 'no-store' } }
	)
}
