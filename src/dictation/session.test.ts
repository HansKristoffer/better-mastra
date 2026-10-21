import { afterEach, describe, expect, jest, mock, test } from 'bun:test'

import type { DictationTranscript } from './protocol.js'
import {
	DICTATION_FINISH_TIMEOUT_MS,
	type DictationAudio,
	type DictationEnd,
	type DictationFrame,
	type DictationSocketFactory,
	startDictation
} from './session.js'

const KEY = {
	apiKey: 'temporary-key',
	expiresAt: '2099-01-01T00:00:00Z',
	websocketUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
	model: 'stt-rt-v5'
}

const SAMPLES = new Float32Array([0, 0.5, -0.5])

afterEach(() => {
	jest.useRealTimers()
})

describe('startDictation', () => {
	test('should ask for the key while the permission prompt is open, and connect nothing when the microphone is not allowed', async () => {
		const fake = createFakes({ permission: false })

		const start = await startDictation(fake.options)

		expect(start).toEqual({ kind: 'permission_denied' })
		expect(fake.options.requestKey).toHaveBeenCalledTimes(1)
		expect(fake.socketFactory.open).not.toHaveBeenCalled()
	})

	test('should say there is no microphone when the device has none', async () => {
		const fake = createFakes()
		fake.microphone.requestPermission.mockImplementation(async () => {
			throw Object.assign(new Error('Requested device not found'), {
				name: 'NotFoundError'
			})
		})

		expect(await startDictation(fake.options)).toEqual({
			kind: 'no_microphone'
		})
		expect(fake.socketFactory.open).not.toHaveBeenCalled()
	})

	test('should ask for a new key when the permission prompt outlasted the first one', async () => {
		const fake = createFakes()
		const fresh = { ...KEY, apiKey: 'fresh-key' }
		fake.options.requestKey
			.mockImplementationOnce(async () => ({
				...KEY,
				expiresAt: '2000-01-01T00:00:00Z'
			}))
			.mockImplementationOnce(async () => fresh)

		await startedSession(fake)

		expect(fake.options.requestKey).toHaveBeenCalledTimes(2)
		expect(fake.socketFactory.open).toHaveBeenCalledWith(
			fresh.websocketUrl,
			{ Authorization: 'Bearer fresh-key' },
			expect.anything()
		)
	})

	test('should report dictation as unavailable and release the microphone when the API gives no key', async () => {
		const fake = createFakes({ key: new Error('SERVICE_UNAVAILABLE') })

		const start = await startDictation(fake.options)

		expect(start).toEqual({ kind: 'unavailable' })
		expect(fake.socketFactory.open).not.toHaveBeenCalled()
		expect(fake.microphone.stop).toHaveBeenCalled()
	})

	test('should send the key as a header, describe the audio before the first buffer and keep the key out of every frame', async () => {
		const fake = createFakes()
		await startDictation(fake.options)

		fake.microphone.deliver(SAMPLES, 48_000)
		fake.microphone.deliver(SAMPLES, 48_000)

		expect(fake.socketFactory.open).toHaveBeenCalledWith(
			KEY.websocketUrl,
			{ Authorization: `Bearer ${KEY.apiKey}` },
			expect.anything()
		)
		expect(fake.socket.frames).toEqual([
			expect.stringContaining('"sample_rate":48000'),
			expect.any(ArrayBuffer),
			expect.any(ArrayBuffer)
		])
		expect(JSON.parse(String(fake.socket.frames[0]))).toMatchObject({
			language_hints: ['da', 'en']
		})
		expect(JSON.stringify(fake.socket.frames)).not.toContain(KEY.apiKey)
	})

	test('should put the key in the start request and send encoded audio as-is when the socket sends no headers', async () => {
		const fake = createFakes({ sendsHeaders: false })
		await startDictation(fake.options)
		const blob = new Blob(['webm'])

		fake.microphone.deliverEncoded(blob)

		expect(fake.socketFactory.open).toHaveBeenCalledWith(
			KEY.websocketUrl,
			{},
			expect.anything()
		)
		expect(JSON.parse(String(fake.socket.frames[0]))).toMatchObject({
			api_key: KEY.apiKey,
			audio_format: 'auto'
		})
		expect(fake.socket.frames[1]).toBe(blob)
	})

	test('should end the stream when stopped and resolve with the final text, releasing everything', async () => {
		const fake = createFakes()
		const session = await startedSession(fake)
		fake.microphone.deliver(SAMPLES, 16_000)
		fake.socket.receive({ tokens: [{ text: 'Hvad har jeg', is_final: true }] })

		const stopping = session.stop()
		await flushPromises()
		fake.socket.receive({
			tokens: [{ text: ' brugt?', is_final: true }],
			finished: true
		})
		const text = await stopping

		// The microphone's last buffer went out before the empty frame that ends the stream.
		expect(fake.socket.frames.slice(-2)).toEqual([expect.any(ArrayBuffer), ''])
		expect(text).toBe('Hvad har jeg brugt?')
		expect(fake.ends).toEqual([
			{ kind: 'stopped', text: 'Hvad har jeg brugt?' }
		])
		expect(fake.transcripts.at(-1)).toEqual({
			finalText: 'Hvad har jeg brugt?',
			interimText: ''
		})
		await expectReleased(fake)
	})

	test('should close quietly instead of asking Soniox when stopped before any audio', async () => {
		const fake = createFakes({ lastBuffer: false })
		const session = await startedSession(fake)

		expect(await session.stop()).toBe('')

		expect(fake.socket.frames).toEqual([])
		expect(fake.ends).toEqual([{ kind: 'stopped', text: '' }])
		await expectReleased(fake)
	})

	test('should keep the unfinished words when Soniox does not finish in time', async () => {
		jest.useFakeTimers()
		const fake = createFakes()
		const session = await startedSession(fake)
		fake.microphone.deliver(SAMPLES, 16_000)
		fake.socket.receive({
			tokens: [
				{ text: 'Hvad har jeg', is_final: true },
				{ text: ' brugt', is_final: false }
			]
		})

		const stopping = session.stop()
		await flushPromises()
		jest.advanceTimersByTime(DICTATION_FINISH_TIMEOUT_MS)

		expect(await stopping).toBe('Hvad har jeg brugt')
		await expectReleased(fake)
	})

	test('should end as failed with the text so far when the connection closes mid-way', async () => {
		const fake = createFakes()
		await startedSession(fake)
		fake.microphone.deliver(SAMPLES, 16_000)
		fake.socket.receive({ tokens: [{ text: 'Hvad har', is_final: true }] })

		fake.socket.serverClose()
		await flushPromises()

		expect(fake.ends).toEqual([{ kind: 'failed', text: 'Hvad har' }])
		await expectReleased(fake)
	})

	test('should end as failed with the text so far when Soniox reports an error', async () => {
		const fake = createFakes()
		await startedSession(fake)
		fake.microphone.deliver(SAMPLES, 16_000)
		fake.socket.receive({ tokens: [{ text: 'Hvad', is_final: true }] })

		fake.socket.receive({ error_code: 503, error_type: 'service_unavailable' })
		await flushPromises()

		expect(fake.ends).toEqual([{ kind: 'failed', text: 'Hvad' }])
		await expectReleased(fake)
	})

	test('should report dictation as unavailable and release everything when the microphone cannot start', async () => {
		const fake = createFakes({ microphoneStarts: false })

		const start = await startDictation(fake.options)

		expect(start).toEqual({ kind: 'unavailable' })
		expect(fake.ends).toEqual([])
		await expectReleased(fake)
	})

	test('should stop when the app goes to the background, and at once when it already left during the start', async () => {
		const fake = createFakes()
		await startedSession(fake)
		fake.microphone.deliver(SAMPLES, 16_000)

		fake.lifecycle.goToBackground()
		await flushPromises()

		expect(fake.socket.frames.at(-1)).toBe('')

		const away = createFakes({ background: true, lastBuffer: false })
		await startedSession(away)
		await flushPromises()

		expect(away.ends).toEqual([{ kind: 'stopped', text: '' }])
	})

	test('should cancel when the signal aborts, before or after the start', async () => {
		const before = new AbortController()
		before.abort()
		const early = createFakes({ signal: before.signal })

		expect(await startDictation(early.options)).toEqual({ kind: 'cancelled' })
		expect(early.options.requestKey).not.toHaveBeenCalled()

		const after = new AbortController()
		const late = createFakes({ signal: after.signal })
		await startedSession(late)
		late.microphone.deliver(SAMPLES, 16_000)
		late.socket.receive({ tokens: [{ text: 'Hej', is_final: false }] })

		after.abort()
		await flushPromises()

		expect(late.ends).toEqual([{ kind: 'cancelled', text: 'Hej' }])
		await expectReleased(late)
	})
})

