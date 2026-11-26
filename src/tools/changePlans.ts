/**
 * Change plans: many writes drafted in one turn, confirmed once, applied
 * safely. A plan-tier tool never writes. Its `propose` reads the target and
 * works out what it would write; the step joins the turn's plan in a
 * `ChatRecordStore`. When the turn has answered, the user confirms or
 * discards the plan, and `applyChangePlan` runs its steps in order in the
 * user's own request, without the model: the guard again per step, every
 * target read again right before its write and left alone when it no longer
 * holds the value the plan saw.
 *
 * One runner at a time holds a plan, by a lease taken and renewed with the
 * store's compare-and-set. Progress is saved after every step, so applying a
 * failed plan again resumes at the step that failed, and a target an earlier,
 * interrupted run already wrote counts as done.
 */

import { randomUUID } from 'node:crypto'
import type { RequestContext } from '@mastra/core/request-context'
import { stableStringify } from 'hanzio'

import type {
	ChangePlanChangeView,
	ChangePlanErrorCode,
	ChangePlanProgress,
	ChangePlanRefusalCode,
	ChangePlanStatus,
	ChangePlanStepOutput,
	ChangePlanStepStatus,
	ChangePlanView
} from '../protocol/index.js'
import {
	applyTarget,
	sameValue,
	type ToolChange,
	type ToolChangeCall
} from './changes.js'
import { isDryRun } from './dryRun.js'
import { ToolRefusal } from './refusal.js'
import {
	type ChatRecord,
	type ChatRecordStore,
	createMemoryRecordStore
} from './records.js'

// TYPES

/** The record kind of a change plan in a `ChatRecordStore`. */
export const CHANGE_PLAN_KIND = 'change-plan'

/** A schema `valueSchema` takes: anything with a Standard Schema `validate`, such as a zod schema. */
export interface StandardValueSchema<T> {
	readonly '~standard': {
		readonly validate: (
			value: unknown
		) =>
			| { readonly value: T; readonly issues?: undefined }
			| { readonly issues: readonly unknown[] }
			| Promise<
					| { readonly value: T; readonly issues?: undefined }
					| { readonly issues: readonly unknown[] }
			  >
	}
}

/** One target a step would change: what it is, the value `propose` read, and the value it would write. */
export interface PlanTargetChange<TTarget = unknown, TValue = unknown> {
	/** Whatever `read` and `write` need to find the target, as JSON. */
	readonly target: TTarget
	/** The value the target held when the plan was made; `null` for one that did not exist. */
	readonly seen: TValue
	readonly next: TValue
	/** How the confirm card names the target, such as the product's name. */
	readonly label?: string
}

/** What one call of a plan-tier tool adds to the turn's plan. */
export interface PlanProposal<TTarget = unknown, TValue = unknown> {
	/** One line for the confirm card, such as "Raise 50 prices by 5%". */
	readonly title: string
	readonly changes: readonly PlanTargetChange<TTarget, TValue>[]
}

/**
 * A plan-tier tool's plan: how it proposes a step, and how a step is applied
 * later, one target at a time. `read` and `write` get the apply request's
 * call, with hidden inputs filled from its request context, not the model's.
 */
export interface ToolPlan<
	TInput = unknown,
	TTarget = unknown,
	TValue = unknown
> {
	/** Reads and validates, never writes. Throw a `ToolRefusal` for input it cannot act on. */
	readonly propose: (
		call: ToolChangeCall<TInput>
	) => Promise<PlanProposal<TTarget, TValue>> | PlanProposal<TTarget, TValue>
	/** A sentence for the model at `propose`, and for the user at apply, when the step must not run. Runs again per step at apply. */
	readonly guard?: ToolChange<TInput>['guard']
	/** What the target holds now; undefined or null for one that does not exist. */
	readonly read: (
		target: TTarget,
		call: ToolChangeCall<TInput>
	) => Promise<TValue | undefined>
	readonly write: (
		target: TTarget,
		value: TValue,
		call: ToolChangeCall<TInput>
	) => Promise<unknown>
	/** Values are compared as JSON with sorted keys unless this says otherwise. */
	readonly equals?: (left: TValue | undefined, right: TValue) => boolean
	/** Checks a stored `seen` and `next` before a step runs; one that fails refuses the step as `snapshot_unreadable`. */
	readonly valueSchema?: StandardValueSchema<TValue>
}

