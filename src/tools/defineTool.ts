/**
 * One definition per agent tool: the Mastra tool itself (made here with
 * `createTool`'s options, or made elsewhere, such as by orpc-fn's
 * `createMastraTool`) and what the chat knows about it: its tier, its card,
 * the data a write invalidates, the inputs the turn fills in from the request
 * context instead of the model, and the compact text the model reads. The
 * turn's tool set and the client's manifest both derive from these.
 */

import type { RequestContext } from '@mastra/core/request-context'
import { createTool, type Tool } from '@mastra/core/tools'
import { keyBy, mapValues, omit, stableStringify } from 'hanzio'

import {
	CHANGE_UNREAD_SENTENCE,
	type ToolChange,
	type ToolChangeCall
} from './changes.js'
import { dryRunResult, isDryRun, isDryRunResult } from './dryRun.js'
import { compactToolInputSchema, withHiddenInputs } from './toolInputSchema.js'

type CreateToolOptions = Parameters<typeof createTool>[0]

// biome-ignore lint/suspicious/noExplicitAny: any Mastra tool, whatever its schemas.
type AnyTool = Tool<any, any, any, any, any, any, any>

/** A tier: `read` runs at once, `approval` waits for the user's approval. Apps may add their own. */
export type ToolTier = 'read' | 'approval' | (string & {})

/** Where the tool runs: on the server, or without `execute` in the client (`addToolOutput`). */
export type ToolKind = 'server' | 'client'

/**
 * An error whose message the model may read as it is: input the tool cannot
 * act on, a missing permission. With `maskErrors`, every other error a tool
 * throws reaches the model as one fixed sentence.
 */
export class ToolRefusal extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'ToolRefusal'
	}
}

/** What the model reads for a masked error, unless the definition says otherwise. */
export const TOOL_ERROR_SENTENCE =
	'The tool failed for a reason on our side. Do not retry it; tell the user it did not work.'

/** What `maskErrors` does with an error that is not a `ToolRefusal`. */
export interface ToolErrorMasking {
	/** What the model reads instead. Default `TOOL_ERROR_SENTENCE`. */
	readonly sentence?: string
	/**
	 * Treats matching errors as user-facing refusals (their message reaches the
	 * model as-is), e.g. for `orpc-fn` tools that already throw formatted
	 * refusals as plain `Error`s.
	 */
	readonly isRefusal?: (error: unknown) => boolean
	/** The error the model does not see, for the log. */
	readonly onError?: (
		error: unknown,
		event: { readonly tool: string; readonly requestContext?: RequestContext }
	) => void
}

export interface ToolDefinition<
	TTier extends ToolTier = ToolTier,
	TCard extends string = string,
	TMeta = undefined
> {
	/** The tool, or `createTool`'s options for it. */
	readonly tool: AnyTool | CreateToolOptions
	readonly tier: TTier
	/** How the client draws the result. Default `generic`. */
	readonly card?: TCard
	/** Data namespaces a write changes, which the client refetches. */
	readonly invalidates?: readonly string[]
	/**
	 * Inputs the model never sees, filled in from the run's request context:
	 * the value replaces anything the model sent. A value of undefined leaves
	 * the input out.
	 */
	readonly hiddenInputs?: Readonly<
		Record<string, (requestContext: RequestContext) => unknown>
	>
	/** Caps every list in a write's input, so one change stays one Undo. */
	readonly maxArrayItems?: number
	/** The compact text the model reads instead of the full result; the client still gets the result. */
	readonly toModelOutput?: (output: never) => unknown
	/**
	 * Caps the serialized size of the output sent to the model (in characters)
	 * while keeping the full structured output intact for UI cards. Oversized
	 * payloads are truncated with a note asking the model to narrow its query.
	 */
	readonly maxModelOutputChars?: number
	/**
	 * For `tier: 'read'` tools: memoizes identical calls within the same turn's
	 * `requestContext` so repeated lookups avoid duplicate DB/API round trips.
	 * Automatically invalidated if any non-read tool runs in the same turn.
	 */
	readonly memoizePerTurn?: boolean
	/** JSON-only extras for the client manifest, such as how a confirm card shows the input. */
	readonly manifest?: Readonly<Record<string, unknown>>
	/**
	 * A write's change: its confirm fields, the guard and the read before the
	 * write, and the result with its undo record, which replaces what
	 * `execute` returns. A refusal of the guard reaches the model as it is.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: each tool types its own change; the definition only runs it.
	readonly change?: ToolChange<any, any, any, any>
	/** The server's own data about the tool (a gate, a permission); never reaches the manifest. */
	readonly meta?: TMeta
	/**
	 * Hides what the tool's errors say from the model, the stored thread and
	 * the client: a `ToolRefusal`'s message and an abort pass through, any
	 * other error becomes one fixed sentence. `true` uses the defaults.
	 */
	readonly maskErrors?: boolean | ToolErrorMasking
	/**
	 * How string format checks are sent in the tool's JSON schema. Defaults to
	 * `'compact'`, stripping verbose Zod/oRPC format regexes while keeping
	 * runtime validation untouched. Pass `'full'` to keep the original schema.
	 */
	readonly stringChecks?: 'compact' | 'full'
}