function createFakes(
	options: {
		readonly permission?: boolean
		readonly key?: typeof KEY | Error
		readonly microphoneStarts?: boolean
		readonly lastBuffer?: boolean
		readonly sendsHeaders?: boolean
		readonly background?: boolean
		readonly signal?: AbortSignal
	} = {}
) {
	const transcripts: DictationTranscript[] = []
	const ends: DictationEnd[] = []
	const microphone = createFakeMicrophone(options)
	const socket = createFakeSocket()
	const lifecycle = createFakeLifecycle(options.background ?? false)
	const key = options.key ?? KEY
	const socketFactory = {
		sendsHeaders: options.sendsHeaders ?? true,
		open: mock(
			(
				_url: string,
				_headers: Readonly<Record<string, string>>,
				handlers: Parameters<DictationSocketFactory['open']>[2]
			) => socket.open(handlers)
		)
	}

	return {
		options: {
			locale: 'da',
			requestKey: mock(async () => {
				if (key instanceof Error) {
					throw key
				}

				return key
			}),
			microphone,
			socket: socketFactory,
			lifecycle,
			...(options.signal ? { signal: options.signal } : {}),
			onTranscript: (transcript: DictationTranscript) =>
				transcripts.push(transcript),
			onEnd: (end: DictationEnd) => ends.push(end)
		},
		microphone,
		socket,
		socketFactory,
		lifecycle,
		transcripts,
		ends
	}
}

