/**
 * A large tool catalog without a large prompt, keeping the prompt cache.
 * Mastra's `ToolSearchProcessor` adds the tools a search finds to the tool
 * list on the next step, which changes the cached prefix and rebuilds the
 * cache. Here every tool is listed with Anthropic's `defer_loading`, and
 * `search_tools` answers with tool references, so a found tool loads inside
 * the conversation and the tool list never changes. Other providers ignore
 * both options; give them Mastra's processor instead.
 */

import type { InputProcessor } from '@mastra/core/processors'
import { createTool, type Tool } from '@mastra/core/tools'
import { z } from 'zod'
import { sortBy } from 'hanzio'

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

const MAX_CACHED_SEARCH_TOOLS = 256
const deferredCopies = new WeakMap<AnyTool, AnyTool>()
const searchTools = new Map<string, AnyTool>()

/** Common 2-letter stopwords excluded from ranking while preserving domain abbreviations (`id`, `ai`, `hr`, `pr`, `db`, `ui`). */
const TWO_CHAR_STOPWORDS = new Set([
	'am',
	'an',
	'as',
	'at',
	'be',
	'by',
	'do',
	'go',
	'he',
	'if',
	'in',
	'is',
	'it',
	'me',
	'my',
	'no',
	'of',
	'on',
	'or',
	'so',
	'to',
	'up',
	'us',
	'we'
])

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

/**
 * A word in a tool's name counts three times a word in its description, with
 * prefix/stem matching so singular/plural and verb inflections (`task` vs
 * `tasks`, `delete` vs `deleting`) still match.
 */
export function rankToolsByName(topK = 5): DeferredToolRanking {
	return (query, entries) => {
		const wanted = [...new Set(words(query))]
		if (wanted.length === 0) return []

		const scored = entries
			.map((entry) => {
				const nameTokens = words(entry.name)
				const descTokens = words(entry.tool.description ?? '')
				const nameSet = new Set(nameTokens)
				const descSet = new Set(descTokens)
				let score = 0

				for (const word of wanted) {
					if (nameSet.has(word)) {
						score += 3
					} else if (matchesStem(word, nameTokens)) {
						score += 2
					} else if (descSet.has(word)) {
						score += 1
					} else if (matchesStem(word, descTokens)) {
						score += 0.7
					}
				}

				return { name: entry.name, score }
			})
			.filter(({ score }) => score > 0)

		return sortBy(scored, { by: 'score', order: 'desc' })
			.slice(0, topK)
			.map(({ name }) => name)
	}
}

/**
 * `search_tools` for a deferred catalog: it answers with tool references, so
 * the tools it finds load inside the conversation. One tool per `key` (LRU
 * capped at 256 catalogs), so a request with the same catalog gets the same tool.
 */
export function deferredToolSearch(
	key: string,
	entries: readonly DeferredToolEntry[],
	options: {
		readonly topK?: number
		/** The search tool's description. */
		readonly describe?: string
		readonly rank?: DeferredToolRanking
		/**
		 * When `false`, returns plain text listing matched tool names instead of
		 * Anthropic `tool-reference` blocks (used with `createDeferredToolSupport`
		 * on non-Anthropic providers). Defaults to `true`.
		 */
		readonly anthropicToolReferences?: boolean
	} = {}
): AnyTool {
	const useReferences = options.anthropicToolReferences !== false
	const cacheKey = `${useReferences ? 'ref' : 'txt'}\0${key}`
	const cached = searchTools.get(cacheKey)

	if (cached) {
		searchTools.delete(cacheKey)
		searchTools.set(cacheKey, cached)
		return cached
	}

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

			if (found.length === 0) return { type: 'text', value: NO_MATCH } as never

			return (
				useReferences
					? {
							type: 'content',
							value: found.map((toolName) => ({
								type: 'custom',
								providerOptions: {
									anthropic: { type: 'tool-reference', toolName }
								}
							}))
						}
					: {
							type: 'text',
							value: `Loaded tools: ${found.join(', ')}. You can call them now.`
						}
			) as never
		}
	}) as AnyTool

	if (searchTools.size >= MAX_CACHED_SEARCH_TOOLS) {
		const oldest = searchTools.keys().next().value
		if (oldest !== undefined) searchTools.delete(oldest)
	}
	searchTools.set(cacheKey, tool)

	return tool
}

