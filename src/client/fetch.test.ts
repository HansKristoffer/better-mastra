import { describe, expect, mock, test } from 'bun:test'

import {
	ChatConnectionLostError,
	createChatFetch,
	isTransientNetworkError
} from './fetch'

const delay = async () => {}

describe('createChatFetch', () => {
	test('retries a request the network dropped once, then fails as a lost connection', async () => {
		const fetch = mock(async () => {
			throw new TypeError('Network request failed')
		})
		const chatFetch = createChatFetch({ fetch, delay })

		await expect(chatFetch('https://api.test/chat')).rejects.toBeInstanceOf(
			ChatConnectionLostError
		)
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	test('does not retry an error that is not the network, nor an abort', async () => {
		const failing = mock(async () => {
			throw new Error('Invalid URL')
		})
		const aborted = mock(async () => {
			const error = new Error('aborted')
			error.name = 'AbortError'
			throw error
		})

		await expect(
			createChatFetch({ fetch: failing, delay })('x')
		).rejects.toBeInstanceOf(ChatConnectionLostError)
		await expect(
			createChatFetch({ fetch: aborted, delay })('x')
		).rejects.toThrow('aborted')
		expect(failing).toHaveBeenCalledTimes(1)
		expect(aborted).toHaveBeenCalledTimes(1)
	})

	test('ends the request on Stop during the retry wait', async () => {
		const controller = new AbortController()
		const fetch = mock(async () => {
			throw new TypeError('Network request failed')
		})
		const chatFetch = createChatFetch({
			fetch,
			delay: async () => controller.abort()
		})

		await expect(chatFetch('x', { signal: controller.signal })).rejects.toThrow(
			'aborted'
		)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	test('retries a draining server once and reports any other response that is not OK', async () => {
		const responses = [
			Response.json({ status: 'draining' }, { status: 503 }),
			Response.json({ error: 'unauthenticated' }, { status: 401 })
		]
		const onErrorResponse = mock(() => {})
		const onUnauthorized = mock(() => {})
		const chatFetch = createChatFetch({
			fetch: async () => responses.shift() as Response,
			delay,
			onErrorResponse,
			onUnauthorized
		})

		const response = await chatFetch('x')

		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: 'unauthenticated' })
		expect(onErrorResponse).toHaveBeenCalledWith({
			status: 401,
			body: { error: 'unauthenticated' }
		})
		expect(onUnauthorized).toHaveBeenCalledTimes(1)
	})

	test('adds the headers it reads per request as a plain record', async () => {
		const fetch = mock(
			async (_input: unknown, _init?: RequestInit) => new Response('ok')
		)
		const chatFetch = createChatFetch({
			fetch,
			headers: () => ({ Cookie: 'session=1' })
		})

		await chatFetch('x', { headers: { 'content-type': 'application/json' } })

		expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
			'content-type': 'application/json',
			cookie: 'session=1'
		})
	})

	test('fails a body that stops arriving as a lost connection', async () => {
		const chatFetch = createChatFetch({
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull: (controller) => controller.error(new Error('socket hang up'))
					})
				)
		})
		const response = await chatFetch('x')

		expect(response.ok).toBe(true)
		await expect(response.body?.getReader().read()).rejects.toBeInstanceOf(
			ChatConnectionLostError
		)
	})
})

describe('isTransientNetworkError', () => {
	test.each([
		[new TypeError('Failed to fetch'), true],
		[new Error('The Internet connection appears to be offline.'), true],
		[new Error('Unable to resolve host "api.test"'), true],
		[new Error('Invalid JSON'), false],
		['network', false]
	])('%p → %p', (error, expected) => {
		expect(isTransientNetworkError(error)).toBe(expected)
	})
})
