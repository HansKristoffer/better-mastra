/**
 * One dictation at a time for a Vue component, with the browser's microphone
 * by default. `text` is the live transcript; `onDictated` hears the text once,
 * when the dictation ends. Disposing the scope cancels it.
 */
import {
	getCurrentScope,
	type MaybeRefOrGetter,
	onScopeDispose,
	readonly,
	shallowRef,
	toValue
} from 'vue'
import {
	type DictationEnd,
	type DictationMicrophone,
	type DictationOptions,
	type DictationSession,
	mediaRecorderMicrophone,
	startDictation,
	transcriptText
} from '../index.js'

/** Where the dictation is: asking for the microphone and a key, listening, or waiting for the last words. */
export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** Why the last dictation gave no text: the microphone was refused or is missing, or dictation failed. */
export type DictationNotice =
	'permission_denied' | 'no_microphone' | 'unavailable'

export interface UseDictationOptions extends Omit<
	DictationOptions,
	'signal' | 'onEnd' | 'locale' | 'microphone'
> {
	readonly locale: MaybeRefOrGetter<string>
	/** Defaults to `mediaRecorderMicrophone()`. */
	readonly microphone?: DictationMicrophone
	/** The text, when a dictation that heard something stops or fails; never mid-way and never after `cancel`. */
	readonly onDictated?: (text: string) => void
	readonly onEnd?: (end: DictationEnd) => void
	/** The notice, once, when a dictation gives no text for one of its reasons: show a toast here. */
	readonly onNotice?: (notice: DictationNotice) => void
}

export function useDictation(options: UseDictationOptions) {
	const phase = shallowRef<DictationPhase>('idle')
	const notice = shallowRef<DictationNotice>()
	const text = shallowRef('')
	const microphone = options.microphone ?? mediaRecorderMicrophone()
	let session: DictationSession | undefined
	let starting: AbortController | undefined

	async function start() {
		if (starting || session) {
			return
		}

		const controller = new AbortController()
		starting = controller
		notice.value = undefined
		phase.value = 'starting'
		// A session can end before `startDictation` returns.
		let ended = false

		const started = await startDictation({
			...options,
			locale: toValue(options.locale),
			microphone,
			signal: controller.signal,
			onTranscript: (heard) => {
				text.value = transcriptText(heard)
				options.onTranscript?.(heard)
			},
			onEnd: (end) => {
				ended = true
				session = undefined
				text.value = ''

				if (end.kind !== 'cancelled' && end.text !== '') {
					options.onDictated?.(end.text)
				}

				options.onEnd?.(end)
				phase.value = 'idle'
				notice.value = end.kind === 'failed' ? 'unavailable' : undefined

				if (end.kind === 'failed') options.onNotice?.('unavailable')
			}
		})
		starting = undefined

		if (started.kind === 'started') {
			if (!ended) {
				session = started.session
				phase.value = 'listening'
			}
			return
		}

		phase.value = 'idle'

		if (started.kind === 'cancelled') {
			notice.value = undefined
		} else {
			notice.value = started.kind
			options.onNotice?.(started.kind)
		}
	}

	function stop() {
		if (session) {
			phase.value = 'finishing'
			void session.stop()
		}
	}

	function cancel() {
		starting?.abort()
		session?.cancel()
	}

	if (getCurrentScope()) {
		onScopeDispose(cancel)
	}

	return {
		phase: readonly(phase),
		notice: readonly(notice),
		text: readonly(text),
		start,
		stop,
		cancel
	}
}
