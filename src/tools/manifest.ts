/**
 * The tool manifest the client reads: every tool by name with its kind,
 * tier, card, the data it invalidates and its own extras, without the tool
 * itself, so a client bundle never imports server code.
 */

import type { DefinedTool, ToolKind } from './defineTool.js'

export interface ToolManifestEntry {
	readonly kind: ToolKind
	readonly tier: string
	readonly card: string
	readonly invalidates: readonly string[]
	readonly [extra: string]: unknown
}

export type ToolManifest = Readonly<Record<string, ToolManifestEntry>>

/** The manifest of the definitions, in their order. */
export function buildToolManifest(
	definitions: readonly DefinedTool[]
): ToolManifest {
	return Object.fromEntries(
		definitions.map((definition) => [
			definition.name,
			{
				...definition.manifest,
				kind: definition.kind,
				tier: definition.tier,
				card: definition.card,
				invalidates: definition.invalidates
			}
		])
	)
}

/** The source of a generated manifest module, which a client imports without the tools. */
export function renderToolManifestSource(
	manifest: ToolManifest,
	options: { readonly exportName?: string } = {}
): string {
	const exportName = options.exportName ?? 'toolManifest'

	return [
		'/**',
		' * The tool manifest, generated from the tool definitions by',
		' * `better-mastra-tool-manifest`. Do not edit it by hand.',
		' */',
		'',
		`export const ${exportName} = ${JSON.stringify(manifest, null, '\t')} as const`,
		''
	].join('\n')
}
