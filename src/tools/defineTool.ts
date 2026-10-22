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

import { dryRunResult, isDryRun, isDryRunResult } from './dryRun.js'
import { withHiddenInputs } from './toolInputSchema.js'
import { omit } from 'hanzio'

type CreateToolOptions = Parameters<typeof createTool>[0]

// biome-ignore lint/suspicious/noExplicitAny: any Mastra tool, whatever its schemas.
type AnyTool = Tool<any, any, any, any, any, any, any>

/** A tier: `read` runs at once, `approval` waits for the user's approval. Apps may add their own. */
export type ToolTier = 'read' | 'approval' | (string & {})

/** Where the tool runs: on the server, or without `execute` in the client (`addToolOutput`). */
export type ToolKind = 'server' | 'client'

export interface ToolDefinition<
	TTier extends ToolTier = ToolTier,
	TCard extends string = string
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
	/** JSON-only extras for the client manifest, such as how a confirm card shows the input. */
	readonly manifest?: Readonly<Record<string, unknown>>
}

export interface DefinedTool<
	TTier extends ToolTier = ToolTier,
	TCard extends string = string
> {
	/** The name the model, the stream and the manifest know the tool by. */
	readonly name: string
	readonly tool: AnyTool
	readonly kind: ToolKind
	readonly tier: TTier
	readonly card: TCard | 'generic'
	readonly invalidates: readonly string[]
	readonly manifest: Readonly<Record<string, unknown>>
}

/**
 * Declares one tool. Tier `approval` asks for approval before `execute`
 * runs; a tool without `execute` is a client tool. In a dry run
 * (`markDryRun`) a tool of any tier but `read` answers with a marker.
 */
export function defineTool<
	const TTier extends ToolTier,
	const TCard extends string = 'generic'
>(definition: ToolDefinition<TTier, TCard>): DefinedTool<TTier, TCard> {
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
	// Only a read is safe to run in an eval's dry run.
	const honoursDryRun = definition.tier !== 'read'

	const tool = createTool({
		...(base as CreateToolOptions),
		...(base.inputSchema &&
			(hiddenNames.length > 0 || definition.maxArrayItems !== undefined) && {
				inputSchema: withHiddenInputs(base.inputSchema, hiddenNames, {
					maxArrayItems: definition.maxArrayItems
				})
			}),
		requireApproval:
			definition.tier === 'approval' || base.requireApproval === true,
		...(baseExecute && {
			execute: (
				input: unknown,
				context: { requestContext?: RequestContext }
			) =>
				honoursDryRun && isDryRun(context?.requestContext)
					? dryRunResult(base.id)
					: baseExecute(
							fillHiddenInputs(input, hidden, context?.requestContext),
							context as never
						)
		}),
		...(toModelOutput && {
			toModelOutput: (output: unknown) => {
				if (isDryRunResult(output)) {
					return { type: 'text', value: JSON.stringify(output) }
				}

				const model = toModelOutput(output as never)

				return typeof model === 'string'
					? { type: 'text', value: model }
					: model
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
		manifest: definition.manifest ?? {}
	}
}

/** The Mastra tools of the definitions by name, and each one's tier, for a turn plan. */
export function toToolSet(definitions: readonly DefinedTool[]): {
	readonly tools: Record<string, AnyTool>
	readonly toolTiers: Record<string, string>
} {
	return {
		tools: Object.fromEntries(
			definitions.map((tool) => [tool.name, tool.tool])
		),
		toolTiers: Object.fromEntries(
			definitions.map((tool) => [tool.name, tool.tier])
		)
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
