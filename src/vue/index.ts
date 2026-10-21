/**
 * Vue bindings for a chat session: the session's state and the chat's
 * messages as refs, the screen context a page registers while it is shown,
 * the streaming word reveal, and the tool cards of a message.
 */

import {
	type Component,
	type ComputedRef,
	computed,
	defineComponent,
	Fragment,
	getCurrentInstance,
	getCurrentScope,
	h,
	type MaybeRefOrGetter,
	onActivated,
	onMounted,
	onScopeDispose,
	type PropType,
	type ShallowRef,
	shallowRef,
	toValue,
	watch
} from 'vue'

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
	/** How often a streaming answer updates the refs at most; every change when left out. */
	readonly throttleMs?: number
}

export interface ChatSessionRefs
	extends Pick<
		ChatSession,
		| 'send'
		| 'stop'
		| 'tryAgain'
		| 'regenerate'
		| 'answerApproval'
		| 'resumeRun'
		| 'clearRestoredDraft'
		| 'showStored'
		| 'resumeStream'
	> {
	readonly messages: ComputedRef<ChatSnapshot['messages']>
	readonly status: ComputedRef<ChatSnapshot['status']>
	readonly error: ComputedRef<ChatSnapshot['error']>
	readonly turn: ComputedRef<ChatSessionSnapshot['turn']>
	readonly restoredDraft: ComputedRef<ChatSessionSnapshot['restoredDraft']>
	readonly changeMarks: ComputedRef<ChatSessionSnapshot['changeMarks']>
	readonly replySuggestions: ComputedRef<
		ChatSessionSnapshot['replySuggestions']
	>
}

/** The component for each card kind, which gets the card as its `card` prop; `silent` draws nothing and needs none. */
export type CardComponents<S extends CardSchemas> = {
	readonly [K in Exclude<Card<S>['kind'], 'silent'>]: Component
}

// COMPOSABLES

/**
 * The chat's messages, status and error, and the session's turn, as
 * computed refs. A session with `resume`
 * reattaches to a running answer when this runs.
 */
export function useChatSession(
	session: ChatSession,
	options: UseChatSessionOptions = {}
): ChatSessionRefs {
	const chat = shallowRef(session.chat.getSnapshot())
	const snapshot = shallowRef(session.getSnapshot())
	const unsubscribeChat = throttleSubscribe(
		session.chat.subscribe,
		options.throttleMs
	)(() => {
		chat.value = session.chat.getSnapshot()
	})
	const unsubscribeSession = session.subscribe(() => {
		snapshot.value = session.getSnapshot()
	})

	if (getCurrentScope() !== undefined) {
		onScopeDispose(() => {
			unsubscribeChat()
			unsubscribeSession()
		})
	}

	session.resumeStream()

	return {
		messages: computed(() => chat.value.messages),
		status: computed(() => chat.value.status),
		error: computed(() => chat.value.error),
		turn: computed(() => snapshot.value.turn),
		restoredDraft: computed(() => snapshot.value.restoredDraft),
		changeMarks: computed(() => snapshot.value.changeMarks),
		replySuggestions: computed(() => snapshot.value.replySuggestions),
		send: session.send,
		stop: session.stop,
		tryAgain: session.tryAgain,
		regenerate: session.regenerate,
		answerApproval: session.answerApproval,
		resumeRun: session.resumeRun,
		clearRestoredDraft: session.clearRestoredDraft,
		showStored: session.showStored,
		resumeStream: session.resumeStream
	}
}

/**
 * Tells the chat what this page shows: on top when it mounts, again when a
 * kept-alive page is shown again, off the stack when it unmounts or
 * `enabled` turns false (a drawer that closed).
 */
export function useScreenContext<T>(
	stack: ScreenContextStack<T>,
	entry: ScreenEntry<T>,
	options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {}
): void {
	nextInstanceId += 1
	const instanceId = `screen-${nextInstanceId}`
	const sync = () => {
		if (toValue(options.enabled ?? true)) {
			stack.focus(instanceId, entry)
		} else {
			stack.leave(instanceId)
		}
	}

	if (getCurrentInstance() === null) {
		sync()
	} else {
		onMounted(sync)
		onActivated(sync)
	}

	watch(() => toValue(options.enabled ?? true), sync)

	if (getCurrentScope() !== undefined) {
		onScopeDispose(() => stack.leave(instanceId))
	}
}

/**
 * The part of a streaming text to show: a step of whole words every 40 ms,
 * catching up when the stream runs ahead; all of it once streaming ends.
 */
export function useWordReveal(
	text: MaybeRefOrGetter<string>,
	streaming: MaybeRefOrGetter<boolean>
): Readonly<ShallowRef<string>> {
	let shownLength = toValue(streaming) ? 0 : toValue(text).length
	const shown = shallowRef(toValue(text).slice(0, shownLength))
	let timer: ReturnType<typeof setInterval> | undefined

	const stopTimer = () => {
		clearInterval(timer)
		timer = undefined
	}

	watch(
		[() => toValue(text), () => toValue(streaming)],
		([current, isStreaming]) => {
			if (!isStreaming) {
				stopTimer()
				shownLength = current.length
				shown.value = current

				return
			}

			timer ??= setInterval(() => {
				shownLength = nextRevealLength(toValue(text), shownLength)
				shown.value = toValue(text).slice(0, shownLength)
			}, REVEAL_STEP_MS)
		},
		{ immediate: true }
	)

	if (getCurrentScope() !== undefined) {
		onScopeDispose(stopTimer)
	}

	return shown
}

// COMPONENTS

/** Draws the cards of neighbouring tool parts, with each run of steps folded into `steps` when given. */
export const ToolParts = defineComponent({
	name: 'ToolParts',
	props: {
		parts: { type: Array as PropType<readonly ToolPart[]>, required: true },
		/** Only `fold` is read, which every registry's narrower cards fit. */
		registry: {
			type: Object as PropType<Pick<CardRegistry<CardSchemas>, 'fold'>>,
			required: true
		},
		cards: {
			type: Object as PropType<CardComponents<CardSchemas>>,
			required: true
		},
		/** Wraps each run of steps, such as an activity list; it gets the run as its `cards` prop. */
		steps: {
			type: [Object, Function] as PropType<Component>,
			default: undefined
		}
	},
	setup(props) {
		const drawCard = (card: Card<CardSchemas>) =>
			card.kind === 'silent'
				? null
				: h(props.cards[card.kind] as Component, {
						key: card.part.toolCallId,
						card
					})

		return () =>
			h(
				Fragment,
				props.registry.fold(props.parts).map((item) => {
					if (item.kind === 'card') {
						return drawCard(item.card)
					}

					const drawn = item.cards.map(drawCard)

					return props.steps === undefined
						? h(Fragment, { key: item.key }, drawn)
						: h(props.steps, { key: item.key, cards: item.cards }, () => drawn)
				})
			)
	}
})

// FUNCTIONS

let nextInstanceId = 0
