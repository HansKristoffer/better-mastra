#!/usr/bin/env node
/**
 * `better-mastra-tool-manifest <module> <out> [export]`: imports the module,
 * reads its export (default `tools`, an array of `defineTool` results) and
 * writes the client manifest module to `out`.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DefinedTool } from './defineTool.js'
import { buildToolManifest, renderToolManifestSource } from './manifest.js'

const [modulePath, outPath, exportName = 'tools'] = process.argv.slice(2)

if (!modulePath || !outPath) {
	console.error('Usage: better-mastra-tool-manifest <module> <out> [export]')
	process.exit(1)
}

const loaded = (await import(
	pathToFileURL(resolve(modulePath)).href
)) as Record<string, unknown>
const definitions = loaded[exportName]

if (!Array.isArray(definitions)) {
	console.error(`${modulePath} has no array export named ${exportName}.`)
	process.exit(1)
}

await writeFile(
	resolve(outPath),
	renderToolManifestSource(buildToolManifest(definitions as DefinedTool[]))
)
console.log(`Wrote ${definitions.length} tools to ${outPath}.`)