/** A tool's plan as `defineTool` binds it: the definition, and the call it builds for an input. */
export interface BoundToolPlan {
	// biome-ignore lint/suspicious/noExplicitAny: each tool types its own plan; the runner only calls it.
	readonly definition: ToolPlan<any, any, any>
	/** The call for a stored input: hidden inputs filled from this request context. */
	readonly callFor: (
		input: unknown,
		requestContext: RequestContext | undefined
	) => ToolChangeCall
}

/** What a plan needs from a tool: its name and bound plan. `DefinedTool` has both. */
export interface PlanTool {
	readonly name: string
	readonly plan?: BoundToolPlan
}

export interface ChangePlanCaps {
	/** Steps one plan may hold. Default 20. */
	readonly maxSteps?: number
	/** Targets one step may change. Default 50. */
	readonly maxChangesPerStep?: number
}

/** One target of a stored step. `seen` and `next` are JSON text, so a snapshot that does not parse is caught, never skipped. */
export interface StoredPlanChange {
	readonly target: unknown
	readonly seen: string
	readonly next: string
	readonly label?: string
	readonly applied?: boolean
}

export interface StoredPlanStep {
	readonly tool: string
	/** The input the model sent, without hidden inputs: apply fills them again from its own request context. */
	readonly input: unknown
	readonly title: string
	readonly changes: readonly StoredPlanChange[]
	readonly status: ChangePlanStepStatus
	readonly error?: {
		readonly code: ChangePlanErrorCode
		readonly message: string
	}
}

/** The plan as the store keeps it. */
export interface ChangePlanData {
	readonly status: ChangePlanStatus
	readonly steps: readonly StoredPlanStep[]
	/** Who holds the plan while it is `applying`, and until when (epoch ms). */
	readonly lease: { readonly owner: string; readonly until: number } | null
	readonly createdAt: string
	readonly updatedAt: string
}

export type ChangePlanRecord = ChatRecord<ChangePlanData>

/** What `runChatTurn` binds to a turn's request context so its plan-tier tools find the turn's plan. */
export interface TurnChangePlanBinding {
	readonly store: ChatRecordStore
	readonly threadId: string
	readonly resourceId: string
	readonly caps?: ChangePlanCaps
	/** How long a plan nobody confirms is kept, in ms; null for the thread's life. Default 7 days. */
	readonly ttlMs?: number | null
	readonly now?: () => number
}

interface TurnPlanState {
	readonly binding: TurnChangePlanBinding
	planId: string | undefined
	/** Serializes the turn's proposals: tools of one step run side by side. */
	queue: Promise<unknown>
}

// CONSTANTS

const DEFAULT_MAX_STEPS = 20
const DEFAULT_MAX_CHANGES_PER_STEP = 50
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LEASE_MS = 60_000
/** Targets the view shows per step; a larger step shows its count and these first ones. */
export const CHANGE_PLAN_SAMPLE_SIZE = 10
/** Compare-and-set attempts before a plan write gives up. */
const MAX_PUT_ATTEMPTS = 5

/** What the user reads for each step error but `refused`, which carries the guard's own sentence. */
export const CHANGE_PLAN_ERROR_SENTENCES: Readonly<
	Record<Exclude<ChangePlanErrorCode, 'refused'>, string>
> = {
	changed_since:
		'Something changed this since the plan was made, so it was left alone. Ask again to make a new plan.',
	snapshot_unreadable:
		'The plan no longer knows what this held before, so it was left alone. Ask again to make a new plan.',
	unknown_tool: 'This kind of change can no longer be made.',
	read_failed: 'This could not be read, so it was left alone. Try again.',
	write_failed: 'This could not be saved. Try again.',
	lease_lost: 'Another window took over applying this plan.'
}

const turnPlans = new WeakMap<object, TurnPlanState>()

// FUNCTIONS: THE TURN

/** Gives the turn's plan-tier tools their plan. `runChatTurn` calls it when it has `changePlans`. */
export function bindTurnChangePlan(
	requestContext: object,
	binding: TurnChangePlanBinding
): void {
	turnPlans.set(requestContext, {
		binding,
		planId: undefined,
		queue: Promise.resolve()
	})
}

