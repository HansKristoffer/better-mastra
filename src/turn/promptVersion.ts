import { createHash } from 'node:crypto'

/** A tool as the prompt version reads it; a `defineTool` result fits. */
export interface PromptVersionTool {
	readonly name: string
	readonly tier?: string
	readonly description?: string
	readonly tool?: { readonly description?: string }
}

/**
 * Which prompt produced an answer: a short hash of the prompt copy and every
 * tool's name, tier and description. It changes only when a deploy changes
 * that copy, never per user or page, so ratings, latency, cache and cost can
 * be split by it around a rollout.
 */
export function promptVersion(input: {
	/** Every prompt section the app writes, in any JSON shape. */
	readonly sections: unknown
	readonly tools: readonly PromptVersionTool[]
}): string {
	const tools = input.tools
		.map((tool) => ({
			name: tool.name,
			tier: tool.tier ?? null,
			description: tool.description ?? tool.tool?.description ?? ''
		}))
		.sort((a, b) => a.name.localeCompare(b.name))

	return createHash('sha256')
		.update(JSON.stringify({ sections: input.sections, tools }))
		.digest('hex')
		.slice(0, 12)
}
