/**
 * How a failed chat request reads: a refusal of the chat route, a server
 * error, or a lost connection. The default classifier reads the route's
 * `{ error: code }` bodies; an app with its own codes passes its own.
 */

import { APICallError } from 'ai'

import { type ChatErrorResponse, ChatConnectionLostError } from './fetch.js'
import type { ChatRefusal } from './turn.js'

// TYPES

/** Reads a response that is not OK; undefined when it is no refusal of the chat route. */
export type ClassifyChatError = (
	response: ChatErrorResponse
) => ChatRefusal | undefined

// CONSTANTS

/** Refusals worth trying again: the cause passes (a turn ends, a limit resets, consent is given). */
const RETRYABLE_CODES = new Set([
	'turn_in_progress',
	'temporarily_unavailable',
	'usage_limited',
	'consent_required'
])

/** The refusal of a request that answers an approval or suspended run the server no longer has waiting. */
const EXPIRED_CODE = 'change_expired'

// FUNCTIONS

/**
 * A `{ error: code }` body is a refusal. Try again is offered for the codes
 * above, and for an unknown code on 409, 429 or 5xx.
 */
export const classifyChatError: ClassifyChatError = ({ status, body }) => {
	const code = (body as { error?: unknown } | null | undefined)?.error

	if (typeof code !== 'string') {
		return undefined
	}

	return {
		code,
		canTryAgain:
			RETRYABLE_CODES.has(code) ||
			(code !== EXPIRED_CODE &&
				(status === 409 || status === 429 || status >= 500)),
		expired: code === EXPIRED_CODE
	}
}

/** The status and JSON body of a request the AI SDK failed on a response that was not OK. */
export function readErrorResponse(
	error: unknown
): ChatErrorResponse | undefined {
	if (!APICallError.isInstance(error) || error.statusCode === undefined) {
		return undefined
	}

	let body: unknown

	try {
		body =
			error.responseBody === undefined
				? undefined
				: JSON.parse(error.responseBody)
	} catch {
		body = undefined
	}

	return { status: error.statusCode, body }
}

/** Whether a request failed on the network rather than the server. */
export function isConnectionLost(
	error: unknown,
	end: { readonly isDisconnect: boolean } | undefined
): boolean {
	return end?.isDisconnect === true || error instanceof ChatConnectionLostError
}
