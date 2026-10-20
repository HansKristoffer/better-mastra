/**
 * The values every run carries in Mastra's request context, typed by one zod
 * schema, and holders for the values that must never be serialized (an RPC
 * caller, a session): a holder's `toJSON()` and `serializeForSpan()` return
 * nothing, so its value never reaches a run snapshot, a span or a score row.
 */

import {
	MASTRA_RESOURCE_ID_KEY,
	MASTRA_THREAD_ID_KEY,
	RequestContext
} from '@mastra/core/request-context'
import type { z } from 'zod'

import type { ThreadKey } from './types.js'

/** A slot for one non-serializable value in a request context. */
export interface RequestContextHolder<T> {
	set(requestContext: RequestContext, value: T): void
	/** The value; throws when the turn set none, a programming error. */
	get(requestContext: RequestContext): T
	find(requestContext: RequestContext): T | undefined
}

export interface DefinedRequestContext<TSchema extends z.ZodType> {
	readonly schema: TSchema
	/**
	 * A request context with the parsed values and, with a thread key, Mastra's
	 * reserved keys, which force every memory operation in the run onto that thread.
	 */
	create(values: z.input<TSchema>, threadKey?: ThreadKey): RequestContext
	/** The parsed values of a run's request context. */
	read(requestContext: RequestContext): z.output<TSchema>
}

/** Pass `schema` to the agent's `requestContextSchema` so Mastra checks it before any model call. */
export function defineRequestContext<TSchema extends z.ZodType>(
	schema: TSchema
): DefinedRequestContext<TSchema> {
	return {
		schema,
		create(values, threadKey) {
			const parsed = schema.parse(values) as Record<string, unknown>
			const requestContext = new RequestContext<unknown>(Object.entries(parsed))

			if (threadKey) {
				requestContext.setRaw(MASTRA_THREAD_ID_KEY, threadKey.threadId)
				requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, threadKey.resourceId)
			}

			return requestContext
		},
		read: (requestContext) => schema.parse(requestContext.all)
	}
}

/** A holder for one non-serializable value under `key`. */
export function defineRequestContextHolder<T>(
	key: string
): RequestContextHolder<T> {
	const find = (requestContext: RequestContext) => {
		const holder = requestContext.getRaw(key)

		return holder instanceof Holder ? (holder.value as T) : undefined
	}

	return {
		set: (requestContext, value) =>
			requestContext.setRaw(key, new Holder(value)),
		find,
		get(requestContext) {
			const value = find(requestContext)

			if (value === undefined) {
				throw new Error(`No ${key} is set on this request context.`)
			}

			return value
		}
	}
}

class Holder {
	readonly #value: unknown

	constructor(value: unknown) {
		this.#value = value
	}

	get value(): unknown {
		return this.#value
	}

	toJSON(): undefined {
		return undefined
	}

	serializeForSpan(): undefined {
		return undefined
	}
}
