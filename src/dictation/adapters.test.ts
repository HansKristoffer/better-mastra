import { describe, expect, test } from 'bun:test'

import { appStateLifecycle, webSocketFactory } from './adapters.js'

class FakeSocket extends EventTarget {
	static latest: FakeSocket
	readyState = 0
	sent: unknown[] = []
	readonly args: unknown[]

	constructor(...args: unknown[]) {
		super()
		this.args = args
		FakeSocket.latest = this
	}

	send(data: unknown) {
		this.sent.push(data)
	}

	close() {
		this.readyState = 3
		this.dispatchEvent(new Event('close'))
	}

	open() {
		this.readyState = 1
		this.dispatchEvent(new Event('open'))
	}
}

function open(headers: boolean) {
	const messages: string[] = []
	let closes = 0
	const socket = webSocketFactory({ headers, WebSocket: FakeSocket }).open(
		'wss://soniox.test',
		headers ? { Authorization: 'Bearer key' } : {},
		{
			onMessage: (message) => messages.push(message),
			onClose: () => closes++
		}
	)

	return { socket, fake: FakeSocket.latest, messages, closes: () => closes }
}

describe('webSocketFactory', () => {
	test('should pass headers the React Native way, and only the URL in the browser', () => {
		expect(open(true).fake.args).toEqual([
			'wss://soniox.test',
			null,
			{ headers: { Authorization: 'Bearer key' } }
		])
		expect(open(false).fake.args).toEqual(['wss://soniox.test'])
	})

	test('should hold frames until the socket is open, then send them in order', () => {
		const { socket, fake } = open(true)

		socket.send('start')
		socket.send(new ArrayBuffer(2))
		expect(fake.sent).toEqual([])

		fake.open()
		socket.send('more')

		expect(fake.sent).toEqual(['start', expect.any(ArrayBuffer), 'more'])
	})

	test('should report an error and the close after it as one close', () => {
		const { fake, messages, closes } = open(false)

		fake.dispatchEvent(new MessageEvent('message', { data: '{"tokens":[]}' }))
		fake.dispatchEvent(new Event('error'))
		fake.dispatchEvent(new Event('close'))

		expect(messages).toEqual(['{"tokens":[]}'])
		expect(closes()).toBe(1)
	})
})

describe('appStateLifecycle', () => {
	test('should report the background and nothing else', () => {
		let listener: (state: string) => void = () => {}
		let removed = false
		const appState = {
			currentState: 'active',
			addEventListener: (_type: 'change', next: (state: string) => void) => {
				listener = next
				return { remove: () => (removed = true) }
			}
		}
		const lifecycle = appStateLifecycle(appState)
		let backgrounds = 0
		const off = lifecycle.onBackground(() => backgrounds++)

		listener('inactive')
		listener('background')
		off()

		expect(backgrounds).toBe(1)
		expect(removed).toBe(true)
		expect(lifecycle.isBackground()).toBe(false)
	})
})
