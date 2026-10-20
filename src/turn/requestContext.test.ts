import { describe, expect, test } from 'bun:test'
import {
	MASTRA_RESOURCE_ID_KEY,
	MASTRA_THREAD_ID_KEY,
	RequestContext
} from '@mastra/core/request-context'
import { z } from 'zod'

import {
	defineRequestContext,
	defineRequestContextHolder
} from './requestContext.js'

const caller = defineRequestContextHolder<{ secret: string }>('caller')

describe('defineRequestContextHolder', () => {
	test('should hand the tools the value while keeping it out of every serialized form', () => {
		// Given a run's request context with a caller holding a session token
		const requestContext = new RequestContext()
		requestContext.set('userId', 'user-1')
		const value = { secret: 'session-token' }
		caller.set(requestContext, value)

		// When reading the caller and serializing the context for storage and spans
		const stored = JSON.stringify(requestContext)
		const span = JSON.stringify(requestContext.serializeForSpan())

		// Then the tools get the caller, and nothing of it is stored or traced
		expect(caller.get(requestContext)).toBe(value)
		expect(JSON.parse(stored)).toEqual({ userId: 'user-1' })
		expect(span).not.toContain('session-token')
	})

	test('should fail when the turn set no value', () => {
		expect(() => caller.get(new RequestContext())).toThrow(
			'No caller is set on this request context.'
		)
	})
})

describe('defineRequestContext', () => {
	test('should parse the values and pin the run to its thread', () => {
		const context = defineRequestContext(
			z.object({ userId: z.string(), locale: z.enum(['da', 'en']) })
		)

		const requestContext = context.create(
			{ userId: 'user-1', locale: 'da' },
			{ threadId: 'thread-1', resourceId: 'resource-1' }
		)

		expect(context.read(requestContext)).toEqual({
			userId: 'user-1',
			locale: 'da'
		})
		expect(requestContext.get(MASTRA_THREAD_ID_KEY as never)).toBe('thread-1')
		expect(requestContext.get(MASTRA_RESOURCE_ID_KEY as never)).toBe(
			'resource-1'
		)
	})
})
