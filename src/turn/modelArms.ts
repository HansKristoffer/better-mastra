import { hasKey } from 'hanzio'
/**
 * Model experiments by thread. A thread gets its arm at its first turn, the
 * arm is stored in the thread's metadata, and the thread keeps it for its
 * whole life, wherever the conversation goes: switching mid-conversation
 * would mix the arms' numbers and drop the cached history.
 */

/** A thread's own place in [0, 1), the same on every turn: `threadBucket(id) < share` splits threads by share. */
export function threadBucket(threadId: string): number {
	let hash = 0

	for (const character of threadId) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0
	}

	return (hash % 1000) / 1000
}

export interface ModelArms<TArms extends Record<string, unknown>, TInput> {
	readonly arms: TArms
	/** The metadata key the arm is stored under. */
	readonly metadataKey: string
	/** The arm stored on a thread; null for a thread without one (new, or from before arms). */
	stored(
		metadata: Readonly<Record<string, unknown>> | null | undefined
	): (keyof TArms & string) | null
	/** The thread's arm: the stored one, else a new assignment. Store `{ [metadataKey]: name }` on the thread. */
	resolve(
		input: TInput & {
			readonly metadata: Readonly<Record<string, unknown>> | null | undefined
		}
	): { readonly name: keyof TArms & string } & TArms[keyof TArms]
}

export function defineModelArms<
	const TArms extends Record<string, unknown>,
	TInput extends { readonly threadId: string }
>(options: {
	readonly arms: TArms
	/** The arm for a thread's first turn, such as `threadBucket(threadId) < 0.5 ? 'fast' : 'default'`. */
	assign(input: TInput): keyof TArms & string
	readonly metadataKey?: string
}): ModelArms<TArms, TInput> {
	const metadataKey = options.metadataKey ?? 'modelArm'
	const stored = (
		metadata: Readonly<Record<string, unknown>> | null | undefined
	) => {
		const name = metadata?.[metadataKey]

		return typeof name === 'string' && hasKey(options.arms, name) ? name : null
	}

	return {
		arms: options.arms,
		metadataKey,
		stored,
		resolve(input) {
			const name = stored(input.metadata) ?? options.assign(input)
			const arm = options.arms[name] as TArms[keyof TArms]

			return { ...(arm as object), name } as {
				readonly name: keyof TArms & string
			} & TArms[keyof TArms]
		}
	}
}