/** The plan id the turn's tools proposed into; undefined when none proposed anything. */
export function turnChangePlanId(requestContext: object): string | undefined {
	return turnPlans.get(requestContext)?.planId
}

/**
 * A dry run's plan: the steps its plan-tier tools proposed, kept in memory on
 * the request context and never stored. Undefined when none proposed.
 */
export async function readDryRunChangePlan(
	requestContext: object
): Promise<ChangePlanView | undefined> {
	const state = turnPlans.get(requestContext)

	if (!state?.planId) return undefined

	const record = await readPlan(state.binding.store, state.planId)

	return record ? toChangePlanView(record) : undefined
}

/**
 * Adds one step to the turn's plan, creating the plan on the first. Called by
 * a plan-tier tool; refuses, as a sentence the model reads, a proposal that
 * changes nothing, breaks a cap, or touches a target an earlier step already
 * changes (its `seen` would be stale once that step ran).
 */
export async function proposePlanStep(
	call: ToolChangeCall & {
		readonly tool: string
		readonly visibleInput: unknown
	},
	proposal: PlanProposal
): Promise<ChangePlanStepOutput> {
	const requestContext = call.requestContext

	if (!requestContext)
		throw new Error('A plan-tier tool ran without a request context.')

	const state = isDryRun(requestContext)
		? dryRunState(requestContext)
		: turnPlans.get(requestContext)

	if (!state) {
		throw new Error(
			'A plan-tier tool ran outside a turn with change plans: pass `changePlans` to runChatTurn.'
		)
	}

	const step = toStoredStep(
		call.tool,
		call.visibleInput,
		proposal,
		state.binding.caps
	)
	const run = state.queue.then(() => addStep(state, step))
	state.queue = run.catch(() => {})

	return run
}

/**
 * Closes the turn's plan when the turn ends: an answered turn offers it to
 * the user (`proposed`), any other ending discards it. Returns the plan as the
 * client sees it, or undefined when the turn proposed nothing.
 */
export async function closeTurnChangePlan(
	requestContext: object,
	answered: boolean
): Promise<ChangePlanView | undefined> {
	const state = turnPlans.get(requestContext)

	if (!state?.planId) return undefined

	await state.queue
	const record = await updatePlan(state.binding.store, state.planId, (plan) =>
		plan.status === 'draft'
			? { ...plan, status: answered ? 'proposed' : 'discarded' }
			: undefined
	)

	return record ? toChangePlanView(record) : undefined
}

/**
 * Discards the thread's plans still waiting for the user (`proposed`, or
 * `failed` and not resumed) when they write a new message instead: the user
 * moved on. A plan being applied right now is left alone.
 */
export async function moveOnFromWaitingPlans(input: {
	readonly store: ChatRecordStore
	readonly threadId: string
	readonly now?: () => number
}): Promise<readonly ChangePlanRecord[]> {
	const now = input.now ?? Date.now
	const plans = (await input.store.list(
		CHANGE_PLAN_KIND,
		input.threadId
	)) as ChangePlanRecord[]

	return Promise.all(
		plans.map(
			async (plan) =>
				(plan.data.status === 'proposed' || plan.data.status === 'failed'
					? await updatePlan(
							input.store,
							plan.id,
							(data) =>
								data.status === 'proposed' || data.status === 'failed'
									? { ...data, status: 'discarded' }
									: undefined,
							now
						)
					: undefined) ?? plan
		)
	)
}

/**
 * What the model reads about the thread's plans, newest last, as part of the
 * turn's per-request signal: whether each was applied, stopped at a step,
 * discarded or still waits. Undefined for a thread without plans.
 */
export function changePlansSignal(
	plans: readonly ChangePlanRecord[],
	limit = 5
): string | undefined {
	const shown = plans
		.filter((plan) => plan.data.status !== 'draft')
		.slice(-limit)

	if (shown.length === 0) return undefined

	const lines = shown.map(
		(plan) => `- "${planTitle(plan.data)}": ${planOutcome(plan.data)}`
	)

	return [
		'Change plans you proposed in this conversation, newest last:',
		...lines
	].join('\n')
}

// FUNCTIONS: APPLYING

