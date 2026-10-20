import { describe, expect, mock, test } from 'bun:test'

import { issueSonioxTemporaryKey, SonioxKeyError } from './index.js'

describe('issueSonioxTemporaryKey', () => {
	test('should ask the EU region for a single-use transcription key that connects within a minute and lasts ten minutes', async () => {
		const fetchImpl = fakeFetch(
			201,
			JSON.stringify({
				api_key: 'temporary-key',
				expires_at: '2026-10-19T10:01:00Z'
			})
		)

		const key = await issueSonioxTemporaryKey({
			apiKey: 'account-key',
			region: 'eu',
			fetch: fetchImpl
		})

		// The account key authorizes the EU request, which names no user.
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.eu.soniox.com/v1/auth/temporary-api-key',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer account-key'
				}),
				body: JSON.stringify({
					usage_type: 'transcribe_websocket',
					expires_in_seconds: 60,
					single_use: true,
					max_session_duration_seconds: 600
				})
			})
		)
		expect(key).toEqual({
			apiKey: 'temporary-key',
			expiresAt: '2026-10-19T10:01:00Z',
			websocketUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
			model: 'stt-rt-v5'
		})
	})

	test('should default to the US hosts and pass the client reference', async () => {
		const fetchImpl = fakeFetch(
			201,
			JSON.stringify({ api_key: 'k', expires_at: '2026-10-19T10:01:00Z' })
		)

		const key = await issueSonioxTemporaryKey({
			apiKey: 'account-key',
			clientReferenceId: 'org_1',
			fetch: fetchImpl
		})

		const [url, init] = (fetchImpl as unknown as ReturnType<typeof mock>).mock
			.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.soniox.com/v1/auth/temporary-api-key')
		expect(JSON.parse(String(init.body))).toMatchObject({
			client_reference_id: 'org_1'
		})
		expect(key.websocketUrl).toBe(
			'wss://stt-rt.soniox.com/transcribe-websocket'
		)
	})

	test('should throw the status when Soniox refuses, or answers 201 without a usable key', async () => {
		await expect(
			issueSonioxTemporaryKey({
				apiKey: 'account-key',
				fetch: fakeFetch(429, JSON.stringify({ error_type: 'rate' }))
			})
		).rejects.toEqual(new SonioxKeyError(429))
		await expect(
			issueSonioxTemporaryKey({
				apiKey: 'account-key',
				fetch: fakeFetch(
					201,
					JSON.stringify({ api_key: 'temporary-key', expires_at: 'soon' })
				)
			})
		).rejects.toEqual(new SonioxKeyError(201))
	})

	test('should record usage only for an issued key, and withhold the key when recording fails', async () => {
		const issued = () =>
			fakeFetch(
				201,
				JSON.stringify({ api_key: 'k', expires_at: '2026-10-19T10:01:00Z' })
			)
		const onUsage = mock(async () => {})

		await issueSonioxTemporaryKey({
			apiKey: 'a',
			region: 'eu',
			fetch: issued(),
			onUsage
		})
		await issueSonioxTemporaryKey({
			apiKey: 'a',
			fetch: fakeFetch(500, ''),
			onUsage
		}).catch(() => {})

		expect(onUsage.mock.calls as unknown[]).toEqual([
			[
				{
					region: 'eu',
					model: 'stt-rt-v5',
					expiresAt: '2026-10-19T10:01:00Z'
				}
			]
		])
		await expect(
			issueSonioxTemporaryKey({
				apiKey: 'a',
				fetch: issued(),
				onUsage: async () => {
					throw new Error('database down')
				}
			})
		).rejects.toThrow('database down')
	})
})

function fakeFetch(status: number, body: string) {
	return mock(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(body, { status })
	) as unknown as typeof fetch
}
