/**
 * The tool manifest the client reads: every tool by name with its kind,
 * tier, card, the data it invalidates and its own extras, without the tool
 * itself, so a client bundle never imports server code.
 */

import type { DefinedTool, ToolKind } from './defineTool.js'

export interface ToolManifestEntry<TKind extends string = ToolKind> {
	readonly kind: TKind
	readonly tier: string
	readonly card: string
	readonly invalidates: readonly string[]
	readonly [extra: string]: unknown
}

export type ToolManifest<TKind extends string = ToolKind> = Readonly<
	Record<string, ToolManifestEntry<TKind>>
>

/**
 * The manifest of the definitions, in their order. `kind` names each tool's
 * kind in the app's own words; default `server` or `client`.
 */
export function buildToolManifest<TKind extends string = ToolKind>(
	definitions: readonly DefinedTool[],
	options: { readonly kind?: (definition: DefinedTool) => TKind } = {}
): ToolManifest<TKind> {
	return Object.fromEntries(
		definitions.map((definition) => [
			definition.name,
			{
				...definition.manifest,
				kind: options.kind?.(definition) ?? (definition.kind as TKind),
				tier: definition.tier,
				card: definition.card,
				invalidates: definition.invalidates
			}
		])
	)
}

/**
 * The source of a generated manifest module, which a client imports without
 * the tools, written as Biome writes it with single quotes and no
 * semicolons. With `type` the export is annotated with the app's manifest
 * type; without it the object is `as const`.
 */
export function renderToolManifestSource(
	manifest: ToolManifest<string>,
	options: {
		readonly exportName?: string
		readonly type?: { readonly name: string; readonly from: string }
		/** The command that wrote it, for the header. */
		readonly generatedBy?: string
	} = {}
): string {
	const exportName = options.exportName ?? 'toolManifest'
	const value = renderValue(manifest, 0, exportName.length + 16)

	return [
		'/**',
		' * The tool manifest, generated from the tool definitions by',
		` * \`${options.generatedBy ?? 'better-mastra-tool-manifest'}\`. Do not edit it by hand.`,
		' */',
		'',
		...(options.type
			? [
					`import type { ${options.type.name} } from '${options.type.from}'`,
					'',
					`export const ${exportName}: ${options.type.name} = ${value}`
				]
			: [`export const ${exportName} = ${value} as const`]),
		''
	].join('\n')
}

const LINE_WIDTH = 80
const TAB_WIDTH = 2
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `used` is the width of the line before the value, for a list that may fit on it. */
function renderValue(value: unknown, depth: number, used: number): string {
	if (Array.isArray(value)) return renderArray(value, depth, used)

	if (typeof value === 'object' && value !== null) {
		return renderObject(value as Record<string, unknown>, depth)
	}

	return typeof value === 'string' ? quote(value) : String(value ?? 'undefined')
}

// An object stays expanded, as Biome keeps one whose first key starts a line.
function renderObject(value: Record<string, unknown>, depth: number): string {
	const entries = Object.entries(value).filter(([, item]) => item !== undefined)

	if (entries.length === 0) return '{}'

	const indent = '\t'.repeat(depth + 1)
	const lines = entries.map(([key, item]) => {
		const name = IDENTIFIER.test(key) ? key : quote(key)
		const used = (depth + 1) * TAB_WIDTH + name.length + 2

		return `${indent}${name}: ${renderValue(item, depth + 1, used)}`
	})

	return `{\n${lines.join(',\n')}\n${'\t'.repeat(depth)}}`
}

// A list of plain values fits on one line when Biome would keep it there.
function renderArray(
	value: readonly unknown[],
	depth: number,
	used: number
): string {
	if (value.length === 0) return '[]'

	const isFlat = value.every(
		(item) => typeof item !== 'object' || item === null
	)
	const inline = `[${value.map((item) => renderValue(item, depth, 0)).join(', ')}]`

	// The comma after the value, as the entry is not the last, counts too.
	if (isFlat && used + inline.length + 1 <= LINE_WIDTH) return inline

	const indent = '\t'.repeat(depth + 1)
	const lines = value.map(
		(item) =>
			`${indent}${renderValue(item, depth + 1, (depth + 1) * TAB_WIDTH)}`
	)

	return `[\n${lines.join(',\n')}\n${'\t'.repeat(depth)}]`
}

function quote(text: string): string {
	const escaped = JSON.stringify(text)
		.slice(1, -1)
		.replaceAll('\\"', '"')
		.replaceAll("'", "\\'")

	return `'${escaped}'`
}
