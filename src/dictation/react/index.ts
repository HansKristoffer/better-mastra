/**
 * One dictation at a time for a React or React Native component. The live text
 * goes through a channel that only its reader subscribes to, so a token
 * re-renders that reader alone; `onDictated` hears the text once, when the
 * dictation ends. Unmounting cancels it.
 */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore
} from 'react'
import {
	type DictationEnd,
	type DictationOptions,
	type DictationSession,
	startDictation,
	transcriptText
} from '../index.js'

/** Where the dictation is: asking for the microphone and a key, listening, or waiting for the last words. */
export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** Why the last dictation gave no text: the microphone was refused, or dictation failed. */
export type DictationNotice = 'permission_denied' | 'unavailable'

/** The live text, published per token. */
export interface DictationTranscriptChannel {
	readonly subscribe: (listener: () => void) => () => void
	readonly read: () => string
}

export interface UseDictationOptions
	extends Omit<DictationOptions, 'signal' | 'onEnd'> {
	/** The text, when a dictation that heard something stops or fails; never mid-way and never after `cancel`. */
	readonly onDictated?: (text: string) => void
	readonly onEnd?: (end: DictationEnd) => void
}

export function useDictation(options: UseDictationOptions) {
	const [phase, setPhase] = useState<DictationPhase>('idle')
	const [notice, setNotice] = useState<DictationNotice>()
	const [transcript] = useState(createTranscriptChannel)
	const session = useRef<DictationSession | undefined>(undefined)
	const starting = useRef<AbortController | undefined>(undefined)
	const latest = useRef(options)
	latest.current = options

	const stop = useCallback(() => {
		if (session.current) {
			setPhase('finishing')
			void session.current.stop()
		}
	}, [])

	const cancel = useCallback(() => {
		starting.current?.abort()
		session.current?.cancel()
	}, [])

	const start = useCallback(async () => {
		if (starting.current || session.current) {
			return
		}

		const controller = new AbortController()
		starting.current = controller
		setNotice(undefined)
		setPhase('starting')
		// A session can end before `startDictation` returns, e.g. sent to the background.
		let ended = false

		const started = await startDictation({
			...latest.current,
			signal: controller.signal,
			onTranscript: (heard) => {
				transcript.publish(transcriptText(heard))
				latest.current.onTranscript?.(heard)
			},
			onEnd: (end) => {
				ended = true
				session.current = undefined
				transcript.publish('')

				if (end.kind !== 'cancelled' && end.text !== '') {
					latest.current.onDictated?.(end.text)
				}

				latest.current.onEnd?.(end)
				setPhase('idle')
				setNotice(end.kind === 'failed' ? 'unavailable' : undefined)
			}
		})
		starting.current = undefined

		if (started.kind === 'started') {
			if (!ended) {
				session.current = started.session
				setPhase('listening')
			}
			return
		}

		setPhase('idle')
		setNotice(started.kind === 'cancelled' ? undefined : started.kind)
	}, [transcript])

	useEffect(() => cancel, [cancel])

	return { phase, notice, transcript, start, stop, cancel }
}

/** The live text in a component that shows it: `useDictationText(dictation.transcript)`. */
export function useDictationText(channel: DictationTranscriptChannel): string {
	return useSyncExternalStore(channel.subscribe, channel.read, channel.read)
}

function createTranscriptChannel() {
	const listeners = new Set<() => void>()
	let text = ''

	return {
		subscribe: (listener: () => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		read: () => text,
		publish: (next: string) => {
			text = next

			for (const listener of listeners) {
				listener()
			}
		}
	}
}
