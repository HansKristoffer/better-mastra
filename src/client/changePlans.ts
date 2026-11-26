/**
 * Change plans on the client: the plans a thread's answers proposed, and
 * what the user does with one. A plan is found in the plan-tier tools'
 * results, stored and live alike, and its state is loaded from the server,
 * primed by the `data-change-plan` part a turn streams after its answer.
 * Confirming streams the plan's progress step by step; a plan another window
 * is applying is followed until it ends.
 */

import { isToolUIPart, type UIMessage } from 'ai'

import {
	CHANGE_PLAN_PART,
	type ChangePlanProgress,
	type ChangePlanRefusalCode,
	type ChangePlanStepView,
	type ChangePlanView,
	changePlanProgressSchema,
	changePlanRefusalSchema,
	changePlanSchema,
	changePlanStepOutputSchema
} from '../protocol/index.js'
import type { ChatFetch } from './fetch.js'

export {
	CHANGE_PLAN_PART,
	type ChangePlanChangeView,
	type ChangePlanErrorCode,
	type ChangePlanProgress,
	type ChangePlanRefusalCode,
	type ChangePlanStatus,
	type ChangePlanStepView,
	type ChangePlanView
} from '../protocol/index.js'

// TYPES

/** One plan as a card draws it. */
export interface ChangePlanState {
	/** The plan as last known; undefined until it loaded. */
	readonly plan: ChangePlanView | undefined
	/** What this window is doing with it. */
	readonly phase: 'idle' | 'loading' | 'applying' | 'discarding'
	/** The step this window is applying right now. */
	readonly runningStep: number | undefined
	/** Why the last confirm or discard was turned away: another window applies it (`in_progress`), it is final (`closed`). */
	readonly refusal: ChangePlanRefusalCode | undefined
	/** The last request failed before an answer: offer to try again. */
	readonly failed: boolean
}

export interface ChangePlanStore {
	/** The plan's state; the same object until it changes. */
	get(planId: string): ChangePlanState
	subscribe(listener: () => void): () => void
	/** Loads the plan; one already known is loaded again only with `force`. */
	load(
		threadId: string,
		planId: string,
		options?: { readonly force?: boolean }
	): Promise<void>
	/** Applies the plan in this request, step by step. */
	confirm(threadId: string, planId: string): Promise<void>
	discard(threadId: string, planId: string): Promise<void>
	/** Takes the `data-change-plan` part; pass it the session's `onData`. */
	onData(part: { readonly type: string; readonly data?: unknown }): void
	/** Stops following plans another window applies. */
	dispose(): void
}

/** A plan found in a message: its id and the steps the message proposed. */
export interface ProposedChangePlan {
	readonly planId: string
	readonly steps: readonly ChangePlanStepView[]
}

// CONSTANTS

const IDLE: ChangePlanState = {
	plan: undefined,
	phase: 'idle',
	runningStep: undefined,
	refusal: undefined,
	failed: false
}

/** How often a plan another window applies is read again. */
const FOLLOW_MS = 1_000

// FUNCTIONS

/**
 * The plans a message's plan-tier tool results proposed, in order, each with
 * its steps. A card for the plan goes after the message's last step; draw it
 * once the turn is no longer busy, when the plan has stopped growing.
 */
export function readProposedChangePlans(
	message: UIMessage
): ProposedChangePlan[] {
	const plans = new Map<string, ChangePlanStepView[]>()

	for (const part of message.parts) {
		if (!isToolUIPart(part) || part.state !== 'output-available') continue

		const parsed = changePlanStepOutputSchema.safeParse(part.output)

		if (!parsed.success) continue

		const { planId, step } = parsed.data.changePlan
		plans.set(planId, [...(plans.get(planId) ?? []), step])
	}

	return [...plans].map(([planId, steps]) => ({ planId, steps }))
}

/**
 * The plans of a chat, for every card that shows one: `{api}` is the chat
 * route, as `createChatSession`'s `transport.api`.
 */