export interface DefinedTool<
	TTier extends ToolTier = ToolTier,
	TCard extends string = string,
	TMeta = unknown
> {
	/** The name the model, the stream and the manifest know the tool by. */
	readonly name: string
	readonly tool: AnyTool
	readonly kind: ToolKind
	readonly tier: TTier
	readonly card: TCard | 'generic'
	readonly invalidates: readonly string[]
	readonly manifest: Readonly<Record<string, unknown>>
	readonly meta: TMeta
}

/** Per-turn read-tool result cache scoped to a requestContext; auto-invalidated on any write tool call. */
const turnReadCache = new WeakMap<object, Map<string, Promise<unknown>>>()

/**
 * Truncates an oversized tool output for the model to `maxChars` characters,
 * returning `{ type: 'text', value }` when clipped or `undefined` when it
 * already fits.
 */
export function truncateModelOutput(
	output: unknown,
	maxChars: number
): { readonly type: 'text'; readonly value: string } | undefined {
	if (maxChars <= 0) return undefined
	const text =
		typeof output === 'string'
			? output
			: (JSON.stringify(output) ?? String(output))
	if (text.length <= maxChars) return undefined
	const omitted = text.length - maxChars
	return {
		type: 'text',
		value: `${text.slice(0, maxChars)}\n\n[Truncated ${omitted} chars. Narrow your query or request specific fields/pages.]`
	}
}

/**
 * Declares one tool. Tier `approval` asks for approval before `execute`
 * runs; a tool without `execute` is a client tool. In a dry run
 * (`markDryRun`) a tool of any tier but `read` answers with a marker.
 */
export function defineTool<
	const TTier extends ToolTier,
	const TCard extends string = 'generic',
	TMeta = undefined
>(
	definition: ToolDefinition<TTier, TCard, TMeta>
): DefinedTool<TTier, TCard, TMeta> {
	const base = isTool(definition.tool)
		? definition.tool
		: createTool(definition.tool)
	const hidden = definition.hiddenInputs ?? {}
	const hiddenNames = Object.keys(hidden)
	// Mastra's tool validates its input before it calls the function it wraps.
	// With hidden inputs that second pass is the only check of the filled
	// values, so it stays; without them the outer tool already validated the
	// same input, so the function the options name runs directly.
	const baseExecute =
		hiddenNames.length === 0 && !isTool(definition.tool)
			? definition.tool.execute
			: base.execute
	const toModelOutput = definition.toModelOutput
	const maxModelOutputChars = definition.maxModelOutputChars
	// Only a read is safe to run in an eval's dry run.
	const honoursDryRun = definition.tier !== 'read'
	const memoizesReads =
		definition.tier === 'read' && definition.memoizePerTurn === true
	const masking =
		definition.maskErrors === true ? {} : definition.maskErrors || undefined
	const { change } = definition
	const run = (
		input: unknown,
		context: { requestContext?: RequestContext }
	) => {
		if (honoursDryRun && isDryRun(context?.requestContext)) {
			return dryRunResult(base.id)
		}

		const requestContext = context?.requestContext
		if (honoursDryRun && requestContext) {
			// Any non-read tool invalidates memoized read results in the same turn.
			turnReadCache.delete(requestContext)
		}

		const filled = fillHiddenInputs(input, hidden, requestContext)
		const execute = () => baseExecute!(filled, context as never)

		if (memoizesReads && requestContext) {
			let cache = turnReadCache.get(requestContext)
			if (!cache) {
				cache = new Map()
				turnReadCache.set(requestContext, cache)
			}
			const cacheKey = `${base.id}\0${stableStringify(filled)}`
			const cached = cache.get(cacheKey)
			if (cached) return cached

			const pending = Promise.resolve().then(execute)
			cache.set(cacheKey, pending)
			pending.catch(() => {
				if (cache?.get(cacheKey) === pending) cache.delete(cacheKey)
			})
			return pending
		}

		return change
			? makeChange(change, base.id, execute, {
					input: filled,
					requestContext
				})
			: execute()
	}

	const inputSchemaWithHidden =
		base.inputSchema &&
		(hiddenNames.length > 0 || definition.maxArrayItems !== undefined)
			? withHiddenInputs(base.inputSchema, hiddenNames, {
					maxArrayItems: definition.maxArrayItems
				})
			: base.inputSchema
	const nextInputSchema =
		inputSchemaWithHidden &&
		definition.stringChecks !== 'full' &&
		'~standard' in inputSchemaWithHidden
			? compactToolInputSchema(inputSchemaWithHidden)
			: inputSchemaWithHidden

	const hasModelOutputHook =
		toModelOutput !== undefined ||
		(maxModelOutputChars !== undefined && maxModelOutputChars > 0)

	const tool = createTool({
		...(base as CreateToolOptions),
		...(nextInputSchema && { inputSchema: nextInputSchema }),
		requireApproval:
			definition.tier === 'approval' || base.requireApproval === true,
		...(baseExecute && {
			execute: masking
				? async (
						input: unknown,
						context: {
							requestContext?: RequestContext
							abortSignal?: AbortSignal
						}
					) => {
						try {
							return await run(input, context)
						} catch (error) {
							throw maskedError(error, base.id, context, masking)
						}
					}
				: run
		}),
		...(hasModelOutputHook && {
			toModelOutput: (output: unknown) => {
				if (isDryRunResult(output)) {
					return { type: 'text', value: JSON.stringify(output) }
				}

				const raw = toModelOutput ? toModelOutput(output as never) : output
				if (maxModelOutputChars !== undefined && maxModelOutputChars > 0) {
					const payload =
						typeof raw === 'object' &&
						raw !== null &&
						'type' in raw &&
						(raw as { type?: unknown }).type === 'text' &&
						'value' in raw &&
						typeof (raw as { value?: unknown }).value === 'string'
							? (raw as { value: string }).value
							: raw
					const clipped = truncateModelOutput(payload, maxModelOutputChars)
					if (clipped) return clipped
				}

				if (toModelOutput) {
					return typeof raw === 'string' ? { type: 'text', value: raw } : raw
				}

				return typeof raw === 'string'
					? { type: 'text', value: raw }
					: { type: 'json', value: raw }
			}
		})
	} as CreateToolOptions) as AnyTool

	return {
		name: tool.id,
		tool,
		kind: baseExecute ? 'server' : 'client',
		tier: definition.tier,
		card: definition.card ?? 'generic',
		invalidates: definition.invalidates ?? [],
		manifest: {
			...(change?.confirmFields && { confirmFields: change.confirmFields }),
			...definition.manifest
		},
		meta: definition.meta as TMeta
	}
}

