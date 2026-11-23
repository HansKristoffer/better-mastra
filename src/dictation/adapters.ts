/**
 * The platform side of a dictation: the WebSocket, the phone's microphone
 * through `react-native-audio-api`, the browser's through `MediaRecorder`, and
 * React Native's app state. Each is typed by the few members it uses, so no
 * platform library is imported.
 */

import { isOneOf } from 'hanzio'

import type {
	DictationFrame,
	DictationLifecycle,
	DictationMicrophone,
	DictationSocketFactory
} from './session.js'

interface WebSocketLike {
	readonly readyState: number
	send(frame: DictationFrame): void
	close(): void
	addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void
	addEventListener(
		type: 'message',
		listener: (event: { readonly data: unknown }) => void
	): void
}

type WebSocketConstructor = new (url: string, ...rest: never[]) => WebSocketLike

/** The structural slice of `react-native-audio-api` the microphone uses. */
export interface AudioApiModule {
	readonly AudioManager: {
		requestRecordingPermissions(): Promise<string>
		setAudioSessionOptions(options: {
			iosCategory: 'record'
			iosMode: 'default'
			iosOptions: []
			iosNotifyOthersOnDeactivation: boolean
		}): void
		setAudioSessionActivity(active: boolean): Promise<unknown>
	}
	readonly AudioRecorder: new () => AudioApiRecorder
}

interface AudioApiRecorder {
	onAudioReady(
		options: { sampleRate: number; bufferLength: number; channelCount: number },
		callback: (event: {
			buffer: {
				readonly sampleRate: number
				getChannelData(channel: number): Float32Array
			}
		}) => void
	): unknown
	clearOnAudioReady(): void
	start(): Promise<{ readonly status: string }>
	stop(): Promise<unknown>
	isRecording(): boolean
}

/** The structural slice of React Native's `AppState`. */
export interface AppStateLike {
	readonly currentState: string
	addEventListener(
		type: 'change',
		listener: (state: string) => void
	): { remove(): void }
}

interface MediaRecorderLike {
	readonly state: string
	start(timeslice: number): void
	stop(): void
	addEventListener(
		type: 'dataavailable',
		listener: (event: { readonly data: Blob }) => void
	): void
	addEventListener(
		type: 'stop' | 'error',
		listener: () => void,
		options?: { once: true }
	): void
}

interface MediaStreamLike {
	getTracks(): { stop(): void }[]
}

interface BrowserAudio {
	readonly navigator: {
		readonly mediaDevices: {
			getUserMedia(constraints: { audio: object }): Promise<MediaStreamLike>
		}
	}
	readonly MediaRecorder: {
		new (
			stream: MediaStreamLike,
			options: { mimeType?: string }
		): MediaRecorderLike
		isTypeSupported(mimeType: string): boolean
	}
}

/** Soniox's native rate; the phone's recorder is asked for it and reports what it delivers. */
export const DICTATION_SAMPLE_RATE = 16_000

/** 100 ms per buffer at 16 kHz, so the first words show quickly. */
export const DICTATION_BUFFER_SAMPLES = 1_600

/** Small browser chunks keep the first words on screen within a few hundred ms. */
const MEDIA_RECORDER_TIMESLICE_MS = 120

/** Caps waiting frames before WebSocket open so a stalled connect cannot grow memory unboundedly. */
const MAX_WAITING_FRAMES = 128

/** Fallback wait for MediaRecorder's `stop` event when a device disconnects mid-recording. */
const DEFAULT_MEDIA_STOP_TIMEOUT_MS = 2_000

const WEBSOCKET_OPEN = 1

/**
 * Opens Soniox's socket. With `headers: true` (React Native) the key goes in
 * the Authorization header, through React Native's third constructor argument;
 * browsers cannot send headers, so the key then goes in the start request.
 * Frames sent before the socket is open wait for it, since the microphone
 * starts at once.
 */
