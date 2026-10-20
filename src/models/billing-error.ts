import { APICallError } from 'ai'

/**
 * A provider pre-rejects a request its balance cannot cover with HTTP 402
 * (OpenRouter: "This request requires more credits, or fewer max_tokens").
 * Retrying, waiting or leaving work for the next run cannot fix it, so
 * callers treat it as a hard failure rather than a provider hiccup.
 */
export class AiBillingError extends Error {
	override readonly name = 'AiBillingError'
	constructor(
		readonly statusCode: number,
		cause: Error
	) {
		super('AI provider refused the request: account is out of credits', {
			cause
		})
	}
}

export function toAiBillingError(error: unknown) {
	if (error instanceof AiBillingError) return error
	if (APICallError.isInstance(error) && error.statusCode === 402)
		return new AiBillingError(error.statusCode, error)
	return null
}
