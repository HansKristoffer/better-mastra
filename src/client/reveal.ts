/**
 * How a streaming answer's text is revealed and prepared for markdown: the
 * steady word-by-word pace, which revealed words are still fading in,
 * trimming markdown that is only half written, the split into paragraphs so
 * only the last one parses again as the text grows, and which links may open.
 * Pure; each binding runs the timer and draws the fade its own way.
 */

// CONSTANTS

/** Time between two reveal steps while an answer streams. */
export const REVEAL_STEP_MS = 40

/**
 * Reveal steps a backlog of words is spread over: one word a step at the
 * steady pace, more when the stream runs ahead, so the reveal never lags far
 * behind the answer.
 */
export const REVEAL_CATCH_UP_STEPS = 8

/** How long a newly revealed word takes to fade in. */
export const WORD_FADE_MS = 420

/** At most this many words fade at once, so a large chunk landing together stays cheap. */
export const MAX_FADING_WORDS = 24

/** A blank line before text that starts at the margin: an indented line after a blank line continues a list item. */
const PARAGRAPH_BREAK = /\n{2,}(?=\S)/
const CODE_FENCE = '```'

/** Schemes and shapes a chat link may use. Anything else loses its href. */
const SAFE_URL = /^(?:(?:https?|mailto|tel):|[#/]|\.{1,2}\/)/i
const WEB_URL = /^https?:\/\//i

// TYPES

/** A run of text that is either one word with the whitespace before it, or trailing whitespace. */
export interface WordToken {
	readonly text: string
	readonly word: boolean
}

/** Remembers when each word of one text block first appeared, so a re-render resumes its fade. */
export interface WordFadeTracker {
	/** Opens a render over `totalWords` words: the first fading one, and how long each has shown. */
	window(totalWords: number): {
		readonly from: number
		readonly elapsedFor: (index: number) => number
	}
}

// FUNCTIONS

/**
 * How much of the text the next reveal step shows: whole words only, one more
 * at the steady pace and a share of the backlog when the stream runs ahead. A
 * word still being written waits until it is whole.
 */
export function nextRevealLength(text: string, shownLength: number): number {
	const wordEnds = wordEndsAfter(text, shownLength)

	if (wordEnds.length === 0) {
		return shownLength
	}

	const step = Math.ceil(wordEnds.length / REVEAL_CATCH_UP_STEPS)

	return wordEnds[step - 1] ?? text.length
}

/**
 * Makes a streaming prefix render as its finished text will: a half-written
 * link shows its label, open bold, italics and code are closed, and a list
 * marker without its text waits for its first word. Only while the text
 * streams: finished text renders as written.
 */
export function trimIncompleteMarkdown(text: string): string {
	const withoutBareMarker = text.replace(/\n[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/, '')

	return closeOpenMarkers(trimIncompleteLink(withoutBareMarker))
}

/** One string per paragraph. A fenced code block may hold blank lines, so text with a fence stays whole. */
export function markdownParagraphs(text: string): readonly string[] {
	if (text.includes(CODE_FENCE)) {
		return [text]
	}

	return text.split(PARAGRAPH_BREAK).filter((paragraph) => paragraph !== '')
}

/** Splits text into tokens that join back to it, each word carrying the whitespace before it. */
export function splitWordTokens(text: string): readonly WordToken[] {
	return (text.match(/\s*\S+|\s+$/g) ?? []).map((token) => ({
		text: token,
		word: /\S/.test(token)
	}))
}

/**
 * Stamps each word the first time a render counts it. Fewer words than before
 * means the text was replaced rather than grown, so all of it counts as settled.
 */
export function createWordFadeTracker(now: () => number): WordFadeTracker {
	let firstSeenAt: number[] = []

	return {
		window(totalWords) {
			const at = now()

			if (totalWords < firstSeenAt.length) {
				firstSeenAt = Array.from(
					{ length: totalWords },
					() => at - WORD_FADE_MS
				)
			}

			for (let index = firstSeenAt.length; index < totalWords; index += 1) {
				firstSeenAt.push(at)
			}

			const elapsedFor = (index: number) =>
				Math.max(0, at - (firstSeenAt[index] ?? at))
			// Words are stamped in order, so the settled ones are a prefix.
			let from = Math.max(0, totalWords - MAX_FADING_WORDS)

			while (from < totalWords && elapsedFor(from) >= WORD_FADE_MS) {
				from += 1
			}

			return { from, elapsedFor }
		}
	}
}

/** Whether a chat link may open: web, mail and phone links, and relative ones. */
export function isSafeUrl(url: string): boolean {
	return SAFE_URL.test(url.trim())
}

/** Whether a chat link is a web link (`http:` or `https:`): the stricter choice where mail, phone and relative links should not open. */
export function isWebUrl(url: string): boolean {
	return WEB_URL.test(url.trim())
}

/** The end of every whole word after `from`; a word is whole once whitespace follows it. */
function wordEndsAfter(text: string, from: number): number[] {
	const wordEnd = /\S+(?=\s)/g
	wordEnd.lastIndex = from

	return Array.from(
		text.matchAll(wordEnd),
		(match) => match.index + match[0].length
	)
}

function trimIncompleteLink(text: string): string {
	const withUrl = /!?\[([^\]]*)\]\([^)]*$/.exec(text)

	if (withUrl) {
		return text.slice(0, withUrl.index) + withUrl[1]
	}

	const withLabel = /!?\[([^\]]*)$/.exec(text)

	if (withLabel) {
		return text.slice(0, withLabel.index) + withLabel[1]
	}

	return text
}

function closeOpenMarkers(text: string): string {
	const fences = countOccurrences(text, CODE_FENCE)

	if (fences % 2 === 1) {
		return `${text}\n${CODE_FENCE}`
	}

	const outsideFences = text.replaceAll(CODE_FENCE, '')
	const inlineCode = countOccurrences(outsideFences, '`') % 2 === 1 ? '`' : ''
	const outsideCode = outsideFences
		.replace(/`[^`]*`?/g, '')
		.replace(/^[ \t]*[*+-][ \t]+/gm, '')
	const bold = countOccurrences(outsideCode, '**') % 2 === 1 ? '**' : ''
	const italic =
		countOccurrences(outsideCode.replaceAll('**', ''), '*') % 2 === 1 ? '*' : ''

	return `${text}${inlineCode}${italic}${bold}`
}

function countOccurrences(text: string, marker: string): number {
	return text.split(marker).length - 1
}