export function webSocketFactory(
	options: { readonly headers?: boolean; readonly WebSocket?: unknown } = {}
): DictationSocketFactory {
	const sendsHeaders = options.headers ?? false

	return {
		sendsHeaders,
		open(url, headers, handlers) {
			const Socket = (options.WebSocket ??
				globalThis.WebSocket) as WebSocketConstructor
			const socket = sendsHeaders
				? new (
						Socket as new (
							url: string,
							protocols: null,
							init: { headers: Readonly<Record<string, string>> }
						) => WebSocketLike
					)(url, null, { headers })
				: new Socket(url)
			const waiting: DictationFrame[] = []
			let closed = false

			const close = () => {
				if (closed) {
					return
				}

				closed = true
				waiting.length = 0
				handlers.onClose()
			}

			socket.addEventListener('open', () => {
				if (closed) {
					return
				}

				for (const frame of waiting.splice(0)) {
					socket.send(frame)
				}
			})
			socket.addEventListener('message', (event) => {
				handlers.onMessage(String(event.data))
			})
			socket.addEventListener('error', close)
			socket.addEventListener('close', close)

			return {
				send(frame) {
					if (closed) {
						return
					}

					if (socket.readyState === WEBSOCKET_OPEN) {
						socket.send(frame)
					} else {
						if (waiting.length >= MAX_WAITING_FRAMES) {
							// Keep index 0 (the start request) and drop the oldest queued audio frame.
							waiting.splice(1, 1)
						}
						waiting.push(frame)
					}
				},
				close() {
					closed = true
					waiting.length = 0
					socket.close()
				}
			}
		}
	}
}

// The library asks for one recorder for the app's lifetime; an owner token keeps
// an older session's cleanup from stopping a newer session that already started.
let sharedRecorder: AudioApiRecorder | undefined
let sharedRecorderOwner: symbol | undefined

/**
 * The phone's microphone through `react-native-audio-api`, loaded on first use
 * so builds without the native module never import it:
 * `audioApiMicrophone(() => import('react-native-audio-api'))`.
 * Asks for 16 kHz mono; the device may deliver another rate, which each buffer
 * reports. The audio session is active while recording and given back after,
 * so music the user was playing resumes.
 */
export function audioApiMicrophone(
	load: () => Promise<AudioApiModule>
): DictationMicrophone {
	let owner: symbol | undefined

	return {
		async requestPermission() {
			const { AudioManager } = await load()

			return (await AudioManager.requestRecordingPermissions()) === 'Granted'
		},
		async start(onAudio) {
			const { AudioManager, AudioRecorder } = await load()
			const token = Symbol('dictation')
			owner = token
			sharedRecorderOwner = token

			AudioManager.setAudioSessionOptions({
				iosCategory: 'record',
				iosMode: 'default',
				iosOptions: [],
				iosNotifyOthersOnDeactivation: true
			})
			await AudioManager.setAudioSessionActivity(true)
			sharedRecorder ??= new AudioRecorder()
			const listening = sharedRecorder.onAudioReady(
				{
					sampleRate: DICTATION_SAMPLE_RATE,
					bufferLength: DICTATION_BUFFER_SAMPLES,
					channelCount: 1
				},
				({ buffer }) => {
					if (sharedRecorderOwner !== token) return
					onAudio({
						kind: 'pcm',
						samples: buffer.getChannelData(0),
						sampleRate: buffer.sampleRate
					})
				}
			)

			if (hasErrorStatus(listening)) {
				if (sharedRecorderOwner === token) {
					sharedRecorderOwner = undefined
					await AudioManager.setAudioSessionActivity(false).catch(() => {})
				}
				return false
			}

			const started = (await sharedRecorder.start()).status === 'success'
			if (!started && sharedRecorderOwner === token) {
				sharedRecorder.clearOnAudioReady()
				sharedRecorderOwner = undefined
				await AudioManager.setAudioSessionActivity(false).catch(() => {})
			}
			return started
		},
		async stop() {
			const token = owner
			owner = undefined
			if (token !== undefined && sharedRecorderOwner !== token) {
				return
			}

			const recorder = sharedRecorder

			// Stopping hands the last partial buffer to the callback, so it is cleared after.
			if (recorder?.isRecording()) {
				await recorder.stop()
			}

			recorder?.clearOnAudioReady()
			if (token === undefined || sharedRecorderOwner === token) {
				sharedRecorderOwner = undefined
			}
			const { AudioManager } = await load()
			await AudioManager.setAudioSessionActivity(false).catch(() => {})
		}
	}
}

