/**
 * Draws an answer's markdown in React Native with
 * `react-native-markdown-display`, one renderer per paragraph: a streaming
 * answer only grows at its end, so finished paragraphs keep their rendered
 * tree and only the last one parses again. While it streams, words appear a
 * step at a time, each newly shown word fades in, and half-written markdown
 * is trimmed. Images never load, and only safe links open. Its own subpath,
 * so the React bindings never load React Native.
 */

import {
	type ComponentType,
	createElement,
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useState
} from 'react'
import {
	type StyleProp,
	StyleSheet,
	Text,
	type TextStyle,
	View
} from 'react-native'
import MarkdownDisplay, {
	type MarkdownProps,
	type RenderRules,
	renderRules
} from 'react-native-markdown-display'

import {
	createWordFadeTracker,
	isSafeUrl,
	markdownParagraphs,
	splitWordTokens,
	trimIncompleteMarkdown,
	type WordFadeTracker,
	type WordToken,
	WORD_FADE_MS
} from '../../client/index.js'
import { useWordReveal } from '../index.js'

// TYPES

/** The renderer's styles by element name (`body`, `paragraph`, `strong`, `link`, …); colours come from your theme. */
export type MarkdownStyles = Readonly<Record<string, object>>

export interface StreamingMarkdownProps {
	readonly text: string
	/** The AI SDK is still writing this text: reveal it a step at a time and fade new words in. */
	readonly streaming?: boolean
	readonly style?: MarkdownStyles
	/** The device asks for reduced motion: words appear without fading. */
	readonly reducedMotion?: boolean
	/** Opens a link; return false to keep the renderer from opening it. Only safe links reach it. */
	readonly onLinkPress?: (url: string) => boolean
}

/**
 * One paragraph's fade across its re-parses. The renderer gives every node a
 * new key per parse, so a word's age comes from its position in the paragraph.
 */
interface FadePass {
	readonly tracker: WordFadeTracker
	/** Words counted so far in the parse being rendered. */
	words: number
	window: ReturnType<WordFadeTracker['window']>
	/** Moves the first window into the past, so an already shown paragraph counts as settled. */
	backdateMs: number
}

// CONSTANTS

/** The package's default export: a CommonJS module, so the NodeNext build cannot see its type. */
const Markdown = MarkdownDisplay as unknown as ComponentType<
	MarkdownProps & { readonly children?: string }
>

/** The answer never loads an image, whatever its markdown says. */
const NO_IMAGES: RenderRules = { image: () => null }

/**
 * Fade steps, not display frames: each step lays the paragraph out again, so
 * a handful of steps over a word's fade keeps a streaming answer cheap.
 */
const FADE_STEP_MS = 60

// STATE

const fadeListeners = new Set<(now: number) => void>()
let fadeStepScheduled = false

// COMPONENTS

/** An answer text; a finished one shows whole at once. */
export const StreamingMarkdown = memo(function StreamingMarkdown({
	text,
	streaming = false,
	style,
	reducedMotion = false,
	onLinkPress
}: StreamingMarkdownProps): ReactNode {
	const shown = useWordReveal(text, streaming)
	const source = streaming ? trimIncompleteMarkdown(shown) : shown
	const fadeIn = streaming && !reducedMotion
	const opensLink = useMemo(
		() => (url: string) => isSafeUrl(url) && (onLinkPress?.(url) ?? true),
		[onLinkPress]
	)

	return createElement(
		View,
		null,
		markdownParagraphs(source).map((paragraph, index) =>
			// Paragraphs are only ever appended, so the index stays stable.
			createElement(MarkdownParagraph, {
				key: index,
				source: paragraph,
				style,
				fadeIn,
				onLinkPress: opensLink
			})
		)
	)
})

const MarkdownParagraph = memo(function MarkdownParagraph({
	source,
	style,
	fadeIn,
	onLinkPress
}: {
	readonly source: string
	readonly style: MarkdownStyles | undefined
	readonly fadeIn: boolean
	readonly onLinkPress: (url: string) => boolean
}): ReactNode {
	// A paragraph on screen before the fade starts has been read; one mounted
	// while it runs fades from its first word.
	const [pass] = useState(() => createFadePass({ settled: !fadeIn }))
	const rules = useMemo(
		() => (fadeIn ? fadeRules(pass) : NO_IMAGES),
		[fadeIn, pass]
	)

	return createElement(
		Markdown,
		{ ...(style ? { style } : {}), rules, onLinkPress },
		source
	)
})