export function createChangePlanStore(options: {
	readonly api: string
	/** Usually `createChatFetch(...)`. */
	readonly fetch?: ChatFetch
	readonly credentials?: RequestInit['credentials']
	/** How often a plan another window applies is read again. Default 1 s. */
	readonly followMs?: number
}): ChangePlanStore {
	const states = new Map<string, ChangePlanState>()
	const listeners = new Set<() => void>()
	const following = new Map<string, ReturnType<typeof setTimeout>>()
	const fetchPlan =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const followMs = options.followMs ?? FOLLOW_MS
	const url = (threadId: string, planId: string, action = '') =>
		`${options.api}/${encodeURIComponent(threadId)}/plans/${encodeURIComponent(planId)}${action}`
	const request = (
		threadId: string,
		planId: string,
		action: string,
		method: string
	) =>
		fetchPlan(url(threadId, planId, action), {
			method,
			...(options.credentials && { credentials: options.credentials })
		})

	const get = (planId: string) => states.get(planId) ?? IDLE
	const set = (planId: string, change: Partial<ChangePlanState>) => {
		states.set(planId, { ...get(planId), ...change })
		for (const listener of [...listeners]) listener()
	}

	/** Reads the plan again while another window applies it. */
	const follow = (threadId: string, planId: string) => {
		clearTimeout(following.get(planId))
		following.delete(planId)

		const { plan, phase } = get(planId)

		if (plan?.status !== 'applying' || phase !== 'idle') return

		following.set(
			planId,
			setTimeout(() => {
				following.delete(planId)
				void store.load(threadId, planId, { force: true })
			}, followMs)
		)
	}

	/** Reads a refused answer's code; undefined for any other failure. */
	const refusalOf = async (response: Response) =>
		changePlanRefusalSchema.safeParse(
			await response.json().catch(() => undefined)
		).data?.error

	const store: ChangePlanStore = {
		get,
		subscribe(listener) {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		async load(threadId, planId, loadOptions) {
			const known = get(planId)

			if ((known.plan && !loadOptions?.force) || known.phase !== 'idle') return

			set(planId, { phase: 'loading' })

			try {
				const response = await request(threadId, planId, '', 'GET')

				if (!response.ok) {
					set(planId, {
						phase: 'idle',
						refusal: await refusalOf(response),
						failed: false
					})
					return
				}

				const body = (await response.json()) as { plan?: unknown }
				set(planId, {
					phase: 'idle',
					plan: changePlanSchema.parse(body.plan),
					failed: false
				})
			} catch {
				set(planId, { phase: 'idle', failed: true })
			}

			follow(threadId, planId)
		},
		async confirm(threadId, planId) {
			if (get(planId).phase !== 'idle') return

			set(planId, { phase: 'applying', refusal: undefined, failed: false })

			try {
				const response = await request(threadId, planId, '/apply', 'POST')

				if (!response.ok || !response.body) {
					set(planId, { phase: 'idle', refusal: await refusalOf(response) })
					// Applied elsewhere, or being applied: show what it is now.
					await store.load(threadId, planId, { force: true })
					return
				}

				for await (const event of readProgress(response.body)) {
					set(planId, progressed(get(planId), event))
				}

				set(planId, { phase: 'idle', runningStep: undefined })
			} catch {
				// The plan runs to its end on the server; its state says how far it got.
				set(planId, { phase: 'idle', runningStep: undefined, failed: true })
				await store.load(threadId, planId, { force: true })
			}
		},
		async discard(threadId, planId) {
			if (get(planId).phase !== 'idle') return

			set(planId, { phase: 'discarding', refusal: undefined, failed: false })

			try {
				const response = await request(threadId, planId, '/discard', 'POST')

				if (!response.ok) {
					set(planId, { phase: 'idle', refusal: await refusalOf(response) })
					await store.load(threadId, planId, { force: true })
					return
				}

				const body = (await response.json()) as { plan?: unknown }
				set(planId, { phase: 'idle', plan: changePlanSchema.parse(body.plan) })
			} catch {
				set(planId, { phase: 'idle', failed: true })
			}
		},
		onData(part) {
			if (part.type !== CHANGE_PLAN_PART) return

			const parsed = changePlanSchema.safeParse(
				(part.data as { plan?: unknown } | undefined)?.plan
			)

			if (parsed.success) set(parsed.data.id, { plan: parsed.data })
		},
		dispose() {
			for (const timer of following.values()) clearTimeout(timer)
			following.clear()
			listeners.clear()
		}
	}

	return store
}

/** The state after one progress line. */
function progressed(
	state: ChangePlanState,
	event: ChangePlanProgress
): Partial<ChangePlanState> {
	const withStep = (index: number, change: Partial<ChangePlanStepView>) =>
		state.plan && {
			...state.plan,
			status: 'applying' as const,
			steps: state.plan.steps.map((step) =>
				step.index === index ? { ...step, ...change } : step
			)
		}

	switch (event.type) {
		case 'step-started':
			return {
				runningStep: event.index,
				...(state.plan && { plan: withStep(event.index, {}) })
			}
		case 'step-applied':
			return { plan: withStep(event.index, { status: 'applied' }) }
		case 'step-failed':
			return {
				plan: withStep(event.index, { status: 'failed', error: event.error })
			}
		case 'finished':
			return { plan: event.plan, runningStep: undefined }
	}
}

/** The NDJSON lines of the apply route, parsed; a line that does not parse is skipped. */
async function* readProgress(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<ChangePlanProgress> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffered = ''

	for (;;) {
		const { done, value } = await reader.read()
		buffered += done
			? decoder.decode()
			: decoder.decode(value, { stream: true })
		const lines = buffered.split('\n')
		buffered = done ? '' : (lines.pop() ?? '')

		for (const line of lines) {
			if (line.trim() === '') continue

			const parsed = changePlanProgressSchema.safeParse(safeJson(line))

			if (parsed.success) yield parsed.data
		}

		if (done) return
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