/**
 * One write: the guard, the read before, the write, then the result with its
 * undo record. Once the write has happened, a failure must not tell the
 * model that nothing changed.
 */
async function makeChange(
	change: ToolChange,
	tool: string,
	execute: () => unknown,
	call: ToolChangeCall
): Promise<unknown> {
	const refusal = await change.guard?.(call)

	if (refusal !== undefined) throw new ToolRefusal(refusal)

	const before = await change.readBefore(call)
	const output = await execute()

	try {
		return await change.toResult({ ...call, before, output })
	} catch (error) {
		change.onUnread?.(error, { tool })

		throw new ToolRefusal(change.unreadSentence ?? CHANGE_UNREAD_SENTENCE, {
			cause: error
		})
	}
}

function maskedError(
	error: unknown,
	tool: string,
	context:
		{ requestContext?: RequestContext; abortSignal?: AbortSignal } | undefined,
	masking: ToolErrorMasking
): unknown {
	const aborted =
		context?.abortSignal?.aborted === true ||
		(error instanceof Error && error.name === 'AbortError')

	if (error instanceof ToolRefusal || aborted || masking.isRefusal?.(error)) {
		return error
	}

	masking.onError?.(error, {
		tool,
		...(context?.requestContext && { requestContext: context.requestContext })
	})

	return new ToolRefusal(masking.sentence ?? TOOL_ERROR_SENTENCE, {
		cause: error
	})
}

/** The Mastra tools of the definitions by name, and each one's tier, for a turn plan. */
export function toToolSet(definitions: readonly DefinedTool[]): {
	readonly tools: Record<string, AnyTool>
	readonly toolTiers: Record<string, string>
} {
	const byName = keyBy(definitions, 'name')

	return {
		tools: mapValues(byName, (tool) => tool.tool),
		toolTiers: mapValues(byName, (tool) => tool.tier)
	}
}

/** `budget.getBudget` becomes `budget_getBudget`, a name every provider accepts. */
export function toToolName(name: string): string {
	return name.replaceAll('.', '_')
}

function fillHiddenInputs(
	input: unknown,
	hidden: Readonly<Record<string, (requestContext: RequestContext) => unknown>>,
	requestContext: RequestContext | undefined
): unknown {
	const names = Object.keys(hidden)

	if (names.length === 0) return input

	if (!requestContext) {
		throw new Error('A tool with hidden inputs ran without a request context.')
	}

	const visible = omit((input ?? {}) as Record<string, unknown>, names)
	const filled = Object.fromEntries(
		names.flatMap((name) => {
			const value = hidden[name]?.(requestContext)

			return value === undefined ? [] : [[name, value]]
		})
	)

	return { ...visible, ...filled }
}

/** `createTool`'s options are a plain object; a tool is a class instance, from whichever copy of Mastra made it. */
function isTool(value: AnyTool | CreateToolOptions): value is AnyTool {
	return Object.getPrototypeOf(value) !== Object.prototype
}