function FadingText({
	tokens,
	offset,
	pass,
	style
}: {
	readonly tokens: readonly WordToken[]
	readonly offset: number
	readonly pass: FadePass
	readonly style: StyleProp<TextStyle>
}): ReactNode {
	const color = StyleSheet.flatten(style)?.color
	const { from, elapsedFor } = pass.window
	const pieces: ReactNode[] = []
	let settled = ''
	let index = offset

	for (const token of tokens) {
		if (!token.word || index < from || typeof color !== 'string') {
			settled += token.text
			index += token.word ? 1 : 0
			continue
		}

		if (settled) {
			pieces.push(settled)
		}

		settled = ''
		pieces.push(
			createElement(
				FadingWord,
				{ key: index, color, elapsedMs: elapsedFor(index) },
				token.text
			)
		)
		index += 1
	}

	if (settled) {
		pieces.push(settled)
	}

	return createElement(Text, { style }, pieces)
}

/**
 * A word inside a paragraph's text is part of that text, not a view, so it
 * cannot take an opacity: it fades through its colour's alpha, and is plain
 * text again once settled.
 */
function FadingWord({
	children,
	color,
	elapsedMs
}: {
	readonly children?: string
	readonly color: string
	readonly elapsedMs: number
}): ReactNode {
	const [startedAt] = useState(() => performance.now() - elapsedMs)
	const [progress, setProgress] = useState(() =>
		Math.min(1, elapsedMs / WORD_FADE_MS)
	)
	const done = progress >= 1

	useEffect(() => {
		if (done) {
			return
		}

		return onFadeStep((now) =>
			setProgress(Math.min(1, (now - startedAt) / WORD_FADE_MS))
		)
	}, [done, startedAt])

	if (done) {
		return children ?? null
	}

	// Ease-out cubic.
	const alpha = 1 - (1 - progress) ** 3

	return createElement(
		Text,
		{ style: { color: withAlpha(color, alpha) } },
		children
	)
}

// FUNCTIONS

/** An `rgb()` or `rgba()` colour at the given opacity; any other format is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
	const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color)

	return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color
}

function createFadePass({ settled }: { readonly settled: boolean }): FadePass {
	const pass: FadePass = {
		tracker: createWordFadeTracker(() => performance.now() - pass.backdateMs),
		words: 0,
		window: { from: 0, elapsedFor: () => WORD_FADE_MS },
		backdateMs: settled ? WORD_FADE_MS : 0
	}

	return pass
}

/**
 * The renderer calls a node's rule after its children's, so `body` runs after
 * every `text` of a parse: it knows the paragraph's word count and opens the
 * tracker's window before React renders the texts the rules returned.
 */
function fadeRules(pass: FadePass): RenderRules {
	return {
		...NO_IMAGES,
		text: (node, _children, _parent, styles, inheritedStyles = {}) => {
			const tokens = splitWordTokens(node.content)
			const offset = pass.words
			pass.words += tokens.filter((token) => token.word).length

			return createElement(FadingText, {
				key: node.key,
				tokens,
				offset,
				pass,
				style: [inheritedStyles, styles.text]
			})
		},
		body: (node, children, parent, styles) => {
			pass.window = pass.tracker.window(pass.words)
			pass.words = 0
			pass.backdateMs = 0

			return renderRules.body?.(node, children, parent, styles)
		}
	}
}

/** One timer for every fading word, running while any listens. */
function onFadeStep(listener: (now: number) => void): () => void {
	fadeListeners.add(listener)

	if (!fadeStepScheduled) {
		fadeStepScheduled = true
		setTimeout(runFadeStep, FADE_STEP_MS)
	}

	return () => {
		fadeListeners.delete(listener)
	}
}

function runFadeStep(): void {
	const now = performance.now()

	for (const listener of fadeListeners) {
		listener(now)
	}

	fadeStepScheduled = fadeListeners.size > 0

	if (fadeStepScheduled) {
		setTimeout(runFadeStep, FADE_STEP_MS)
	}
}
