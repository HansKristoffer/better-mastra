import { describe, expect, test } from 'bun:test'

import { bunRedis } from './redis'

/** A connection that records what it was asked, answering every command with null. */
function fakeConnection(name: string, log: string[]) {
	return {
		send: async (command: string, args: string[]) => {
			log.push(`${name}: ${command} ${args.join(' ')}`)
			return null
		},
		subscribe: async (channel: string) => {
			log.push(`${name}: SUBSCRIBE ${channel}`)
		},
		close: () => {
			log.push(`${name}: close`)
		}
	}
}

describe('bunRedis with a connect of its own', () => {
	test('sends commands on the client and opens a connection per subscriber and reader', async () => {
		// Given a command client that cannot duplicate itself, and a connect
		const log: string[] = []
		let opened = 0
		const redis = bunRedis(fakeConnection('commands', log), {
			connect: async () => fakeConnection(`connection ${++opened}`, log)
		})

		// When resumable streams use it
		await redis.set('locator', 'owner', 1_000)
		const unsubscribe = await redis.subscribe('control', () => {})
		const reader = await redis.reader()
		await reader.xread('spill', '0', 50)
		await unsubscribe()
		reader.close()

		// Then commands go to the client, the rest to new connections
		expect(log).toEqual([
			'commands: SET locator owner PX 1000 GET',
			'connection 1: SUBSCRIBE control',
			'connection 2: XREAD BLOCK 50 STREAMS spill 0',
			'connection 1: close',
			'connection 2: close'
		])
	})
})