export type ApplyChangePlanResult =
	| { readonly kind: 'refused'; readonly code: ChangePlanRefusalCode }
	| { readonly kind: 'finished'; readonly plan: ChangePlanView }

/**
 * Applies a plan in the caller's request: claims it, runs each step not yet
 * applied in order and saves progress after every step. The first failure
 * stops the plan as `failed`; applying it again resumes at that step.
 *
 * Per step: the tool's guard with this request's context, then every target
 * read and checked against the plan's snapshot before the first write, then
 * each target read once more right before its own write. A target that holds
 * the step's new value already counts as done; one that holds anything but
 * the snapshot refuses the step, as does a snapshot that is missing or does
 * not parse. A runner keeps its lease by compare-and-set and stops when
 * another took the plan over.
 */
export async function applyChangePlan(input: {
	readonly store: ChatRecordStore
	readonly planId: string
	/** The thread the caller asks for; a plan of another thread is `not_found`. */
	readonly threadId: string
	readonly tools: readonly PlanTool[]
	/** The apply request's context, built from the caller: guards and hidden inputs read it. */
	// biome-ignore lint/suspicious/noExplicitAny: a context the app typed is not a RequestContext<unknown>.
	readonly requestContext: RequestContext<any>
	/** This runner's id. Default a random one. */
	readonly owner?: string
	/** How long a claim lasts without renewal; a crashed runner's plan is free again after it. Default 60 s. */
	readonly leaseMs?: number
	readonly onProgress?: (event: ChangePlanProgress) => void
	/** A read or write error the user does not see, for the log. */
	readonly onError?: (
		error: unknown,
		event: { readonly tool: string; readonly step: number }
	) => void
	readonly now?: () => number
}): Promise<ApplyChangePlanResult> {
	const now = input.now ?? Date.now
	const owner = input.owner ?? randomUUID()
	const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
	const claimed = await claimPlan(
		input.store,
		input.planId,
		input.threadId,
		owner,
		leaseMs,
		now
	)

	if (claimed.kind === 'refused') return claimed

	const runner = new PlanRunner(input, claimed.record, owner, leaseMs, now)

	return { kind: 'finished', plan: toChangePlanView(await runner.run()) }
}

/**
 * Discards a plan the user does not want: one that waits (`proposed`), one
 * that stopped at a step (`failed`), or one whose runner crashed (its lease
 * expired). A plan being applied is `in_progress`; an applied or discarded
 * one is `closed`.
 */
export async function discardChangePlan(input: {
	readonly store: ChatRecordStore
	readonly planId: string
	readonly threadId: string
	readonly now?: () => number
}): Promise<ApplyChangePlanResult> {
	const now = input.now ?? Date.now

	for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt += 1) {
		const record = await readPlan(input.store, input.planId)

		if (!record || record.threadId !== input.threadId)
			return { kind: 'refused', code: 'not_found' }

		const refusal = refusalOf(record.data, now(), 'discard')

		if (refusal) return { kind: 'refused', code: refusal }

		const next = withData(
			record,
			{ ...record.data, status: 'discarded', lease: null },
			now
		)

		if (await input.store.put(next, record.version)) {
			return {
				kind: 'finished',
				plan: toChangePlanView({ ...next, version: record.version + 1 })
			}
		}
	}

	return { kind: 'refused', code: 'in_progress' }
}

/** The plan as the client sees it; null for no plan, or one of another thread. */
export async function readChangePlan(input: {
	readonly store: ChatRecordStore
	readonly planId: string
	readonly threadId: string
}): Promise<ChangePlanView | null> {
	const record = await readPlan(input.store, input.planId)

	return record && record.threadId === input.threadId
		? toChangePlanView(record)
		: null
}

/** A stored plan as the confirm card shows it: every step, with its count and its first targets. */
export function toChangePlanView(record: ChangePlanRecord): ChangePlanView {
	return {
		id: record.id,
		threadId: record.threadId,
		status: record.data.status,
		steps: record.data.steps.map(toStepView),
		createdAt: record.data.createdAt,
		updatedAt: record.data.updatedAt
	}
}

// INTERNALS

class PlanRunner {
	readonly #byName: ReadonlyMap<string, BoundToolPlan>
	#record: ChangePlanRecord

