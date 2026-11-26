/**
 * Vue bindings for a chat session: the session's state and the chat's
 * messages as refs, the screen context a page registers while it is shown,
 * the streaming word reveal, and the tool cards of a message.
 */

import type { UIMessage } from 'ai'
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
	onDeactivated,
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
	ChangePlanState,
	ChangePlanStore,
	ChatSession,
	ChatSessionSnapshot,
	DatasetState,
	DatasetStore,
	ChatSessions,
	ChatSnapshot,
	PendingChange,
	ScreenContextStack,
	ScreenEntry,
	ToolPart
} from '../client/index.js'
import {
	DEFAULT_CHAT_THROTTLE_MS,
	nextRevealLength,
	pendingApproval,
	REVEAL_STEP_MS,
	throttleChatSubscribe
} from '../client/index.js'

// TYPES

export interface UseChatSessionOptions {
	/** How often a streaming answer updates the refs at most (default 40 ms); pass `0` for every change. Status and message-count changes always flush immediately. */
	readonly throttleMs?: number
}

export interface ChatSessionRefs extends Pick<
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
	readonly answerComplete: ComputedRef<ChatSessionSnapshot['answerComplete']>
}

export interface LoadedChatThread {
	readonly messages: readonly UIMessage[]
	readonly pendingChanges?: readonly PendingChange[]
}

export interface UseChatThreadOptions extends UseChatSessionOptions {
	readonly sessions: ChatSessions
	readonly threadId: MaybeRefOrGetter<string>
	/** Loads the thread's stored messages and pending changes whenever `threadId` changes or `reload()` runs. */
	readonly load?: (
		threadId: string,
		options: { readonly signal: AbortSignal }
	) => Promise<LoadedChatThread | undefined>
}

export interface ChatThreadRefs extends ChatSessionRefs {
	readonly threadId: ComputedRef<string>
	readonly session: ComputedRef<ChatSession>
	/** The first waiting approval of the active thread's turn, or `null` when none waits. */
	readonly pendingApproval: ComputedRef<Extract<
		PendingChange,
		{ kind: 'approval' }
	> | null>
	readonly loading: ComputedRef<boolean>
	readonly loadError: ComputedRef<unknown>
	readonly reload: () => Promise<void>
}

/** The component for each card kind, which gets the card as its `card` prop; `silent` draws nothing and needs none. */
export type CardComponents<S extends CardSchemas> = {
	readonly [K in Exclude<Card<S>['kind'], 'silent'>]: Component
}

export interface ToolPartsProps<S extends CardSchemas> {
	readonly parts: readonly ToolPart[]
	readonly registry: Pick<CardRegistry<S>, 'fold'>
	readonly cards: CardComponents<S>
	/** Wraps each run of steps, such as an activity list; it gets the run as its `cards` prop. */
	readonly steps?: Component
}

// COMPOSABLES

/**
 * The chat's messages, status and error, and the session's turn, as
 * computed refs. Accepts either a single `ChatSession` or a reactive getter/ref
 * to switch sessions cleanly. A session with `resume` reattaches to a running
 * answer once mounted (SSR-safe).
 */
export function useChatSession(
	session: MaybeRefOrGetter<ChatSession>,
	options: UseChatSessionOptions = {}
): ChatSessionRefs {
	const throttleMs = options.throttleMs ?? DEFAULT_CHAT_THROTTLE_MS
	const current = () => toValue(session)
	const chat = shallowRef(current().chat.getSnapshot())
	const snapshot = shallowRef(current().getSnapshot())
	const inComponent = getCurrentInstance() !== null
	let mounted = !inComponent
	let unsubscribeChat: (() => void) | undefined
	let unsubscribeSession: (() => void) | undefined

	const detach = () => {
		unsubscribeChat?.()
		unsubscribeSession?.()
		unsubscribeChat = undefined
		unsubscribeSession = undefined
	}

	const attach = (target: ChatSession) => {
		detach()
		chat.value = target.chat.getSnapshot()
		snapshot.value = target.getSnapshot()
		unsubscribeChat = throttleChatSubscribe(
			target.chat,
			throttleMs
		)(() => {
			chat.value = target.chat.getSnapshot()
		})
		unsubscribeSession = target.subscribe(() => {
			snapshot.value = target.getSnapshot()
		})
		if (mounted) {
			target.resumeStream()
		}
	}

	watch(current, attach, { immediate: true })

	if (inComponent) {
		onMounted(() => {
			mounted = true
			current().resumeStream()
		})
	}

	if (getCurrentScope() !== undefined) {
		onScopeDispose(detach)
	}

	return {
		messages: computed(() => chat.value.messages),
		status: computed(() => chat.value.status),
		error: computed(() => chat.value.error),
		turn: computed(() => snapshot.value.turn),
		restoredDraft: computed(() => snapshot.value.restoredDraft),
		changeMarks: computed(() => snapshot.value.changeMarks),
		replySuggestions: computed(() => snapshot.value.replySuggestions),
		answerComplete: computed(() => snapshot.value.answerComplete),
		send: (...args) => current().send(...args),
		stop: () => current().stop(),
		tryAgain: () => current().tryAgain(),
		regenerate: (...args) => current().regenerate(...args),
		answerApproval: (...args) => current().answerApproval(...args),
		resumeRun: (...args) => current().resumeRun(...args),
		clearRestoredDraft: (...args) => current().clearRestoredDraft(...args),
		showStored: (...args) => current().showStored(...args),
		resumeStream: () => current().resumeStream()
	}
}

