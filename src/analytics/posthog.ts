/**
 * PostHog LLM analytics for a chat turn without any of its text: one
 * `$ai_generation` event per model call, under the turn's trace id. The
 * sender posts to PostHog's capture API with `fetch`, so no PostHog SDK is
 * needed; an app that has `posthog-node` can pass its `capture` instead.
 */

import {
	type ModelCall,
	readModelCalls,
	readTurnTraceId
} from './modelCalls.js'

/** One event as PostHog's capture API and `posthog-node`'s `capture` take it. */
export interface PostHogEvent {
	readonly event: string
	readonly distinctId: string
	readonly properties: Readonly<Record<string, string | number | boolean>>
}

/** Sends one event; it must not throw. May expose `batch` to send a group in one HTTP request. */
export type PostHogCapture = ((event: PostHogEvent) => void | Promise<void>) & {
	readonly batch?: (events: readonly PostHogEvent[]) => void | Promise<void>
}

export const POSTHOG_US_HOST = 'https://us.i.posthog.com'
export const POSTHOG_EU_HOST = 'https://eu.i.posthog.com'

/**
 * A sender for PostHog's capture API. It never throws: a rejected or failed
 * send goes to `onError`, without the event's properties. Events carry
 * `$geoip_disable`, because a server's address says nothing about where the
 * user is. Without an API key it sends nothing.
 *
 * Also exposes `capture.batch(events)` which posts multiple events to `/batch/`
 * in a single HTTP request (used automatically by `posthogGenerations`).
 */
export function createPostHogCapture(options: {
	readonly apiKey: string | undefined
	/** `POSTHOG_US_HOST` (default), `POSTHOG_EU_HOST` or your own. */
	readonly host?: string
	readonly fetch?: typeof fetch
	/** A send that takes longer is abandoned. Default 5 s. */
	readonly timeoutMs?: number
	readonly onError?: (
		error: unknown,
		event: { readonly event: string; readonly status?: number }
	) => void
}): PostHogCapture {
	const { apiKey, onError } = options
	const send = options.fetch ?? fetch
	const baseHost = (options.host ?? POSTHOG_US_HOST).replace(/\/+$/, '')
	const singleUrl = `${baseHost}/i/v0/e/`
	const batchUrl = `${baseHost}/batch/`
	const timeoutMs = options.timeoutMs ?? 5_000

	if (!apiKey) {
		const noop: PostHogCapture = Object.assign(() => {}, {
			batch: () => {}
		})
		return noop
	}

	const captureSingle = async ({
		event,
		distinctId,
		properties
	}: PostHogEvent) => {
		try {
			const response = await send(singleUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: apiKey,
					event,
					distinct_id: distinctId,
					properties: { ...properties, $geoip_disable: true }
				}),
				signal: AbortSignal.timeout(timeoutMs)
			})

			if (!response.ok) {
				onError?.(new Error('PostHog rejected an event.'), {
					event,
					status: response.status
				})
			}
		} catch (error) {
			onError?.(error, { event })
		}
	}

	const captureBatch = async (events: readonly PostHogEvent[]) => {
		if (events.length === 0) return
		if (events.length === 1) {
			await captureSingle(events[0]!)
			return
		}
		const eventName = events[0]!.event
		try {
			const response = await send(batchUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: apiKey,
					batch: events.map(({ event, distinctId, properties }) => ({
						event,
						distinct_id: distinctId,
						properties: { ...properties, $geoip_disable: true }
					}))
				}),
				signal: AbortSignal.timeout(timeoutMs)
			})

			if (!response.ok) {
				onError?.(new Error('PostHog rejected an event.'), {
					event: eventName,
					status: response.status
				})
			}
		} catch (error) {
			onError?.(error, { event: eventName })
		}
	}

	return Object.assign(captureSingle, { batch: captureBatch })
}

/**
 * One model call as PostHog's `$ai_generation`. `$ai_input`,
 * `$ai_output_choices` and `$ai_latency` are left out: no text, and Mastra
 * times no single call. The cost is passed through as reported, never
 * estimated by PostHog.
 */