	constructor(
		readonly input: Parameters<typeof applyChangePlan>[0],
		record: ChangePlanRecord,
		readonly owner: string,
		readonly leaseMs: number,
		readonly now: () => number
	) {
		this.#record = record
		this.#byName = new Map(
			input.tools.flatMap((tool) =>
				tool.plan ? [[tool.name, tool.plan] as const] : []
			)
		)
	}

	async run(): Promise<ChangePlanRecord> {
		const steps = this.#record.data.steps

		for (let index = 0; index < steps.length; index += 1) {
			if (this.#record.data.steps[index]?.status === 'applied') continue

			this.#emit({ type: 'step-started', index })
			const failure = await this.#runStep(index)

			if (failure === 'lease_lost') {
				const error = stepError('lease_lost')
				this.#emit({ type: 'step-failed', index, error })
				// Another runner holds the plan now: nothing of ours may be saved over it.
				return this.#record
			}

			if (failure) {
				await this.#save((data) => ({
					...data,
					status: 'failed',
					lease: null,
					steps: replaceAt(data.steps, index, (step) => ({
						...step,
						status: 'failed',
						error: failure
					}))
				}))
				this.#emit({ type: 'step-failed', index, error: failure })
				this.#emit({ type: 'finished', plan: toChangePlanView(this.#record) })

				return this.#record
			}

			const saved = await this.#save((data) => ({
				...data,
				steps: replaceAt(data.steps, index, (step) => {
					const { error: _error, ...rest } = step

					return { ...rest, status: 'applied' }
				})
			}))

			if (!saved) {
				this.#emit({
					type: 'step-failed',
					index,
					error: stepError('lease_lost')
				})
				return this.#record
			}

			this.#emit({ type: 'step-applied', index })
		}

		await this.#save((data) => ({ ...data, status: 'applied', lease: null }))
		this.#emit({ type: 'finished', plan: toChangePlanView(this.#record) })

		return this.#record
	}

	/** Runs one step; what stopped it, or undefined when every target holds its new value. */
	async #runStep(
		index: number
	): Promise<StoredPlanStep['error'] | 'lease_lost' | undefined> {
		const step = this.#record.data.steps[index]!
		const plan = this.#byName.get(step.tool)

		if (!plan) return stepError('unknown_tool')

		const definition = plan.definition
		const call = plan.callFor(step.input, this.input.requestContext)
		const refusal = await definition.guard?.(call)

		if (refusal !== undefined) return { code: 'refused', message: refusal }

		const changes = await readSnapshots(step.changes, definition.valueSchema)

		if (!changes) return stepError('snapshot_unreadable')

		const equals = definition.equals ?? sameValue
		const read = (target: unknown) => definition.read(target, call)
		const report = (error: unknown) =>
			this.input.onError?.(error, { tool: step.tool, step: index })

		// Every target first, so a step that cannot run whole writes nothing.
		for (const change of changes) {
			if (change.applied) continue

			const current = await read(change.target).then(
				(value) => ({ value }),
				(error: unknown) => {
					report(error)
					return undefined
				}
			)

			if (!current) return stepError('read_failed')

			if (equals(current.value, change.next)) continue

			if (!equals(current.value, change.seen)) return stepError('changed_since')
		}

		for (const [changeIndex, change] of changes.entries()) {
			if (change.applied) continue

			if (!(await this.#keepLease())) return 'lease_lost'

			const outcome = await applyTarget({
				read: () => read(change.target),
				seen: change.seen,
				next: change.next,
				write: (value) => definition.write(change.target, value, call),
				equals,
				onError: report
			}).catch((error: unknown) => {
				report(error)
				return 'readFailed' as const
			})

			if (outcome === 'readFailed') return stepError('read_failed')
			if (outcome === 'changedSince') return stepError('changed_since')
			if (outcome === 'failed') return stepError('write_failed')

			changes[changeIndex] = { ...change, applied: true }
			this.#record = withData(
				this.#record,
				{
					...this.#record.data,
					steps: replaceAt(this.#record.data.steps, index, (stored) => ({
						...stored,
						changes: replaceAt(stored.changes, changeIndex, (target) => ({
							...target,
							applied: true
						}))
					}))
				},
				this.now,
				this.#record.version
			)
		}

		return undefined
	}

	/** Renews the lease, by compare-and-set, once less than two thirds of it is left; false when another runner took the plan. */
	async #keepLease(): Promise<boolean> {
		const lease = this.#record.data.lease
		const left = (lease?.until ?? 0) - this.now()

		if (lease?.owner === this.owner && left > (this.leaseMs * 2) / 3)
			return true

		return this.#save((data) => data)
	}

	/** Saves the plan as `change` makes it, with the lease renewed; false when the stored plan is no longer this runner's. */
	async #save(
		change: (data: ChangePlanData) => ChangePlanData
	): Promise<boolean> {
		const changed = change(this.#record.data)
		const data: ChangePlanData = {
			...changed,
			lease:
				changed.status === 'applying'
					? { owner: this.owner, until: this.now() + this.leaseMs }
					: null
		}
		const next = withData(this.#record, data, this.now)

		if (!(await this.input.store.put(next, this.#record.version))) return false

		this.#record = { ...next, version: this.#record.version + 1 }

		return true
	}

	#emit(event: ChangePlanProgress): void {
		try {
			this.input.onProgress?.(event)
		} catch {
			// A listener that fails must not stop a plan halfway.
		}
	}
}

async function claimPlan(
	store: ChatRecordStore,
	planId: string,
	threadId: string,
	owner: string,
	leaseMs: number,
	now: () => number
): Promise<
	| { readonly kind: 'claimed'; readonly record: ChangePlanRecord }
	| { readonly kind: 'refused'; readonly code: ChangePlanRefusalCode }
> {
	for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt += 1) {
		const record = await readPlan(store, planId)

		if (!record || record.threadId !== threadId)
			return { kind: 'refused', code: 'not_found' }

		const refusal = refusalOf(record.data, now(), 'apply')

		if (refusal) return { kind: 'refused', code: refusal }

		const next = withData(
			record,
			{
				...record.data,
				status: 'applying',
				lease: { owner, until: now() + leaseMs }
			},
			now
		)

		if (await store.put(next, record.version)) {
			return {
				kind: 'claimed',
				record: { ...next, version: record.version + 1 }
			}
		}
	}

	// Every attempt lost to another writer: someone else is claiming it right now.
	return { kind: 'refused', code: 'in_progress' }
}

/** Why the plan cannot be applied or discarded now; undefined when it can. */
function refusalOf(
	data: ChangePlanData,
	now: number,
	action: 'apply' | 'discard'
): ChangePlanRefusalCode | undefined {
	switch (data.status) {
		case 'draft':
			return 'not_ready'
		case 'proposed':
		case 'failed':
			return undefined
		case 'applying':
			// A runner that crashed stops renewing; its plan is free once the lease ran out.
			return (data.lease?.until ?? 0) > now ? 'in_progress' : undefined
		default:
			// `applied` and `discarded` are final, whoever asks.
			return action === 'apply' || action === 'discard' ? 'closed' : undefined
	}
}

async function addStep(
	state: TurnPlanState,
	step: StoredPlanStep
): Promise<ChangePlanStepOutput> {
	const { binding } = state
	const now = binding.now ?? Date.now
	const maxSteps = binding.caps?.maxSteps ?? DEFAULT_MAX_STEPS
	const planId = state.planId ?? `plan_${randomUUID()}`

	for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt += 1) {
		const stored = state.planId ? await readPlan(binding.store, planId) : null

		if (state.planId && stored?.data.status !== 'draft') {
			throw new ToolRefusal(
				"This turn's change plan is closed; no step can be added to it."
			)
		}

		const steps = stored?.data.steps ?? []

		if (steps.length >= maxSteps) {
			throw new ToolRefusal(
				`A change plan holds at most ${maxSteps} steps. Tell the user which changes are in this plan and offer the rest in a next one.`
			)
		}

		const taken = takenTarget(steps, step)

		if (taken !== undefined) {
			throw new ToolRefusal(
				`Step ${taken + 1} of this plan already changes ${describeTarget(step, taken, steps)}. Change each target once per plan: fold this change into that step's values.`
			)
		}

		const timestamp = new Date(now()).toISOString()
		const ttlMs = binding.ttlMs === undefined ? DEFAULT_TTL_MS : binding.ttlMs
		const record: ChangePlanRecord = stored
			? withData(stored, { ...stored.data, steps: [...steps, step] }, now)
			: {
					kind: CHANGE_PLAN_KIND,
					id: planId,
					threadId: binding.threadId,
					resourceId: binding.resourceId,
					version: 0,
					expiresAt: ttlMs === null ? null : new Date(now() + ttlMs),
					data: {
						status: 'draft',
						steps: [step],
						lease: null,
						createdAt: timestamp,
						updatedAt: timestamp
					}
				}

		if (await binding.store.put(record, stored?.version ?? 0)) {
			state.planId = planId

			return {
				changePlan: { planId, step: toStepView(step, steps.length) }
			}
		}
	}

	throw new Error(
		'The change plan could not be saved: too many writers at once.'
	)
}

/** The index of an earlier step that already changes one of this step's targets. */
function takenTarget(
	steps: readonly StoredPlanStep[],
	step: StoredPlanStep
): number | undefined {
	const keys = new Set(
		step.changes.map((change) => targetKey(step.tool, change.target))
	)
	const index = steps.findIndex((earlier) =>
		earlier.changes.some((change) =>
			keys.has(targetKey(earlier.tool, change.target))
		)
	)

	return index === -1 ? undefined : index
}

function describeTarget(
	step: StoredPlanStep,
	takenIndex: number,
	steps: readonly StoredPlanStep[]
): string {
	const earlier = steps[takenIndex]!
	const keys = new Set(
		earlier.changes.map((change) => targetKey(earlier.tool, change.target))
	)
	const shared = step.changes.find((change) =>
		keys.has(targetKey(step.tool, change.target))
	)

	return shared?.label ? `"${shared.label}"` : 'one of these targets'
}

function targetKey(tool: string, target: unknown): string {
	return `${tool}\0${stableStringify(target)}`
}

function toStoredStep(
	tool: string,
	input: unknown,
	proposal: PlanProposal,
	caps: ChangePlanCaps | undefined
): StoredPlanStep {
	const maxChanges = caps?.maxChangesPerStep ?? DEFAULT_MAX_CHANGES_PER_STEP

	if (proposal.changes.length === 0) {
		throw new ToolRefusal('This would change nothing, so no step was added.')
	}

	if (proposal.changes.length > maxChanges) {
		throw new ToolRefusal(
			`One step changes at most ${maxChanges} targets and this one changes ${proposal.changes.length}. Split it into steps of ${maxChanges} or fewer.`
		)
	}

	const keys = new Set<string>()

	for (const change of proposal.changes) {
		const key = targetKey(tool, change.target)

		if (keys.has(key)) {
			throw new ToolRefusal(
				'This step names one target twice. Name each target once.'
			)
		}

		keys.add(key)
	}

	return {
		tool,
		input,
		title: proposal.title,
		status: 'pending',
		changes: proposal.changes.map((change) => ({
			target: change.target,
			// `null` stands for a target that does not exist; JSON has no undefined.
			seen: JSON.stringify(change.seen ?? null),
			next: JSON.stringify(change.next ?? null),
			...(change.label !== undefined && { label: change.label })
		}))
	}
}

/** The stored snapshots, parsed and checked; undefined when any is missing or unreadable, which refuses the step. */
async function readSnapshots(
	changes: readonly StoredPlanChange[],
	schema: StandardValueSchema<unknown> | undefined
): Promise<
	| { target: unknown; seen: unknown; next: unknown; applied: boolean }[]
	| undefined
> {
	const read: {
		target: unknown
		seen: unknown
		next: unknown
		applied: boolean
	}[] = []

	for (const change of changes) {
		const seen = await parseSnapshot(change?.seen, schema)
		const next = await parseSnapshot(change?.next, schema)

		if (!seen || !next) return undefined

		read.push({
			target: change.target,
			seen: seen.value,
			next: next.value,
			applied: change.applied === true
		})
	}

	return read
}

async function parseSnapshot(
	text: unknown,
	schema: StandardValueSchema<unknown> | undefined
): Promise<{ readonly value: unknown } | undefined> {
	if (typeof text !== 'string') return undefined

	let value: unknown

	try {
		value = JSON.parse(text)
	} catch {
		return undefined
	}

	if (!schema || value === null) return { value }

	const result = await schema['~standard'].validate(value)

	return result.issues ? undefined : { value: result.value }
}

function toStepView(
	step: StoredPlanStep,
	index: number
): ChangePlanView['steps'][number] {
	return {
		index,
		tool: step.tool,
		title: step.title,
		status: step.status,
		count: step.changes.length,
		sample: step.changes.slice(0, CHANGE_PLAN_SAMPLE_SIZE).map(toChangeView),
		...(step.error && { error: step.error })
	}
}

function toChangeView(change: StoredPlanChange): ChangePlanChangeView {
	return {
		...(change.label !== undefined && { label: change.label }),
		target: change.target,
		before: parseForView(change.seen),
		after: parseForView(change.next)
	}
}

function parseForView(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function planTitle(data: ChangePlanData): string {
	const [first, ...rest] = data.steps

	return rest.length === 0
		? (first?.title ?? 'Empty plan')
		: `${first?.title} and ${rest.length} more steps`
}

function planOutcome(data: ChangePlanData): string {
	const total = data.steps.length
	const applied = data.steps.filter((step) => step.status === 'applied').length

	switch (data.status) {
		case 'proposed':
			return 'waits for the user to confirm it; nothing is changed yet.'
		case 'applying':
			return `the user confirmed it and it is being applied (${applied} of ${total} steps so far).`
		case 'applied':
			return `the user confirmed it and all ${total} steps were applied.`
		case 'failed': {
			const failed = data.steps.findIndex((step) => step.status === 'failed')
			const reason = data.steps[failed]?.error?.message ?? ''

			return `stopped at step ${failed + 1} of ${total}: ${reason} ${applied} steps were applied.`
		}
		case 'discarded':
			return applied > 0
				? `discarded after ${applied} of ${total} steps were applied.`
				: 'not confirmed, so nothing was changed.'
		default:
			return 'not confirmed, so nothing was changed.'
	}
}

function stepError(
	code: Exclude<ChangePlanErrorCode, 'refused'>
): NonNullable<StoredPlanStep['error']> {
	return { code, message: CHANGE_PLAN_ERROR_SENTENCES[code] }
}

async function readPlan(
	store: ChatRecordStore,
	planId: string
): Promise<ChangePlanRecord | null> {
	return (await store.get(CHANGE_PLAN_KIND, planId)) as ChangePlanRecord | null
}

/** Writes `change` of the stored plan by compare-and-set, retrying on a conflict; undefined from `change` writes nothing. */
async function updatePlan(
	store: ChatRecordStore,
	planId: string,
	change: (data: ChangePlanData) => ChangePlanData | undefined,
	now: () => number = Date.now
): Promise<ChangePlanRecord | undefined> {
	for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt += 1) {
		const record = await readPlan(store, planId)

		if (!record) return undefined

		const data = change(record.data)

		if (!data) return record

		const next = withData(record, data, now)

		if (await store.put(next, record.version))
			return { ...next, version: record.version + 1 }
	}

	return undefined
}

function withData(
	record: ChangePlanRecord,
	data: ChangePlanData,
	now: () => number,
	version = record.version
): ChangePlanRecord {
	return {
		...record,
		version,
		data: { ...data, updatedAt: new Date(now()).toISOString() }
	}
}

function replaceAt<T>(
	items: readonly T[],
	index: number,
	change: (item: T) => T
): T[] {
	return items.map((item, at) => (at === index ? change(item) : item))
}

/** A dry run keeps its plan in memory on the request context, whatever the turn bound. */
function dryRunState(requestContext: RequestContext): TurnPlanState {
	const existing = turnPlans.get(requestContext)

	if (existing && dryRunStores.has(existing.binding.store)) return existing

	const store = createMemoryRecordStore()
	dryRunStores.add(store)
	const state: TurnPlanState = {
		binding: {
			store,
			threadId: 'dry-run',
			resourceId: 'dry-run',
			...(existing?.binding.caps && { caps: existing.binding.caps })
		},
		planId: undefined,
		queue: Promise.resolve()
	}
	turnPlans.set(requestContext, state)

	return state
}

const dryRunStores = new WeakSet<ChatRecordStore>()