/**
 * Binds a reactive `threadId` to a `ChatSessions` registry: switches focus,
 * subscribes to the active session's refs, and loads stored history with a
 * race-safe stale-load guard.
 */
export function useChatThread(options: UseChatThreadOptions): ChatThreadRefs {
	const threadId = computed(() => toValue(options.threadId))
	const session = computed(() => options.sessions.get(threadId.value))
	const refs = useChatSession(session, options)
	const loading = shallowRef(false)
	const loadError = shallowRef<unknown>(undefined)
	const inComponent = getCurrentInstance() !== null
	let mounted = !inComponent
	let loadToken = 0
	let loadController: AbortController | undefined

	const abortLoad = () => {
		loadController?.abort()
		loadController = undefined
	}

	const reload = async (): Promise<void> => {
		abortLoad()
		loadToken += 1
		const token = loadToken
		const id = threadId.value
		const target = session.value

		if (!options.load) {
			loading.value = false
			loadError.value = undefined
			return
		}

		const controller = new AbortController()
		loadController = controller
		loading.value = true
		loadError.value = undefined

		try {
			const loaded = await options.load(id, { signal: controller.signal })
			if (token !== loadToken || controller.signal.aborted) {
				return
			}

			if (loaded !== undefined) {
				target.showStored({
					messages: [...loaded.messages],
					pendingChanges: loaded.pendingChanges ?? []
				})
			}
		} catch (error) {
			if (token === loadToken && !controller.signal.aborted) {
				loadError.value = error
			}
		} finally {
			if (token === loadToken) {
				loading.value = false
				if (loadController === controller) {
					loadController = undefined
				}
			}
		}
	}

	const activate = (id: string) => {
		if (!mounted) return
		options.sessions.focus(id)
		void reload()
	}

	watch(threadId, activate, { immediate: true })

	if (inComponent) {
		onMounted(() => {
			mounted = true
			activate(threadId.value)
		})
	}

	if (getCurrentScope() !== undefined) {
		onScopeDispose(() => {
			loadToken += 1
			abortLoad()
		})
	}

	return {
		...refs,
		threadId,
		session,
		pendingApproval: computed(() => pendingApproval(refs.turn.value)),
		loading: computed(() => loading.value),
		loadError: computed(() => loadError.value),
		reload
	}
}

/**
 * Tells the chat what this page shows: on top when it mounts, again when a
 * kept-alive page is shown again, off the stack when it unmounts, deactivates,
 * or `enabled` turns false (a drawer that closed).
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
		onDeactivated(() => stack.leave(instanceId))
	}

	watch(() => toValue(options.enabled ?? true), sync)

	if (getCurrentScope() !== undefined) {
		onScopeDispose(() => stack.leave(instanceId))
	}
}

/**
 * The part of a streaming text to show: a step of whole words every 40 ms,
 * catching up when the stream runs ahead; all of it once streaming ends.
 * Stops its timer whenever caught up so idle/paused streams burn no CPU.
 */
