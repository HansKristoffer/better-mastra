/**
 * A large tool catalog without a large prompt, keeping the prompt cache.
 * Mastra's `ToolSearchProcessor` adds the tools a search finds to the tool
 * list on the next step, which changes the cached prefix and rebuilds the
 * cache. Here every tool is listed with Anthropic's `defer_loading`, and
 * `search_tools` answers with tool references, so a found tool loads inside
 * the conversation and the tool list never changes. Other providers ignore
 * both options; give them Mastra's processor instead.
 */

import { createTool, type Tool } from '@mastra/core/tools'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: any Mastra tool, whatever its schemas.
type AnyTool = Tool<any, any, any, any, any, any, any>

/** One tool in a deferred catalog, by the name the model calls it with. */
export interface DeferredToolEntry {
	readonly name: string
	readonly tool: AnyTool
}

/** Ranks the catalog against the model's query; returns the names, best first. */
export type DeferredToolRanking = (
	query: string,
	entries: readonly DeferredToolEntry[]
) => readonly string[]

const deferredCopies = new WeakMap<AnyTool, AnyTool>()
const searchTools = new Map<string, AnyTool>()

const DEFAULT_SEARCH_DESCRIPTION =
	'Find tools you cannot see yet by what you need to do (e.g. "list tasks assigned to me"). The tools it finds become available to call right away.'

const NO_MATCH =
	'No tool matches. Try other words, or tell the user this is not something you can do here.'

const searchOutputSchema = z.object({ found: z.array(z.string()) })

/**
 * The same tool, declared with Anthropic's `defer_loading`: listed in every
 * request, but kept out of the model's context until a tool reference loads
 * it. One copy per tool, so the tool list stays identical across requests.
 */
export function deferredTool<T extends AnyTool>(tool: T): T {
	let copy = deferredCopies.get(tool)

	if (!copy) {
		copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
			providerOptions: {
				...tool.providerOptions,
				anthropic: { ...tool.providerOptions?.anthropic, deferLoading: true }
			}
		}) as AnyTool
		deferredCopies.set(tool, copy)
	}

	return copy as T
}

/** A word in a tool's name counts three times a word in its description. */
export function rankToolsByName(topK = 5): DeferredToolRanking {
	return (query, entries) => {
		const wanted = new Set(words(query))

		return entries
			.map((entry) => {
				const name = new Set(words(entry.name))
				const description = new Set(words(entry.tool.description ?? ''))
				let score = 0

				for (const word of wanted) {
					if (name.has(word)) score += 3
					else if (description.has(word)) score += 1
				}

				return { name: entry.name, score }
			})
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map(({ name }) => name)
	}
}

/**
 * `search_tools` for a deferred catalog: it answers with tool references, so
 * the tools it finds load inside the conversation. One tool per `key`, which
 * names the catalog, so a request with the same catalog gets the same tool.
 */
export function deferredToolSearch(
	key: string,
	entries: readonly DeferredToolEntry[],
	options: {
		readonly topK?: number
		/** The search tool's description. */
		readonly describe?: string
		readonly rank?: DeferredToolRanking
	} = {}
): AnyTool {
	const cached = searchTools.get(key)

	if (cached) return cached

	const rank = options.rank ?? rankToolsByName(options.topK)
	const tool = createTool({
		id: 'search_tools',
		description: options.describe ?? DEFAULT_SEARCH_DESCRIPTION,
		inputSchema: z.object({
			query: z
				.string()
				.min(2)
				.describe('What you need to do, in a few English words')
		}),
		execute: async ({ query }) => ({ found: [...rank(query, entries)] }),
		// A tool reference cannot share a result with text, so a hit is
		// references only and a miss is text only.
		toModelOutput: (output) => {
			const { found } = searchOutputSchema.parse(output)

			return (
				found.length > 0
					? {
							type: 'content',
							value: found.map((toolName) => ({
								type: 'custom',
								providerOptions: {
									anthropic: { type: 'tool-reference', toolName }
								}
							}))
						}
					: { type: 'text', value: NO_MATCH }
			) as never
		}
	}) as AnyTool

	searchTools.set(key, tool)

	return tool
}

/** `workItem_getAll` becomes `work item get all`; words of three letters or more. */
function words(text: string): string[] {
	return (
		text
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.toLowerCase()
			.match(/\p{L}{3,}/gu) ?? []
	)
}
