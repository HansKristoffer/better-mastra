import { describe, expect, test } from 'bun:test'

import {
	createWordFadeTracker,
	isSafeUrl,
	markdownParagraphs,
	nextRevealLength,
	REVEAL_CATCH_UP_STEPS,
	splitWordTokens,
	trimIncompleteMarkdown,
	WORD_FADE_MS
} from './reveal'

describe('nextRevealLength', () => {
	test('reveals one whole word at a time while the reveal keeps up', () => {
		const text = 'Dit budget '

		expect(text.slice(0, nextRevealLength(text, 0))).toBe('Dit')
	})

	test('holds back a word that is still being written', () => {
		expect(nextRevealLength('Dit bud', 3)).toBe(3)
	})

	test('catches up with a stream that runs far ahead', () => {
		const words = Array.from(
			{ length: REVEAL_CATCH_UP_STEPS * 4 },
			(_, index) => `ord${index}`
		)
		const text = `${words.join(' ')} `

		expect(text.slice(0, nextRevealLength(text, 0)).split(' ')).toEqual(
			words.slice(0, 4)
		)
	})
})

describe('trimIncompleteMarkdown', () => {
	test('shows a half-written link as its label', () => {
		expect(trimIncompleteMarkdown('Se [dit budget](https://example')).toBe(
			'Se dit budget'
		)
		expect(trimIncompleteMarkdown('Se [dit bud')).toBe('Se dit bud')
	})

	test('closes bold, italics and code that are still open', () => {
		expect([
			trimIncompleteMarkdown('Du har **2.400 kr'),
			trimIncompleteMarkdown('Det er *ret'),
			trimIncompleteMarkdown('Kør `npm'),
			trimIncompleteMarkdown('```\nconst a = 1')
		]).toEqual([
			'Du har **2.400 kr**',
			'Det er *ret*',
			'Kør `npm`',
			'```\nconst a = 1\n```'
		])
	})

	test('leaves out a list marker until its first word arrives', () => {
		expect(trimIncompleteMarkdown('- Mad\n- ')).toBe('- Mad')
		expect(trimIncompleteMarkdown('1. Mad\n2.')).toBe('1. Mad')
	})
})

describe('markdownParagraphs', () => {
	test('splits paragraphs, and keeps a code fence or a list continuation whole', () => {
		expect([
			markdownParagraphs('Første afsnit.\n\nAndet afsnit.'),
			markdownParagraphs('Kode:\n\n```\na\n\nb\n```'),
			markdownParagraphs('- Mad\n\n  - Dagligvarer')
		]).toEqual([
			['Første afsnit.', 'Andet afsnit.'],
			['Kode:\n\n```\na\n\nb\n```'],
			['- Mad\n\n  - Dagligvarer']
		])
	})
})

describe('splitWordTokens', () => {
	test('splits text into words that join back to it', () => {
		expect(splitWordTokens(' Dit  budget\n')).toEqual([
			{ text: ' Dit', word: true },
			{ text: '  budget', word: true },
			{ text: '\n', word: false }
		])
	})
})

describe('createWordFadeTracker', () => {
	test('fades only the words that appeared within the fade', () => {
		let now = 0
		const tracker = createWordFadeTracker(() => now)
		tracker.window(2)
		now = WORD_FADE_MS

		const { from, elapsedFor } = tracker.window(3)

		expect(from).toBe(2)
		expect(elapsedFor(2)).toBe(0)
	})

	test('settles every word when the text is replaced rather than grown', () => {
		const tracker = createWordFadeTracker(() => 0)
		tracker.window(3)

		expect(tracker.window(2).from).toBe(2)
	})

	test('fades at most 24 words at once', () => {
		expect(createWordFadeTracker(() => 0).window(100).from).toBe(76)
	})
})

describe('isSafeUrl', () => {
	test.each([
		['https://example.com', true],
		['mailto:hej@example.com', true],
		['tel:+4512345678', true],
		['/settings', true],
		['#top', true],
		['javascript:alert(1)', false],
		['data:text/html,x', false],
		['', false]
	])('%p → %p', (url, expected) => {
		expect(isSafeUrl(url)).toBe(expected)
	})
})
