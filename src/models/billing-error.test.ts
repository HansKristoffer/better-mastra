import { describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'
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
