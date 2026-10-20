/**
 * Which screen the chat is about: a stack of the screens, cards and drawers
 * that registered a context, ordered by focus rather than mount, because tabs
 * stay mounted. The chat's own modal never registers, so the screen the user
 * came from stays on top; a chat tab goes on top as no screen. Each entry
 * reads its context through a function when a request goes out, so a screen
 * whose data changes never registers again.
 */

import type { ClientAction } from './actions.js'

// TYPES

/** What one screen tells the chat while it is on top. */
export interface ScreenEntry<T> {
	/** Read when a request goes out, so the screen's data is current. */
	readonly read: () => T
	/** The client actions this screen offers; they win over the app's own of the same name. */
	readonly actions?: readonly ClientAction[] | undefined
}

export interface ScreenContextStack<T> {
	/** Puts the entry on top, adding it when it is not on the stack. */
	readonly focus: (instanceId: string, entry: ScreenEntry<T>) => void
	/** Puts a chat that is about no screen on top: while it has focus, requests carry no context. */
	readonly focusNone: (instanceId: string) => void
	/** Takes the entry off the stack. */
	readonly leave: (instanceId: string) => void
	/**
	 * Pins the top entry's context, read now: an ask button opens the chat
	 * with it, and it holds while that chat is open, even after the drawer it
	 * came from has closed.
	 */
	readonly pinTop: () => void
	readonly unpin: () => void
	/** The context a request carries: the pinned one, or the top entry's, read now. */
	readonly read: () => T | undefined
	/** The actions of the screen `read` reads. */
	readonly actions: () => readonly ClientAction[]
	readonly subscribe: (listener: () => void) => () => void
}

interface StackItem<T> {
	readonly instanceId: string
	/** Undefined for a chat that is about no screen. */
	readonly entry: ScreenEntry<T> | undefined
}

interface Pinned<T> {
	readonly value: T
	readonly actions: readonly ClientAction[]
}

// CONSTANTS

const NO_ACTIONS: readonly ClientAction[] = []

// FUNCTIONS

/** An empty stack: no screen until one focuses. */
export function createScreenContextStack<T>(): ScreenContextStack<T> {
	const listeners = new Set<() => void>()
	let stack: readonly StackItem<T>[] = []
	let pinned: Pinned<T> | undefined

	const commit = (next: readonly StackItem<T>[]) => {
		stack = next

		for (const listener of listeners) {
			listener()
		}
	}

	const putOnTop = (instanceId: string, entry: ScreenEntry<T> | undefined) => {
		commit([
			...stack.filter((item) => item.instanceId !== instanceId),
			{ instanceId, entry }
		])
	}

	const top = () => stack.at(-1)?.entry

	return {
		focus: putOnTop,
		focusNone: (instanceId) => putOnTop(instanceId, undefined),
		leave: (instanceId) => {
			if (stack.some((item) => item.instanceId === instanceId)) {
				commit(stack.filter((item) => item.instanceId !== instanceId))
			}
		},
		pinTop: () => {
			const entry = top()

			pinned =
				entry === undefined
					? undefined
					: { value: entry.read(), actions: entry.actions ?? NO_ACTIONS }
			commit(stack)
		},
		unpin: () => {
			pinned = undefined
			commit(stack)
		},
		read: () => (pinned === undefined ? top()?.read() : pinned.value),
		actions: () => pinned?.actions ?? top()?.actions ?? NO_ACTIONS,
		subscribe: (listener) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		}
	}
}