export function useWordReveal(
	text: MaybeRefOrGetter<string>,
	streaming: MaybeRefOrGetter<boolean>
): Readonly<ShallowRef<string>> {
	let prevStreaming = toValue(streaming)
	let shownLength = prevStreaming ? 0 : toValue(text).length
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
				prevStreaming = false
				stopTimer()
				shownLength = current.length
				shown.value = current

				return
			}

			if (!prevStreaming || current.length < shownLength) {
				shownLength = 0
				shown.value = ''
			}
			prevStreaming = true

			if (nextRevealLength(current, shownLength) <= shownLength) {
				stopTimer()
				return
			}

			timer ??= setInterval(() => {
				const latest = toValue(text)
				const next = nextRevealLength(latest, shownLength)
				if (next <= shownLength) {
					stopTimer()
					return
				}
				shownLength = next
				shown.value = latest.slice(0, shownLength)
				if (nextRevealLength(latest, shownLength) <= shownLength) {
					stopTimer()
				}
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

const ToolPartsImpl = defineComponent({
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

/** Draws the cards of neighbouring tool parts, with each run of steps folded into `steps` when given. */
export const ToolParts = ToolPartsImpl as unknown as new <
	S extends CardSchemas = CardSchemas
>(
	props: ToolPartsProps<S>
) => {
	$props: ToolPartsProps<S>
}

// FUNCTIONS

let nextInstanceId = 0

export interface ChangePlanRefs {
	readonly state: ComputedRef<ChangePlanState>
	readonly plan: ComputedRef<ChangePlanState['plan']>
	readonly phase: ComputedRef<ChangePlanState['phase']>
	readonly runningStep: ComputedRef<ChangePlanState['runningStep']>
	readonly refusal: ComputedRef<ChangePlanState['refusal']>
	readonly failed: ComputedRef<boolean>
	/** Applies the plan; progress arrives in `plan` step by step. */
	readonly confirm: () => Promise<void>
	readonly discard: () => Promise<void>
}

/**
 * One change plan as refs, loaded when its ids are set: its steps and
 * status, what this window is doing with it, and the user's two answers.
 * Draw the card from `readProposedChangePlans(message)` until `plan` has
 * loaded.
 */
export function useChangePlan(
	store: ChangePlanStore,
	threadId: MaybeRefOrGetter<string>,
	planId: MaybeRefOrGetter<string>
): ChangePlanRefs {
	const state = shallowRef(store.get(toValue(planId)))
	const unsubscribe = store.subscribe(() => {
		state.value = store.get(toValue(planId))
	})

	watch(
		() => [toValue(threadId), toValue(planId)] as const,
		([thread, plan]) => {
			state.value = store.get(plan)
			void store.load(thread, plan)
		},
		{ immediate: true }
	)

	if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe)

	const current = computed(() => state.value)

	return {
		state: current,
		plan: computed(() => state.value.plan),
		phase: computed(() => state.value.phase),
		runningStep: computed(() => state.value.runningStep),
		refusal: computed(() => state.value.refusal),
		failed: computed(() => state.value.failed),
		confirm: () => store.confirm(toValue(threadId), toValue(planId)),
		discard: () => store.discard(toValue(threadId), toValue(planId))
	}
}

export interface DatasetRefs {
	readonly state: ComputedRef<DatasetState>
	readonly dataset: ComputedRef<DatasetState['dataset']>
	readonly missing: ComputedRef<boolean>
	readonly failed: ComputedRef<boolean>
	readonly reload: () => Promise<void>
}

/**
 * One dataset as refs, loaded when its ids are set unless the stream already
 * brought it: the rows a display part names by id.
 */
export function useDataset(
	store: DatasetStore,
	threadId: MaybeRefOrGetter<string>,
	datasetId: MaybeRefOrGetter<string>
): DatasetRefs {
	const state = shallowRef(store.get(toValue(datasetId)))
	const unsubscribe = store.subscribe(() => {
		state.value = store.get(toValue(datasetId))
	})

	watch(
		() => [toValue(threadId), toValue(datasetId)] as const,
		([thread, dataset]) => {
			state.value = store.get(dataset)
			void store.load(thread, dataset)
		},
		{ immediate: true }
	)

	if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe)

	return {
		state: computed(() => state.value),
		dataset: computed(() => state.value.dataset),
		missing: computed(() => state.value.missing),
		failed: computed(() => state.value.failed),
		reload: () =>
			store.load(toValue(threadId), toValue(datasetId), { force: true })
	}
}
