/**
 * One dictation: asks for the microphone, gets a temporary key, streams the
 * microphone to Soniox and reports the running transcript. The microphone, the
 * socket, the key request and the app lifecycle are injected, so this module
 * loads no native module. Every ending, asked for or not, releases the
 * microphone and the socket once.
 */
import { webSocketFactory } from './adapters.js'
import {
	applySonioxResponse,
	buildSonioxStartRequest,
	type DictationTranscript,
	EMPTY_TRANSCRIPT,
	type SonioxAudioFormat,
	sonioxLanguageHints,
	toS16le,
	transcriptText
} from './protocol.js'

/** What the server hands the client to open one dictation; see `better-mastra/dictation/server`. */
export interface DictationKey {
	/** Soniox's temporary key: single use, connect within its TTL. */
	readonly apiKey: string
	/** The region's real-time WebSocket URL. */
	readonly websocketUrl: string
	/** The Soniox real-time model for the start request. */
	readonly model: string
	/** ISO date-time; the client must connect before it. */
	readonly expiresAt?: string
}

/** A buffer from the microphone: float samples (sent as PCM), or an encoded container Soniox detects (`audio_format: 'auto'`). */
export type DictationAudio =
	| {
			readonly kind: 'pcm'
			readonly samples: Float32Array
			readonly sampleRate: number
	  }
	| { readonly kind: 'encoded'; readonly data: Blob | ArrayBuffer }

export interface DictationMicrophone {
	/** Asks for the microphone; false when the person says no. */
	requestPermission(): Promise<boolean>
	/** Starts recording; false when it could not. */
	start(onAudio: (audio: DictationAudio) => void): Promise<boolean>
	/** Stops recording, handing over the last buffer first, and releases the device. Safe before `start` and more than once. */
	stop(): Promise<void>
}

export type DictationFrame = string | ArrayBuffer | Blob

export interface DictationSocket {
	send(frame: DictationFrame): void
	close(): void
}

export interface DictationSocketFactory {
	/** Whether `open` sends `headers`; when false the key goes in the start request instead. */
	readonly sendsHeaders: boolean
	/** Opens the socket at once; frames sent before it is open wait for it. An error and the close after it are one `onClose`. */
	open(
		url: string,
		headers: Readonly<Record<string, string>>,
		handlers: {
			readonly onMessage: (message: string) => void
			readonly onClose: () => void
		}
	): DictationSocket
}

/** The app going to the background stops a listening dictation. */
export interface DictationLifecycle {
	isBackground(): boolean
	/** Returns the unsubscribe. */
	onBackground(listener: () => void): () => void
}

export interface DictationEnd {
	readonly kind: 'stopped' | 'failed' | 'cancelled'
	readonly text: string
}

export interface DictationSession {
	/** Ends the audio, waits for the last words and resolves with the final text. */
	stop(): Promise<string>
	/** Drops the session now; it ends as `cancelled` with the text so far. */
	cancel(): void
}

export type DictationStart =
	| { readonly kind: 'started'; readonly session: DictationSession }
	| { readonly kind: 'permission_denied' }
	/** The device has no microphone at all (`NotFoundError`). */
	| { readonly kind: 'no_microphone' }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'cancelled' }

export interface DictationOptions {
	/** The app locale; its language is the first hint. */
	readonly locale: string
	/** Hints after the locale's language; defaults to English. */
	readonly languages?: readonly string[]
	readonly requestKey: () => Promise<DictationKey>
	readonly microphone: DictationMicrophone
	/** Defaults to the global WebSocket with the key in the start request. */
	readonly socket?: DictationSocketFactory
	readonly lifecycle?: DictationLifecycle
	/** Aborting cancels the start, or the session once started. */
	readonly signal?: AbortSignal
	readonly onTranscript?: (transcript: DictationTranscript) => void
	/** Called once per started session. */
	readonly onEnd?: (end: DictationEnd) => void
}

/** How long stop() waits for Soniox's last response: long enough for the last words, short enough that a tap feels answered. */
export const DICTATION_FINISH_TIMEOUT_MS = 4_000

/** The empty text frame that tells Soniox the audio is complete. */
const END_OF_AUDIO = ''

/** Starts one dictation: permission and key at once, then socket and microphone. */
export async function startDictation(
	options: DictationOptions
): Promise<DictationStart> {
	const { microphone, signal } = options

	if (signal?.aborted) return { kind: 'cancelled' }

	// Asked for while the permission prompt is open, so a start waits for one round trip, not two.
	const firstKey = options.requestKey().catch(() => undefined)
	// A refusal is false; a throw is no microphone (`NotFoundError`) or a broken one.
	const granted = await microphone
		.requestPermission()
		.catch((error: unknown) =>
			isNoMicrophone(error) ? ('no_microphone' as const) : undefined
		)

	if (granted !== true) {
		await microphone.stop().catch(() => {})
		return granted === false
			? { kind: 'permission_denied' }
			: granted === 'no_microphone'
				? { kind: 'no_microphone' }
				: { kind: 'unavailable' }
	}

	const key = signal?.aborted
		? undefined
		: await freshKey(await firstKey, options)

	if (key === undefined || signal?.aborted) {
		await microphone.stop().catch(() => {})
		return signal?.aborted ? { kind: 'cancelled' } : { kind: 'unavailable' }
	}

	const session = new Session(key, options)

	if (!(await session.start())) {
		return { kind: 'unavailable' }
	}

	if (signal?.aborted) {
		session.cancel()
		return { kind: 'cancelled' }
	}

	return { kind: 'started', session }
}

