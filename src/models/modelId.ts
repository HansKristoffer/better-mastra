/**
 * Model ids without the registry: which route an id goes to, its provider
 * model and its pinned effort. Imports nothing but the effort rules, so code
 * that must not load the routes or their keys can read an id the same way
 * the registry does.
 */

import { splitModelEffort } from './effort.js'

export const BUILT_IN_ROUTES = [
	'vertex-eu',
	'openrouter',
	'openai-direct',
	'anthropic-direct',
	'requesty',
	'inception'
] as const

export type BuiltInRoute = (typeof BUILT_IN_ROUTES)[number]

/** The registry's default for an id without a route prefix: OpenRouter for `vendor/model`, Vertex for a bare model. */
export const defaultModelRoute = (modelId: string): string =>
	modelId.includes('/') ? 'openrouter' : 'vertex-eu'

export interface ParsedModelId {
	readonly route: string
	readonly providerModelId: string
	/** The effort the id pins with `@low|medium|high`; null when it pins none. */
	readonly effort: ReturnType<typeof splitModelEffort>['effort']
}

/**
 * `openrouter/google/gemini-3.5-flash@low` read as the registry reads it. A
 * prefix that names a route (built in, or one of `routes`) picks it; any
 * other id goes to `defaultRoute`. Throws for an id with no model.
 */
export function parseModelId(
	modelId: string,
	options: {
		/** The app's own route names, as `createLlmRegistry`'s `routes` keys. */
		readonly routes?: readonly string[]
		readonly defaultRoute?: (modelId: string) => string
	} = {}
): ParsedModelId {
	const separator = modelId.indexOf('/')
	const prefix = separator < 0 ? modelId : modelId.slice(0, separator)
	const prefixed =
		(BUILT_IN_ROUTES as readonly string[]).includes(prefix) ||
		(options.routes ?? []).includes(prefix)
	const route = prefixed
		? prefix
		: (options.defaultRoute ?? defaultModelRoute)(modelId)
	const withEffort = prefixed
		? separator < 0
			? ''
			: modelId.slice(separator + 1)
		: modelId
	if (!withEffort.trim() || withEffort !== withEffort.trim()) {
		throw new Error(`Missing or invalid model ID for ${route}`)
	}
	const { modelId: providerModelId, effort } = splitModelEffort(withEffort)
	return { route, providerModelId, effort }
}