async function startedSession(fake: ReturnType<typeof createFakes>) {
	const start = await startDictation(fake.options)

	if (start.kind !== 'started') {
		throw new Error(`The dictation did not start: ${start.kind}`)
	}

	return start.session
}

async function expectReleased(fake: ReturnType<typeof createFakes>) {
	await flushPromises()

	expect(fake.microphone.stop).toHaveBeenCalled()
	expect(fake.socket.closed).toBe(true)
}

function createFakeMicrophone(options: {
	readonly permission?: boolean
	readonly microphoneStarts?: boolean
	readonly lastBuffer?: boolean
}) {
	let onAudio: (audio: DictationAudio) => void = () => {}

	return {
		requestPermission: mock(async () => options.permission ?? true),
		start: mock(async (callback: (audio: DictationAudio) => void) => {
			onAudio = callback

			return options.microphoneStarts ?? true
		}),
		// Like the real recorder, stopping hands over the last partial buffer.
		stop: mock(async () => {
			if (options.lastBuffer ?? true) {
				onAudio({ kind: 'pcm', samples: SAMPLES, sampleRate: 16_000 })
			}
			onAudio = () => {}
		}),
		deliver(samples: Float32Array, sampleRate: number) {
			onAudio({ kind: 'pcm', samples, sampleRate })
		},
		deliverEncoded(data: Blob) {
			onAudio({ kind: 'encoded', data })
		}
	}
}

function createFakeSocket() {
	const frames: DictationFrame[] = []
	let handlers: Parameters<DictationSocketFactory['open']>[2] | undefined
	const fake = {
		frames,
		closed: false,
		open(next: NonNullable<typeof handlers>) {
			handlers = next

			return {
				send: (frame: DictationFrame) => frames.push(frame),
				close: () => {
					fake.closed = true
				}
			}
		},
		receive(message: object) {
			handlers?.onMessage(JSON.stringify(message))
		},
		serverClose() {
			fake.closed = true
			handlers?.onClose()
		}
	}

	return fake
}

function createFakeLifecycle(background: boolean) {
	const listeners = new Set<() => void>()

	return {
		isBackground: () => background,
		onBackground(listener: () => void) {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		goToBackground() {
			for (const listener of listeners) {
				listener()
			}
		}
	}
}

async function flushPromises() {
	for (let round = 0; round < 5; round++) {
		await Promise.resolve()
	}
}
