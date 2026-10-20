/**
 * What a turn plan costs on every step, in characters, for tests that hold a
 * prompt to its budget: the stable instructions (cached), the per-request
 * part and the signal (paid in full), and each tool's name, description and
 * input schema as Mastra sends them to the model.
 */

import type { ToolsInput } from '@mastra/core/agent'
import { makeCoreToolV5 } from '@mastra/core/utils'

import type { ChatTurnPlan } from './types.js'

export interface PromptBudget {
	readonly instructionsChars: number
	readonly perRequestChars: number
	/** Every tool's schema characters, by name. */
	readonly toolChars: Readonly<Record<string, number>>
	readonly toolSchemaChars: number
	/** The stable instructions and the tool schemas: the prefix the cache holds. */
	readonly cachedPrefixChars: number
}

export async function measurePromptBudget(
	plan: Pick<
		ChatTurnPlan,
		'instructions' | 'perRequestInstructions' | 'signal' | 'tools'
	>
): Promise<PromptBudget> {
	const toolChars = await measureToolSchemas(plan.tools ?? {})
	const toolSchemaChars = Object.values(toolChars).reduce((a, b) => a + b, 0)

	return {
		instructionsChars: plan.instructions.length,
		perRequestChars:
			(plan.perRequestInstructions?.length ?? 0) + (plan.signal?.length ?? 0),
		toolChars,
		toolSchemaChars,
		cachedPrefixChars: plan.instructions.length + toolSchemaChars
	}
}

/** Each tool's name, description and JSON Schema as the model receives them, in characters. */
export async function measureToolSchemas(
	tools: ToolsInput
): Promise<Record<string, number>> {
	const sizes: Record<string, number> = {}

	for (const [name, tool] of Object.entries(tools)) {
		const core = makeCoreToolV5(tool as never, { name } as never, 'tool')
		const schema = await (core.inputSchema as { jsonSchema: unknown })
			.jsonSchema

		sizes[name] = JSON.stringify({
			name,
			description: core.description,
			schema
		}).length
	}

	return sizes
}
