/**
 * React bindings for a chat session: the session's state and the chat's
 * messages as hook state, the screen context a screen registers while it has
 * focus, the streaming word reveal, and the tool cards of a message. Works
 * the same in React Native: nothing here touches the DOM.
 */

import {
	type ComponentType,
	createElement,
	type EffectCallback,
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore
} from 'react'

import type {
	Card,
	CardRegistry,
	CardSchemas,
	ChatSession,
	ChatSessionSnapshot,
	ChatSnapshot,
	ScreenContextStack,
	ScreenEntry,
	ToolPart
} from '../client/index.js'
import {
	nextRevealLength,
	REVEAL_STEP_MS,
	throttleSubscribe
} from '../client/index.js'

// TYPES

export interface UseChatSessionOptions {
	/** How often a streaming answer re-renders at most; every change when left out. */
	readonly throttleMs?: number
}

export type ChatSessionState = ChatSnapshot &
	ChatSessionSnapshot &
	Pick<
		ChatSession,
		| 'send'
		| 'stop'
		| 'tryAgain'
		| 'answerApproval'
		| 'resumeRun'
		| 'clearRestoredDraft'
		| 'showStored'
		| 'resumeStream'
	>

/** A focus effect such as expo-router's `useFocusEffect`: runs the callback whenever the screen gains focus. */
export type UseFocusEffect = (effect: EffectCallback) => void

export interface UseScreenContextOptions {
	/** Your router's focus hook, such as expo-router's `useFocusEffect`; without one the screen goes on top when it mounts. */
	readonly useFocusEffect?: UseFocusEffect
	/** False takes the screen off the stack, for a drawer that is closed. */
	readonly enabled?: boolean
}

/** The component for each card kind; `silent` draws nothing and needs none. */
export type CardComponents<S extends CardSchemas> = {
	readonly [K in Exclude<Card<S>['kind'], 'silent'>]: ComponentType<{
		readonly card: Extract<Card<S>, { kind: K }>
	}>
}

export interface ToolPartsProps<S extends CardSchemas> {
	/** Neighbouring tool parts of one message, such as a `tools` block of `toMessageBlocks`. */
	readonly parts: readonly ToolPart[]
	readonly registry: CardRegistry<S>
	readonly cards: CardComponents<S>
	/** Wraps each run of steps, such as an activity list; the steps draw one after another when left out. */
	readonly Steps?: ComponentType<{
		readonly cards: readonly Card<S>[]
		readonly children?: ReactNode
	}>
}

// HOOKS

/**
 * The session's turn and the chat's messages as hook state. The returned
 * functions keep their identity, so message rows do not re-render on every
 * chunk. A session with `resume` reattaches to a running answer on mount.
 */
export function useChatSession(
	session: ChatSession,
	options: UseChatSessionOptions = {}
): ChatSessionState {
	const { throttleMs } = options
	const subscribeChat = useMemo(
		() => throttleSubscribe(session.chat.subscribe, throttleMs),
		[session, throttleMs]
	)
	const chat = useSyncExternalStore(subscribeChat, session.chat.getSnapshot)
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)

	useEffect(() => {
		session.resumeStream()
	}, [session])

	return {
		...chat,
		...snapshot,
		send: session.send,
		stop: session.stop,
		tryAgain: session.tryAgain,
		answerApproval: session.answerApproval,
		resumeRun: session.resumeRun,
		clearRestoredDraft: session.clearRestoredDraft,
		showStored: session.showStored,
		resumeStream: session.resumeStream
	}
}

/**
 * Tells the chat what this screen shows while it is mounted, on top whenever
 * it gains focus. The entry is read through the latest one rendered, so a
 * screen never registers again as its data changes.
 */
export function useScreenContext<T>(
	stack: ScreenContextStack<T>,
	entry: ScreenEntry<T>,
	options: UseScreenContextOptions = {}
): void {
	const instanceId = useId()
	const enabled = options.enabled ?? true
	const latest = useRef(entry)
	latest.current = entry

	const registered = useMemo<ScreenEntry<T>>(
		() => ({
			read: () => latest.current.read(),
			get actions() {
				return latest.current.actions
			}
		}),
		[]
	)

	const useFocus = options.useFocusEffect ?? useMountEffect

	useFocus(
		useCallback(() => {
			if (enabled) {
				stack.focus(instanceId, registered)
			} else {
				stack.leave(instanceId)
			}
		}, [enabled, instanceId, registered, stack])
	)

	useEffect(() => () => stack.leave(instanceId), [instanceId, stack])
}

/**
 * The part of a streaming text to show: a step of whole words every 40 ms,
 * catching up when the stream runs ahead; all of it once streaming ends.
 */
export function useWordReveal(text: string, streaming: boolean): string {
	const [shownLength, setShownLength] = useState(() =>
		streaming ? 0 : text.length
	)
	const textRef = useRef(text)
	textRef.current = text

	useEffect(() => {
		if (!streaming) {
			return
		}

		const timer = setInterval(() => {
			setShownLength((length) => nextRevealLength(textRef.current, length))
		}, REVEAL_STEP_MS)

		return () => clearInterval(timer)
	}, [streaming])

	return streaming ? text.slice(0, shownLength) : text
}

// COMPONENTS

/** Draws the cards of neighbouring tool parts, with each run of steps folded. */
export function ToolParts<S extends CardSchemas>({
	parts,
	registry,
	cards,
	Steps
}: ToolPartsProps<S>): ReactNode {
	return createElement(
		Fragment,
		null,
		registry.fold(parts).map((item) => {
			if (item.kind === 'card') {
				return drawCard(item.key, item.card, cards)
			}

			const drawn = item.cards.map((card) =>
				drawCard(card.part.toolCallId, card, cards)
			)

			return Steps === undefined
				? createElement(Fragment, { key: item.key }, drawn)
				: createElement(Steps, { key: item.key, cards: item.cards }, drawn)
		})
	)
}

// FUNCTIONS

function drawCard<S extends CardSchemas>(
	key: string,
	card: Card<S>,
	cards: CardComponents<S>
): ReactNode {
	if (card.kind === 'silent') {
		return null
	}

	// The registry resolved `card` for its own kind, so its component takes it.
	const component = cards[
		card.kind as Exclude<Card<S>['kind'], 'silent'>
	] as ComponentType<{
		readonly card: Card<S>
	}>

	return createElement(component, { key, card })
}

function useMountEffect(effect: EffectCallback): void {
	useEffect(effect, [effect])
}
