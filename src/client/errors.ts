/**
 * How a failed chat request reads: a refusal of the chat route, a server
 * error, or a lost connection. The default classifier reads the route's
 * `{ error: code }` bodies; an app with its own codes passes its own.
 */

import { APICallError } from 'ai'
import { safeJsonParse } from 'hanzio'

import type { ChatErrorCode, ChatErrors } from '../protocol/index.js'
import { type ChatErrorResponse, ChatConnectionLostError } from './fetch.js'
import type { ChatRefusal } from './turn.js'

// TYPES

/** Reads a response that is not OK; undefined when it is no refusal of the chat route. */
export type ClassifyChatError = (
	response: ChatErrorResponse
) => ChatRefusal | undefined

// CONSTANTS

/** Refusals worth trying again: the cause passes (a turn ends, a limit resets, consent is given). */
const RETRYABLE_BUILT_IN_CODES: readonly ChatErrorCode[] = [
	'turn_in_progress',
	'temporarily_unavailable',
	'usage_limited',
	'consent_required'
]

/** The refusal of a request that answers an approval or suspended run the server no longer has waiting. */
const EXPIRED_BUILT_IN_CODE: ChatErrorCode = 'change_expired'

// FUNCTIONS

/**
 * Builds a chat error classifier that honours codes renamed via
 * `defineChatErrors({ rename })`, so renaming `change_expired` or a retryable
 * refusal still classifies expiry and retryability accurately on the client.
 */
export function createChatErrorClassifier(
	errors?: Pick<ChatErrors<string>, 'rename'>
): ClassifyChatError {
	const rename = errors?.rename ?? {}
	const expiredCode = rename[EXPIRED_BUILT_IN_CODE] ?? EXPIRED_BUILT_IN_CODE
	const retryable = new Set<string>(
		RETRYABLE_BUILT_IN_CODES.map((code) => rename[code] ?? code)
	)

	return ({ status, body }) => {
		const { error: code, retryAfterSeconds } = (body ?? {}) as {
			error?: unknown
			retryAfterSeconds?: unknown
		}

		if (typeof code !== 'string') {
			return undefined
		}

		const expired = code === expiredCode

		return {
			code,
			canTryAgain:
				retryable.has(code) ||
				(!expired && (status === 409 || status === 429 || status >= 500)),
			expired,
			...(typeof retryAfterSeconds === 'number' && { retryAfterSeconds })
		}
	}
}

/**
 * A `{ error: code }` body is a refusal. Try again is offered for the codes
 * above, and for an unknown code on 409, 429 or 5xx.
 */
export const classifyChatError: ClassifyChatError = createChatErrorClassifier()

/** The status and JSON body of a request the AI SDK failed on a response that was not OK. */
export function readErrorResponse(
	error: unknown
): ChatErrorResponse | undefined {
	if (!APICallError.isInstance(error) || error.statusCode === undefined) {
		return undefined
	}

	const parsed =
		error.responseBody === undefined
			? undefined
			: safeJsonParse(error.responseBody)
	const body = parsed?.ok ? parsed.data : undefined

	return { status: error.statusCode, body }
}

/** Whether a request failed on the network rather than the server. */
export function isConnectionLost(
	error: unknown,
	end: { readonly isDisconnect: boolean } | undefined
): boolean {
	return end?.isDisconnect === true || error instanceof ChatConnectionLostError
}
