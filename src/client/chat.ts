/**
 * The AI SDK `Chat` the session owns, with a state any framework can
 * subscribe to: React reads it with `useSyncExternalStore`, Vue mirrors it
 * into a ref. The same state the AI SDK's React chat keeps, with one
 * listener list instead of private callbacks.
 */

import {
	AbstractChat,
	type ChatInit,
	type ChatState,
	type ChatStatus,
	type UIMessage
} from 'ai'
import { createEmitter, throttle } from 'hanzio'

// TYPES

/** What a framework renders from the chat; a new object whenever any of it changes. */
export interface ChatSnapshot<M extends UIMessage = UIMessage> {
	readonly messages: readonly M[]
	readonly status: ChatStatus
	readonly error: Error | undefined
}

// CLASSES

class ObservableChatState<M extends UIMessage> implements ChatState<M> {
	#messages: M[]
	#status: ChatStatus = 'ready'
	#error: Error | undefined = undefined
	#snapshot: ChatSnapshot<M> | undefined
	readonly #changes = createEmitter<{ change: undefined }>()

	constructor(messages: M[] = []) {
		this.#messages = messages
	}

	get messages(): M[] {
		return this.#messages
	}

	set messages(messages: M[]) {
		this.#messages = [...messages]
		this.#notify()
	}

	get status(): ChatStatus {
		return this.#status
	}

	set status(status: ChatStatus) {
		this.#status = status
		this.#notify()
	}

	get error(): Error | undefined {
		return this.#error
	}

	set error(error: Error | undefined) {
		this.#error = error
		this.#notify()
	}

	pushMessage = (message: M): void => {
		this.#messages = this.#messages.concat(message)
		this.#notify()
	}

	popMessage = (): void => {
		this.#messages = this.#messages.slice(0, -1)
		this.#notify()
	}

	replaceMessage = (index: number, message: M): void => {
		this.#messages = [
			...this.#messages.slice(0, index),
			this.snapshot(message),
			...this.#messages.slice(index + 1)
		]
		this.#notify()
	}

	/** A copy of a streaming message: the AI SDK keeps writing into the one it holds. */
	snapshot = <T>(value: T): T => {
		if (
			value === null ||
			typeof value !== 'object' ||
			!('parts' in value) ||
			!Array.isArray(value.parts)
		) {
			return value
		}

		return { ...value, parts: value.parts.map((part: object) => ({ ...part })) }
	}

	getSnapshot = (): ChatSnapshot<M> => {
		this.#snapshot ??= {
			messages: this.#messages,
			status: this.#status,
			error: this.#error
		}

		return this.#snapshot
	}

	subscribe = (listener: () => void): (() => void) =>
		this.#changes.on('change', listener)

	#notify(): void {
		this.#snapshot = undefined
		this.#changes.emit('change')
	}
}

/** The AI SDK chat with a subscribable state. */
export class ObservableChat<
	M extends UIMessage = UIMessage
> extends AbstractChat<M> {
	readonly #state: ObservableChatState<M>

	constructor({ messages, ...init }: ChatInit<M>) {
		const state = new ObservableChatState(messages)

		super({ ...init, state })
		this.#state = state
	}

	/** The messages, status and error as one value that changes identity on every change. */
	readonly getSnapshot = (): ChatSnapshot<M> => this.#state.getSnapshot()

	/** Hears every change of the messages, status or error. */
	readonly subscribe = (listener: () => void): (() => void) =>
		this.#state.subscribe(listener)
}

// FUNCTIONS

/** A subscribe whose listener hears at most one change per `ms`, the last one always: a render throttle for a streaming answer. */
export function throttleSubscribe(
	subscribe: (listener: () => void) => () => void,
	ms: number | undefined
): (listener: () => void) => () => void {
	if (ms === undefined || ms <= 0) {
		return subscribe
	}

	return (listener) => {
		const throttled = throttle(listener, ms)
		const unsubscribe = subscribe(() => throttled())

		return () => {
			throttled.cancel()
			unsubscribe()
		}
	}
}
