/**
 * What a turn plan costs on every step, in characters, for tests that hold a
 * prompt to its budget: the stable instructions (cached, every block), the per-request
 * part and the signal (paid in full), and each tool's name, description and
 * input schema as Mastra sends them to the model.
 */

import type { ToolsInput } from '@mastra/core/agent'
import { makeCoreToolV5 } from '@mastra/core/utils'
import { sumBy } from 'hanzio'

import { type ChatTurnPlan, stableInstructionBlocks } from './types.js'

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
	const toolSchemaChars = sumBy(Object.values(toolChars), (chars) => chars)
	const instructionsChars = sumBy(
		stableInstructionBlocks(plan.instructions),
		(block) => block.length
	)

	return {
		instructionsChars,
		perRequestChars:
			(plan.perRequestInstructions?.length ?? 0) + (plan.signal?.length ?? 0),
		toolChars,
		toolSchemaChars,
		cachedPrefixChars: instructionsChars + toolSchemaChars
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

/** What changed in the cached prefix (`tools` and stable `instructions`) between two turn plans. */
export interface PromptPrefixDiff {
	/** True when both plans send the exact same tool schemas and stable instruction blocks. */
	readonly cacheStable: boolean
	/** True when both plans send identical tool definitions (names, descriptions, schemas). */
	readonly sameTools: boolean
	readonly addedTools: readonly string[]
	readonly removedTools: readonly string[]
	readonly changedTools: readonly string[]
	/** True when all stable instruction blocks match identically. */
	readonly sameInstructionBlocks: boolean
	/** Index of the first differing stable instruction block, or null when identical. */
	readonly firstChangedBlockIndex: number | null
}

/**
 * Compares the cached prefix (`tools` + `clientTools` + stable `instructions`)
 * of two turn plans—for example across two pages or two users—to catch prompt
 * cache invalidations in CI tests.
 */
export async function diffPromptPrefixes(
	a: Pick<ChatTurnPlan, 'instructions' | 'tools' | 'clientTools'>,
	b: Pick<ChatTurnPlan, 'instructions' | 'tools' | 'clientTools'>
): Promise<PromptPrefixDiff> {
	const [toolsA, toolsB] = await Promise.all([
		serializeToolSchemas({ ...a.tools, ...a.clientTools }),
		serializeToolSchemas({ ...b.tools, ...b.clientTools })
	])
	const keysA = Object.keys(toolsA).sort()
	const keysB = Object.keys(toolsB).sort()
	const setA = new Set(keysA)
	const setB = new Set(keysB)

	const addedTools = keysB.filter((key) => !setA.has(key))
	const removedTools = keysA.filter((key) => !setB.has(key))
	const changedTools = keysA.filter(
		(key) => setB.has(key) && toolsA[key] !== toolsB[key]
	)
	const sameTools =
		addedTools.length === 0 &&
		removedTools.length === 0 &&
		changedTools.length === 0

	const blocksA = stableInstructionBlocks(a.instructions)
	const blocksB = stableInstructionBlocks(b.instructions)
	const maxLen = Math.max(blocksA.length, blocksB.length)
	let firstChangedBlockIndex: number | null = null
	for (let i = 0; i < maxLen; i += 1) {
		if (blocksA[i] !== blocksB[i]) {
			firstChangedBlockIndex = i
			break
		}
	}
	const sameInstructionBlocks = firstChangedBlockIndex === null

	return {
		cacheStable: sameTools && sameInstructionBlocks,
		sameTools,
		addedTools,
		removedTools,
		changedTools,
		sameInstructionBlocks,
		firstChangedBlockIndex
	}
}

async function serializeToolSchemas(
	tools: ToolsInput
): Promise<Record<string, string>> {
	const serialized: Record<string, string> = {}

	for (const name of Object.keys(tools).sort()) {
		const tool = tools[name]
		if (!tool) continue
		const core = makeCoreToolV5(tool as never, { name } as never, 'tool')
		const schema = await (core.inputSchema as { jsonSchema: unknown })
			.jsonSchema
		serialized[name] = JSON.stringify({
			name,
			description: core.description,
			schema,
			providerOptions: (tool as { providerOptions?: unknown }).providerOptions
		})
	}

	return serialized
}
