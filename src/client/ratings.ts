import { createEmitter } from 'hanzio'
/**
 * The thumbs on answers: the stored ratings with the user's own on top. A
 * rating shows at once; one the server did not take goes back to the stored
 * rating.
 */

// TYPES

/** One answer's rating; the shape is the app's, keyed by message id. */
export interface AnswerRating {
	readonly messageId: string
}

export interface OptimisticRatings<R extends AnswerRating> {
	/** The stored ratings with the user's own since on top, by message id. */
	readonly get: (stored: readonly R[]) => ReadonlyMap<string, R>
	/** Rates an answer at once, replacing an earlier rating of it. */
	readonly rate: (rating: R) => void
	readonly subscribe: (listener: () => void) => () => void
}

// FUNCTIONS

/**
 * `submit` sends a rating to the server; resolving `false` or rejecting means
 * the server did not take it, and the rating rolls back unless the user has
 * rated again since.
 */
export function createOptimisticRatings<R extends AnswerRating>(
	submit: (rating: R) => Promise<unknown>
): OptimisticRatings<R> {
	const changes = createEmitter<{ change: undefined }>()
	let own: ReadonlyMap<string, R> = new Map()
	let cache:
		| {
				stored: readonly R[]
				own: ReadonlyMap<string, R>
				merged: ReadonlyMap<string, R>
		  }
		| undefined

	const commit = (next: ReadonlyMap<string, R>) => {
		own = next

		changes.emit('change')
	}

	return {
		get: (stored) => {
			if (cache?.stored !== stored || cache.own !== own) {
				const merged = new Map([
					...stored.map((rating) => [rating.messageId, rating] as const),
					...own
				])
				cache = { stored, own, merged }
			}

			return cache.merged
		},
		rate: (rating) => {
			const rollBack = () => {
				if (own.get(rating.messageId) === rating) {
					const next = new Map(own)
					next.delete(rating.messageId)
					commit(next)
				}
			}

			commit(new Map(own).set(rating.messageId, rating))
			submit(rating).then((taken) => {
				if (taken === false) {
					rollBack()
				}
			}, rollBack)
		},
		subscribe: (listener) => changes.on('change', listener)
	}
}
