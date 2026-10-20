import { describe, expect, test } from 'bun:test'

import {
	applySonioxResponse,
	buildSonioxStartRequest,
	EMPTY_TRANSCRIPT,
	sonioxLanguageHints,
	toS16le
} from './protocol.js'

describe('sonioxLanguageHints', () => {
	test('should hint the locale language first, then the others, once each', () => {
		expect(sonioxLanguageHints('da-DK')).toEqual(['da', 'en'])
		expect(sonioxLanguageHints('en', ['da'])).toEqual(['en', 'da'])
		expect(sonioxLanguageHints('en')).toEqual(['en'])
	})
})

describe('buildSonioxStartRequest', () => {
	test('should name the model, raw mono PCM at the delivered rate and the language hints, and never the key by default', () => {
		const request = JSON.parse(
			buildSonioxStartRequest({
				model: 'stt-rt-v5',
				audioFormat: {
					audio_format: 'pcm_s16le',
					sample_rate: 48_000,
					num_channels: 1
				},
				languageHints: ['da', 'en']
			})
		)

		expect(request).toEqual({
			model: 'stt-rt-v5',
			audio_format: 'pcm_s16le',
			sample_rate: 48_000,
			num_channels: 1,
			language_hints: ['da', 'en']
		})
	})

	test('should carry the key when the socket could not send it as a header', () => {
		const request = JSON.parse(
			buildSonioxStartRequest({
				model: 'stt-rt-v5',
				audioFormat: { audio_format: 'auto' },
				languageHints: ['en'],
				apiKey: 'temporary-key'
			})
		)

		expect(request).toMatchObject({
			api_key: 'temporary-key',
			audio_format: 'auto'
		})
	})
})

describe('toS16le', () => {
	test('should write little-endian 16-bit samples and clamp anything outside full scale', () => {
		const pcm = new DataView(toS16le(new Float32Array([0, 1, -1, 1.5, -2])))

		expect(pcm.byteLength).toBe(10)
		expect(
			Array.from({ length: 5 }, (_, index) => pcm.getInt16(index * 2, true))
		).toEqual([0, 32767, -32768, 32767, -32768])
		expect([pcm.getUint8(2), pcm.getUint8(3)]).toEqual([0xff, 0x7f])
	})
})

describe('applySonioxResponse', () => {
	test('should keep the final words and show only the latest words still being recognized', () => {
		const result = applySonioxResponse(
			{ finalText: 'Hvad har jeg', interimText: ' brugt' },
			JSON.stringify({
				tokens: [
					{ text: ' brugt', is_final: true },
					{ text: ' på', is_final: false },
					{ text: ' mad', is_final: false }
				]
			})
		)

		expect(result).toEqual({
			kind: 'text',
			transcript: { finalText: 'Hvad har jeg brugt', interimText: ' på mad' }
		})
	})

	test('should drop endpoint markers between words', () => {
		const first = applySonioxResponse(
			EMPTY_TRANSCRIPT,
			JSON.stringify({
				tokens: [
					{ text: 'Hel', is_final: true },
					{ text: 'lo wor', is_final: false }
				]
			})
		)
		const second = applySonioxResponse(
			first.transcript,
			JSON.stringify({
				tokens: [
					{ text: 'lo', is_final: true },
					{ text: '<end>', is_final: true },
					{ text: ' world', is_final: false }
				]
			})
		)

		expect(second.transcript).toEqual({
			finalText: 'Hello',
			interimText: ' world'
		})
	})

	test('should end the stream when Soniox has finished, without its control markers', () => {
		const result = applySonioxResponse(
			{ finalText: 'Hej', interimText: ' Bliss' },
			JSON.stringify({
				tokens: [
					{ text: ' Bliss', is_final: true },
					{ text: '<fin>', is_final: true }
				],
				finished: true
			})
		)

		expect(result).toEqual({
			kind: 'finished',
			transcript: { finalText: 'Hej Bliss', interimText: '' }
		})
	})

	test('should end the stream with the text so far when Soniox reports an error or sends something unreadable', () => {
		const transcript = { finalText: 'Hvad har jeg', interimText: ' brugt' }

		expect([
			applySonioxResponse(
				transcript,
				JSON.stringify({
					error_code: 408,
					error_type: 'request_timeout',
					error_message: 'Audio is too long.'
				})
			),
			applySonioxResponse(EMPTY_TRANSCRIPT, 'not json')
		]).toEqual([
			{ kind: 'error', transcript },
			{ kind: 'error', transcript: EMPTY_TRANSCRIPT }
		])
	})
})
