/**
 * Keeps conversation text out of traces: a span processor that removes every
 * field that can carry a message, a prompt, a tool's arguments or result, or
 * the request context, and leaves the ids, timings, usage, cost and status
 * that metrics and debugging need.
 */

import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability'

/**
 * Span attributes that hold content: the agent's instructions and prompt, the
 * tool schemas sent to the model, the messages a processor added or removed,
 * and the reason a processor gave for stopping the run, which can quote them.
 */
export const CONTENT_SPAN_ATTRIBUTES: readonly string[] = [
	'instructions',
	'prompt',
	'tools',
	'messageListMutations',
	'tripwireAbort'
]

/**
 * Strips content from every span and returns the same span: Mastra needs the
 * instance it passed in, and returning nothing would drop the span with its
 * token and cost metrics. Put it in `spanOutputProcessors` of every
 * environment but development.
 */
export class StripContentProcessor implements SpanOutputProcessor {
	readonly name: string
	readonly #attributes: ReadonlySet<string>

	constructor(
		options: {
			readonly name?: string
			/** Attributes removed beside `CONTENT_SPAN_ATTRIBUTES`. */
			readonly attributes?: readonly string[]
		} = {}
	) {
		this.name = options.name ?? 'strip-content'
		this.#attributes = new Set([
			...CONTENT_SPAN_ATTRIBUTES,
			...(options.attributes ?? [])
		])
	}

	process(span?: AnySpan): AnySpan | undefined {
		if (!span) return span

		span.input = undefined
		span.output = undefined
		delete span.requestContext

		if (span.attributes) {
			span.attributes = Object.fromEntries(
				Object.entries(span.attributes).filter(
					([key]) => !this.#attributes.has(key)
				)
			) as NonNullable<AnySpan['attributes']>
		}

		if (span.errorInfo?.details) {
			// A failed model call copies the provider's response body into the details.
			const { responseBody: _, ...details } = span.errorInfo.details

			span.errorInfo = { ...span.errorInfo, details }
		}

		return span
	}

	async shutdown(): Promise<void> {}
}