export function toAiGenerationEvent(
	call: ModelCall,
	context: {
		readonly distinctId: string
		readonly traceId: string
		readonly sessionId?: string | undefined
		/** The span's name in PostHog. Default `chat_step`. */
		readonly spanName?: string
		/** The provider PostHog shows, such as `openrouter`. */
		readonly provider?: string
		/** The app's own properties, such as a workspace id. Never message text. */
		readonly properties?: Readonly<
			Record<string, string | number | boolean | undefined>
		>
	}
): PostHogEvent {
	const properties = {
		$ai_trace_id: context.traceId,
		$ai_session_id: context.sessionId,
		$ai_span_id: call.responseId || undefined,
		$ai_span_name: context.spanName ?? 'chat_step',
		$ai_model: call.modelId,
		$ai_provider: context.provider,
		$ai_input_tokens: call.inputTokens,
		$ai_output_tokens: call.outputTokens,
		$ai_cache_read_input_tokens: call.cacheReadTokens,
		$ai_cache_creation_input_tokens: call.cacheWriteTokens,
		// The input total includes the cached tokens.
		$ai_cache_reporting_exclusive: false,
		$ai_total_cost_usd: call.costUsd,
		$ai_cost_passthrough: call.costUsd === undefined ? undefined : true,
		$ai_stop_reason: call.stopReason,
		$ai_is_error: call.stopReason === 'error',
		...context.properties
	}

	return {
		event: '$ai_generation',
		distinctId: context.distinctId,
		properties: Object.fromEntries(
			Object.entries(properties).filter(
				(entry): entry is [string, string | number | boolean] =>
					entry[1] !== undefined
			)
		)
	}
}

/**
 * A `sinks.usage` for `runChatTurn` that sends one `$ai_generation` per model
 * call of the turn (batched into one HTTP call when `capture.batch` exists).
 * A turn without a Mastra trace sends none unless `traceId` provides a fallback
 * (e.g. `() => crypto.randomUUID()` when `observabilitySchema: false`).
 * `identify` returns undefined for a user who must not be tracked.
 */
export function posthogGenerations<TScope>(options: {
	readonly capture: PostHogCapture
	identify(
		scope: TScope,
		labels: Readonly<Record<string, string | number | boolean | null>>
	):
		| {
				readonly distinctId: string
				readonly sessionId?: string | undefined
				readonly properties?: Readonly<
					Record<string, string | number | boolean | undefined>
				>
		  }
		| undefined
	readonly provider?: string
	readonly spanName?: string
	readonly costOf?: (
		step: unknown,
		call: Omit<ModelCall, 'costUsd'>
	) => number | undefined
	/**
	 * Fallback trace id when Mastra observability is off and steps carry no
	 * `traceId` (e.g. `() => crypto.randomUUID()`).
	 */
	readonly traceId?: (event: {
		readonly scope: TScope
		readonly labels: Readonly<Record<string, string | number | boolean | null>>
		readonly modelId: string
		readonly steps: readonly unknown[]
	}) => string | undefined
}): (event: {
	readonly scope: TScope
	readonly labels: Readonly<Record<string, string | number | boolean | null>>
	readonly modelId: string
	readonly steps: readonly unknown[]
}) => void {
	return (event) => {
		const who = options.identify(event.scope, event.labels)
		const traceId = readTurnTraceId(event.steps) ?? options.traceId?.(event)

		if (!who || !traceId) return

		const calls = readModelCalls(event.steps, event.modelId, options)
		if (calls.length === 0) return

		const events = calls.map((call) =>
			toAiGenerationEvent(call, {
				...who,
				traceId,
				...(options.provider && { provider: options.provider }),
				...(options.spanName && { spanName: options.spanName })
			})
		)

		if (options.capture.batch) {
			void options.capture.batch(events)
		} else {
			for (const phEvent of events) {
				void options.capture(phEvent)
			}
		}
	}
}