/** The key asked for beside the permission prompt, or a new one when the prompt outlasted it. */
async function freshKey(
	key: DictationKey | undefined,
	options: Pick<DictationOptions, 'requestKey'>
): Promise<DictationKey | undefined> {
	const expired =
		key?.expiresAt !== undefined && Date.parse(key.expiresAt) <= Date.now()

	return key && !expired
		? key
		: await options.requestKey().catch(() => undefined)
}

/** `getUserMedia` rejects this way when the device has no microphone, or none that fits. */
function isNoMicrophone(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name

	return name === 'NotFoundError' || name === 'OverconstrainedError'
}

/**
 * One dictation's stream. The socket opens at once, since the key must connect
 * within its TTL; the start request goes out with the first buffer, once its
 * format is known. The caller hears of an ending only once the session started.
 */
class Session implements DictationSession {
	private transcript = EMPTY_TRANSCRIPT
	private socket: DictationSocket | undefined
	private started = false
	private audioSent = false
	private audioComplete = false
	private ended = false
	private stopping: Promise<string> | undefined
	private microphoneStopped: Promise<void> | undefined
	private finishTimer: ReturnType<typeof setTimeout> | undefined
	private unsubscribe: () => void = () => {}
	private resolveEnded: (text: string) => void = () => {}
	private readonly endedText = new Promise<string>((resolve) => {
		this.resolveEnded = resolve
	})
	private readonly socketFactory: DictationSocketFactory

	constructor(
		private readonly key: DictationKey,
		private readonly options: DictationOptions
	) {
		this.socketFactory = options.socket ?? webSocketFactory()
	}

	/** Opens the socket and starts the microphone; false, with everything released, when either fails. */
	async start(): Promise<boolean> {
		try {
			this.socket = this.socketFactory.open(
				this.key.websocketUrl,
				this.socketFactory.sendsHeaders
					? { Authorization: `Bearer ${this.key.apiKey}` }
					: {},
				{
					onMessage: (message) => this.receive(message),
					// Soniox sends `finished` before it closes, so a close before it is a failure.
					onClose: () => this.end('failed')
				}
			)
			const recording = await this.options.microphone.start((audio) =>
				this.sendAudio(audio)
			)

			if (recording && this.ended) {
				// The socket closed while the microphone was starting.
				await this.options.microphone.stop().catch(() => {})
			}

			this.started = recording && !this.ended
		} catch {
			this.started = false
		}

		if (!this.started) {
			this.end('failed')
			await this.endedText
			return false
		}

		this.listenForEnding()
		return true
	}

	stop(): Promise<string> {
		if (this.ended) {
			return this.endedText
		}

		this.stopping ??= this.finishStream()

		return this.stopping
	}

	cancel(): void {
		this.end('cancelled')
	}

	private listenForEnding(): void {
		const { lifecycle, signal } = this.options
		const onAbort = () => this.cancel()
		const offBackground = lifecycle?.onBackground(() => void this.stop())

		signal?.addEventListener('abort', onAbort)
		this.unsubscribe = () => {
			offBackground?.()
			signal?.removeEventListener('abort', onAbort)
		}

		// The permission dialog can send the app away while the session started.
		if (lifecycle?.isBackground()) {
			void this.stop()
		}
	}

	private async finishStream(): Promise<string> {
		await this.stopMicrophone()

		// Buffers the microphone delivered until it stopped have gone out; nothing follows the end of audio.
		this.audioComplete = true

		if (!this.audioSent) {
			// Soniox answers a stream without audio with an error, so there is nothing to wait for.
			this.end('stopped')
		} else if (!this.ended) {
			this.socket?.send(END_OF_AUDIO)
			this.finishTimer = setTimeout(
				() => this.end('stopped'),
				DICTATION_FINISH_TIMEOUT_MS
			)
		}

		return this.endedText
	}

	private sendAudio(audio: DictationAudio): void {
		if (this.ended || this.audioComplete || !this.socket) {
			return
		}

		if (!this.audioSent) {
			this.socket.send(this.startRequest(audio))
			this.audioSent = true
		}

		this.socket.send(audio.kind === 'pcm' ? toS16le(audio.samples) : audio.data)
	}

	private startRequest(audio: DictationAudio): string {
		const audioFormat: SonioxAudioFormat =
			audio.kind === 'pcm'
				? {
						audio_format: 'pcm_s16le',
						sample_rate: audio.sampleRate,
						num_channels: 1
					}
				: { audio_format: 'auto' }

		return buildSonioxStartRequest({
			model: this.key.model,
			audioFormat,
			languageHints: sonioxLanguageHints(
				this.options.locale,
				this.options.languages
			),
			...(this.socketFactory.sendsHeaders ? {} : { apiKey: this.key.apiKey })
		})
	}

	private receive(message: string): void {
		if (this.ended) {
			return
		}

		const result = applySonioxResponse(this.transcript, message)
		this.transcript = result.transcript

		if (result.kind === 'error') {
			this.end('failed')
			return
		}

		this.options.onTranscript?.(this.transcript)

		if (result.kind === 'finished') {
			this.end('stopped')
		}
	}

	/**
	 * Every ending: the socket closes and the microphone stops, once, before the
	 * caller hears of it, so a dictation started right after never meets this
	 * one's release.
	 */
	private end(kind: DictationEnd['kind']): void {
		if (this.ended) {
			return
		}

		this.ended = true
		clearTimeout(this.finishTimer)
		this.unsubscribe()
		this.socket?.close()
		void this.stopMicrophone().then(() => {
			const text = transcriptText(this.transcript)

			if (this.started) {
				this.options.onEnd?.({ kind, text })
			}

			this.resolveEnded(text)
		})
	}

	private stopMicrophone(): Promise<void> {
		this.microphoneStopped ??= this.options.microphone.stop().catch(() => {})

		return this.microphoneStopped
	}
}