/**
 * Provider-aware deferred tools: on Anthropic direct (`deferLoading: true`),
 * every deferred tool stays in `tools` with Anthropic's `defer_loading` and
 * `search_tools` returns tool references so the prompt cache never changes. On
 * other providers, only `search_tools` is mounted initially and a lightweight
 * input processor mounts tools returned by `search_tools` on subsequent steps.
 */
export function createDeferredToolSupport(options: {
	readonly key: string
	readonly entries: readonly DeferredToolEntry[]
	/** True for `anthropic-direct` (supports `defer_loading` + `tool-reference`). */
	readonly supportsAnthropicDeferLoading: boolean
	readonly topK?: number
	readonly describe?: string
	readonly rank?: DeferredToolRanking
}): {
	readonly tools: Record<string, AnyTool>
	readonly inputProcessors: readonly InputProcessor[]
} {
	if (options.entries.length === 0) {
		return { tools: {}, inputProcessors: [] }
	}

	if (options.supportsAnthropicDeferLoading) {
		const tools: Record<string, AnyTool> = {
			search_tools: deferredToolSearch(options.key, options.entries, {
				...(options.topK !== undefined && { topK: options.topK }),
				...(options.describe !== undefined && { describe: options.describe }),
				...(options.rank !== undefined && { rank: options.rank }),
				anthropicToolReferences: true
			})
		}
		for (const entry of options.entries) {
			tools[entry.name] = deferredTool(entry.tool)
		}
		return { tools, inputProcessors: [] }
	}

	const byName = new Map(
		options.entries.map((entry) => [entry.name, entry.tool])
	)
	const search = deferredToolSearch(options.key, options.entries, {
		...(options.topK !== undefined && { topK: options.topK }),
		...(options.describe !== undefined && { describe: options.describe }),
		...(options.rank !== undefined && { rank: options.rank }),
		anthropicToolReferences: false
	})

	const revealProcessor: InputProcessor = {
		id: 'better-mastra-deferred-tools',
		processInputStep: ({ messages, tools }) => {
			const revealed = findRevealedToolNames(messages)
			if (revealed.size === 0) return

			const nextTools: Record<string, unknown> = { ...(tools ?? {}) }
			let changed = false
			for (const name of revealed) {
				if (name in nextTools) continue
				const found = byName.get(name)
				if (found) {
					nextTools[name] = found
					changed = true
				}
			}
			if (changed) return { tools: nextTools as never }
		}
	}

	return {
		tools: { search_tools: search },
		inputProcessors: [revealProcessor]
	}
}

function findRevealedToolNames(messages: readonly unknown[]): Set<string> {
	const found = new Set<string>()
	for (const message of messages) {
		if (!message || typeof message !== 'object') continue
		const content = (message as { content?: { parts?: readonly unknown[] } })
			.content
		const parts = Array.isArray(content)
			? content
			: Array.isArray(content?.parts)
				? content.parts
				: []
		for (const part of parts) {
			if (!part || typeof part !== 'object') continue
			const p = part as {
				type?: string
				toolInvocation?: { toolName?: string; result?: unknown }
				toolName?: string
				output?: unknown
				result?: unknown
			}
			const toolName = p.toolInvocation?.toolName ?? p.toolName
			if (toolName !== 'search_tools') continue
			const result = p.toolInvocation?.result ?? p.output ?? p.result
			const parsed = searchOutputSchema.safeParse(result)
			if (parsed.success) {
				for (const name of parsed.data.found) found.add(name)
			}
		}
	}
	return found
}

function stem(word: string): string {
	if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
	if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
	if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
	if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
	return word
}

function matchesStem(wanted: string, candidates: readonly string[]): boolean {
	if (wanted.length < 3) return false
	const wantedStem = stem(wanted)
	for (const candidate of candidates) {
		if (candidate.length < 3) continue
		const candidateStem = stem(candidate)
		if (
			wantedStem === candidateStem ||
			(wantedStem.length >= 4 && candidate.startsWith(wantedStem)) ||
			(candidateStem.length >= 4 && wanted.startsWith(candidateStem))
		) {
			return true
		}
	}
	return false
}

/** `workItem_getAll` becomes `work item get all`; keeps meaningful 2-letter abbreviations (`id`, `ai`, `hr`, `db`). */
function words(text: string): string[] {
	return (
		text
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.toLowerCase()
			.match(/\p{L}{2,}/gu) ?? []
	).filter((word) => word.length >= 3 || !TWO_CHAR_STOPWORDS.has(word))
}
