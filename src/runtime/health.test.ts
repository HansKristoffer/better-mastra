import { describe, expect, mock, test } from 'bun:test'
import { checkHealth } from './health'

const NOW = new Date('2026-10-19T10:00:00.000Z')

const connectionRefused = () =>
	Object.assign(new TypeError('Unable to connect to redis-token-secret'), {
		code: 'ConnectionRefused'
	})

describe('checkHealth', () => {
	test('reports every dependency up or configured when all answer and every key is set', async () => {
		const pingLock = mock(async () => {})
		const pingStorage = mock(async () => {})

		const health = await checkHealth({
			now: () => NOW,
			checks: {
				thread_lock_store: { configured: true, ping: pingLock },
				storage: { configured: true, ping: pingStorage },
				model_provider: { configured: true },
				intercom: { configured: true, required: false }
			}
		})

		expect(pingLock).toHaveBeenCalledTimes(1)
		expect(pingStorage).toHaveBeenCalledTimes(1)
		expect(health).toEqual({
			checkedAt: NOW.toISOString(),
			healthy: true,
			dependencies: [
				{ dependency: 'thread_lock_store', required: true, status: 'up' },
				{ dependency: 'storage', required: true, status: 'up' },
				{ dependency: 'model_provider', required: true, status: 'configured' },
				{ dependency: 'intercom', required: false, status: 'configured' }
			]
		})
	})

	test('names a store that refuses the connection as down, without its message', async () => {
		const health = await checkHealth({
			now: () => NOW,
			checks: {
				thread_lock_store: {
					configured: true,
					ping: async () => {
						throw connectionRefused()
					}
				}
			}
		})

		expect(health.healthy).toBe(false)
		expect(health.dependencies).toEqual([
			{
				dependency: 'thread_lock_store',
				required: true,
				status: 'down',
				detail: 'ConnectionRefused'
			}
		])
		expect(JSON.stringify(health)).not.toContain('secret')
	})

	test('reports missing keys as not configured, without pinging', async () => {
		const ping = mock(async () => {})
		const health = await checkHealth({
			now: () => NOW,
			checks: {
				storage: { configured: false, ping },
				linear: { configured: false, required: false }
			}
		})

		expect(ping).not.toHaveBeenCalled()
		expect(health.healthy).toBe(false)
		expect(health.dependencies.map((row) => row.status)).toEqual([
			'not_configured',
			'not_configured'
		])
	})
})
