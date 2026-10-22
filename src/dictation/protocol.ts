import { isRecord, safeJsonParse } from 'hanzio'
/**
 * Soniox's real-time transcription protocol as a dictation speaks it: the
 * start request, float samples as 16-bit PCM, and folding each response into
 * the running transcript. Pure, so the session owns every socket and
 * microphone.
 */

export interface DictationTranscript {
	/** The text of every final token so far; Soniox will not revise it. */
	readonly finalText: string
	/** The latest response's non-final tokens; the next response replaces them. */
	readonly interimText: string
}

/** How the audio is described in the start request. */
export type SonioxAudioFormat =
	| { readonly audio_format: 'auto' }
	| {
			readonly audio_format: 'pcm_s16le'
			readonly sample_rate: number
			readonly num_channels: number
	  }

export interface SonioxResponseResult {
	readonly kind: 'text' | 'finished' | 'error'
	readonly transcript: DictationTranscript
}

interface SonioxToken {
	readonly text: string
	readonly isFinal: boolean
}

export const EMPTY_TRANSCRIPT: DictationTranscript = {
	finalText: '',
	interimText: ''
}

const INT16_MAX = 0x7fff
const INT16_MIN_MAGNITUDE = 0x8000
const BYTES_PER_SAMPLE = 2

/**
 * Soniox's language hints for a locale: its language first, then `languages`
 * (default English), since people mix English words into their own language.
 * `da-DK` hints `da`.
 */
export function sonioxLanguageHints(
	locale: string,
	languages: readonly string[] = ['en']
): string[] {
	const language = (locale.split(/[-_]/)[0] ?? locale).toLowerCase()

	return [...new Set([language, ...languages])]
}

/**
 * The start request: the first, text frame of a Soniox stream. `apiKey` goes in
 * it only when the socket could not send it as a header (browsers).
 */
export function buildSonioxStartRequest(input: {
	readonly model: string
	readonly audioFormat: SonioxAudioFormat
	readonly languageHints: readonly string[]
	readonly apiKey?: string
}): string {
	return JSON.stringify({
		...(input.apiKey === undefined ? {} : { api_key: input.apiKey }),
		model: input.model,
		...input.audioFormat,
		language_hints: input.languageHints
	})
}

/** Float samples from -1.0 to 1.0 as 16-bit little-endian PCM, whatever the device's byte order. */
export function toS16le(samples: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(samples.length * BYTES_PER_SAMPLE)
	const view = new DataView(buffer)

	samples.forEach((sample, index) => {
		const clamped = Math.max(-1, Math.min(1, sample))
		const scaled =
			clamped < 0 ? clamped * INT16_MIN_MAGNITUDE : clamped * INT16_MAX

		view.setInt16(index * BYTES_PER_SAMPLE, Math.round(scaled), true)
	})

	return buffer
}

/** The text so far: the final words, then the words Soniox has not finalized. */
export function transcriptText(transcript: DictationTranscript): string {
	return `${transcript.finalText}${transcript.interimText}`.trim()
}

/** Folds one Soniox response (the raw text frame) into the transcript. */
export function applySonioxResponse(
	transcript: DictationTranscript,
	message: string
): SonioxResponseResult {
	const parsed = parseJsonObject(message)

	if (
		parsed === undefined ||
		parsed.error_code !== undefined ||
		parsed.error_type !== undefined
	) {
		return { kind: 'error', transcript }
	}

	const tokens = (Array.isArray(parsed.tokens) ? parsed.tokens : [])
		.flatMap(toToken)
		.filter((token) => !isControlToken(token))
	const textOf = (isFinal: boolean) =>
		tokens
			.filter((token) => token.isFinal === isFinal)
			.map((token) => token.text)
			.join('')
	const next = {
		finalText: transcript.finalText + textOf(true),
		interimText: textOf(false)
	}

	return {
		kind: parsed.finished === true ? 'finished' : 'text',
		transcript: next
	}
}

function parseJsonObject(message: string): Record<string, unknown> | undefined {
	const parsed = safeJsonParse(message)

	return parsed.ok && isRecord(parsed.data) ? parsed.data : undefined
}

function toToken(token: unknown): SonioxToken[] {
	if (typeof token !== 'object' || token === null) {
		return []
	}

	const { text, is_final: isFinal } = token as Record<string, unknown>

	return typeof text === 'string' ? [{ text, isFinal: isFinal === true }] : []
}

/** `<end>` and `<fin>` mark endpoints and finalization, not speech. */
function isControlToken(token: SonioxToken): boolean {
	return token.text.startsWith('<') && token.text.endsWith('>')
}
