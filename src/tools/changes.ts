/**
 * A write tool's change: what its confirm card shows, what it reads before
 * the write, and the result it returns with a record of how to undo it. Undo
 * writes the previous value back only while the target still holds the value
 * the change wrote, so a later edit by the user is never overwritten.
 */

import type { RequestContext } from '@mastra/core/request-context'
import { stableStringify } from 'hanzio'

/** One call of a write tool: its input, hidden inputs filled, and the run's request context. */
export interface ToolChangeCall<TInput = unknown> {
	readonly input: TInput
	readonly requestContext: RequestContext | undefined
}

/**
 * What a write tool adds around its `execute`. The tool runs the guard, reads
 * the target, executes, then builds the result the client and the model get.
 */
export interface ToolChange<
	TInput = unknown,
	TOutput = unknown,
	TBefore = unknown,
	TResult = unknown
> {
	/** How the confirm card shows each input field; reaches the client as the manifest's `confirmFields`. */
	readonly confirmFields?: readonly unknown[]
	/** A sentence for the model when the change must not run; `execute` is then not called. */
	readonly guard?: (
		call: ToolChangeCall<TInput>
	) => Promise<string | undefined> | string | undefined
	/** What Undo needs from before the write. */
	readonly readBefore: (call: ToolChangeCall<TInput>) => Promise<TBefore>
	/**
	 * The change's result, with its undo record: the target and its value
	 * before and after. It runs after the write, so a failure here reaches the
	 * model as `unreadSentence`, never as "nothing changed".
	 */
	readonly toResult: (
		call: ToolChangeCall<TInput> & {
			readonly before: TBefore
			readonly output: TOutput
		}
	) => Promise<TResult> | TResult
	/** What the model reads when the write happened but its result could not be built. Default `CHANGE_UNREAD_SENTENCE`. */
	readonly unreadSentence?: string
	/** The error `toResult` threw, for the log. */
	readonly onUnread?: (error: unknown, event: { readonly tool: string }) => void
}

export const CHANGE_UNREAD_SENTENCE =
	'The change was made, but it could not be read back, so it cannot be undone from the chat.'

/** What an Undo did, counted per target. */
export interface UndoTally {
	/** Targets written back now. */
	readonly undone: number
	/** Targets that already held their previous value: Undo ran before. */
	readonly alreadyUndone: number
	/** Targets left alone because they hold neither value: someone changed them since. */
	readonly changedSince: number
	/** Targets whose write back failed. */
	readonly failed: number
}

export type UndoOutcome = keyof UndoTally

export const NO_UNDO: UndoTally = {
	undone: 0,
	alreadyUndone: 0,
	changedSince: 0,
	failed: 0
}

/** The outcomes counted, on top of `tally` when given. */
export function tallyUndo(
	outcomes: readonly UndoOutcome[],
	tally: UndoTally = NO_UNDO
): UndoTally {
	const counted = { ...tally }
	for (const outcome of outcomes) {
		counted[outcome] += 1
	}
	return counted
}

/** What applying one target of a change plan did. */
export type ApplyOutcome =
	'applied' | 'alreadyApplied' | 'changedSince' | 'failed'

/** The JSON-with-sorted-keys comparison `undoTarget` and `applyTarget` use by default. */
export function sameValue(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right)
}

/**
 * Applies one target of a change plan, the mirror of `undoTarget`: reads what
 * it holds now and writes `next` only while it still holds `seen`, the value
 * the plan was made against. A target that already holds `next` is
 * `alreadyApplied`: an earlier run wrote it before it was interrupted, so a
 * resumed plan counts it done instead of refusing it as changed. A read that
 * throws is the caller's to count; a write that throws is `failed`, with the
 * error handed to `onError`.
 */
export async function applyTarget<T>(target: {
	readonly read: () => Promise<T | undefined>
	readonly seen: T
	readonly next: T
	readonly write: (next: T) => Promise<unknown>
	readonly equals?: (left: T | undefined, right: T) => boolean
	readonly onError?: (error: unknown) => void
}): Promise<ApplyOutcome> {
	const equals = target.equals ?? sameValue
	const current = await target.read()

	if (equals(current, target.next)) return 'alreadyApplied'

	if (!equals(current, target.seen)) return 'changedSince'

	try {
		await target.write(target.next)

		return 'applied'
	} catch (error) {
		target.onError?.(error)

		return 'failed'
	}
}

/**
 * Undoes one target of a change: reads what it holds now and writes
 * `previous` back only while it still holds `next`, the value the change
 * wrote. Values are compared as JSON with sorted keys unless `equals` says
 * otherwise. A read that throws is the caller's to count; a write that throws
 * is `failed`, with the error handed to `onError`.
 */
export async function undoTarget<T>(target: {
	readonly read: () => Promise<T | undefined>
	readonly previous: T
	readonly next: T
	readonly write: (previous: T) => Promise<unknown>
	readonly equals?: (left: T | undefined, right: T) => boolean
	readonly onError?: (error: unknown) => void
}): Promise<UndoOutcome> {
	const equals = target.equals ?? sameValue
	const current = await target.read()

	if (equals(current, target.previous)) return 'alreadyUndone'

	if (!equals(current, target.next)) return 'changedSince'

	try {
		await target.write(target.previous)

		return 'undone'
	} catch (error) {
		target.onError?.(error)

		return 'failed'
	}
}
