import { describe, expect, test } from 'bun:test'
import { APICallError, RetryError } from 'ai'
import { AiBillingError, toAiBillingError } from './billing-error'

function apiError(statusCode: number) {
	return new APICallError({
		message: 'This request requires more credits, or fewer max_tokens.',
		url: 'https://openrouter.ai/api/v1/chat/completions',
		requestBodyValues: {},
		statusCode
	})
}

describe('toAiBillingError', () => {
	test('maps a 402 API call error to a billing error', () => {
		const billing = toAiBillingError(apiError(402))
		expect(billing).toBeInstanceOf(AiBillingError)
		expect(billing?.statusCode).toBe(402)
		expect(billing?.cause).toBeInstanceOf(APICallError)
	})

	test('finds the 402 behind the retries the AI SDK made first', () => {
		// Given a call that failed on a 503 and then on a 402, as the SDK reports it
		const retried = new RetryError({
			message: 'Failed after 2 attempts.',
			reason: 'errorNotRetryable',
			errors: [apiError(503), apiError(402)]
		})

		// Then it is still a billing failure
		expect(toAiBillingError(retried)?.statusCode).toBe(402)
	})

	test('leaves every other failure alone', () => {
		expect(toAiBillingError(apiError(429))).toBeNull()
		expect(toAiBillingError(apiError(500))).toBeNull()
		expect(toAiBillingError(new Error('boom'))).toBeNull()
		expect(toAiBillingError(undefined)).toBeNull()
	})

	test('passes a billing error through unchanged', () => {
		const billing = new AiBillingError(402, apiError(402))
		expect(toAiBillingError(billing)).toBe(billing)
	})
})