/**
 * The browser's microphone through `MediaRecorder`. Its own container
 * (WebM/Opus, or MP4 on Safari) goes out as-is with `audio_format: 'auto'`,
 * so there is no resampling in the page. The permission request opens the
 * stream; a refusal is `false`, a missing microphone throws.
 */
export function mediaRecorderMicrophone(
	options: {
		readonly audio?: object
		/** Maximum wait for `MediaRecorder`'s `stop` event before releasing tracks anyway. Default 2 s. */
		readonly stopTimeoutMs?: number
	} = {}
): DictationMicrophone {
	const browser = globalThis as unknown as BrowserAudio
	const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_MEDIA_STOP_TIMEOUT_MS
	let stream: MediaStreamLike | undefined
	let recorder: MediaRecorderLike | undefined

	const releaseTracks = (target: MediaStreamLike | undefined) => {
		for (const track of target?.getTracks() ?? []) {
			track.stop()
		}
	}

	return {
		async requestPermission() {
			try {
				const nextStream = await browser.navigator.mediaDevices.getUserMedia({
					audio: options.audio ?? {
						echoCancellation: true,
						noiseSuppression: true
					}
				})
				releaseTracks(stream)
				stream = nextStream
				return true
			} catch (error) {
				if (
					error instanceof Error &&
					isOneOf(['NotAllowedError', 'SecurityError'], error.name)
				) {
					return false
				}

				throw error
			}
		},
		async start(onAudio) {
			if (!stream) {
				return false
			}

			const mimeType = 'audio/webm;codecs=opus'
			recorder = new browser.MediaRecorder(
				stream,
				// Safari records mp4; Soniox detects the container either way.
				browser.MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : {}
			)
			recorder.addEventListener('dataavailable', (event) => {
				if (event.data.size > 0) {
					onAudio({ kind: 'encoded', data: event.data })
				}
			})
			recorder.start(MEDIA_RECORDER_TIMESLICE_MS)

			return true
		},
		/** The recorder flushes its final chunk before `stop` fires. */
		async stop() {
			const active = recorder
			const activeStream = stream
			recorder = undefined
			stream = undefined

			try {
				if (active && active.state !== 'inactive') {
					await new Promise<void>((resolve) => {
						let settled = false
						const done = () => {
							if (settled) return
							settled = true
							clearTimeout(timer)
							resolve()
						}
						const timer = setTimeout(done, stopTimeoutMs)
						active.addEventListener('stop', done, { once: true })
						active.addEventListener('error', done, { once: true })
						try {
							active.stop()
						} catch {
							done()
						}
					})
				}
			} finally {
				releaseTracks(activeStream)
			}
		}
	}
}

/** Stops a listening dictation when React Native's app goes to the background: `appStateLifecycle(AppState)`. */
export function appStateLifecycle(appState: AppStateLike): DictationLifecycle {
	return {
		isBackground: () => appState.currentState === 'background',
		onBackground(listener) {
			const subscription = appState.addEventListener('change', (state) => {
				if (state === 'background') {
					listener()
				}
			})

			return () => subscription.remove()
		}
	}
}

function hasErrorStatus(result: unknown): boolean {
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as { status?: unknown }).status === 'error'
	)
}
