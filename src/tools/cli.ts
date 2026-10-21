#!/usr/bin/env node
/**
 * `better-mastra-tool-manifest <module> <out> [export]`: imports the module,
 * reads its export (default `tools`, an array of `defineTool` results) and
 * writes the client manifest module to `out`.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError, defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod'

import type { DefinedTool } from './defineTool.js'
import { buildToolManifest, renderToolManifestSource } from './manifest.js'

const cli = defineCli({
	name: 'better-mastra-tool-manifest',
	commands: defineCommand({
		description: 'Write the client tool manifest module for a tools export',
		input: z.object({
			module: z
				.string()
				.meta({ positional: true })
				.describe('Module that exports the tools'),
			out: z.string().meta({ positional: true }).describe('File to write'),
			export: z
				.string()
				.default('tools')
				.meta({ positional: true })
				.describe('Export holding the defineTool array')
		}),
		run: async (input) => {
			const loaded = (await import(
				pathToFileURL(resolve(input.module)).href
			)) as Record<string, unknown>
			const definitions = loaded[input.export]
			if (!Array.isArray(definitions))
				throw new CliError(
					`${input.module} has no array export named ${input.export}.`
				)
			await writeFile(
				resolve(input.out),
				renderToolManifestSource(
					buildToolManifest(definitions as DefinedTool[])
				)
			)
			return `Wrote ${definitions.length} tools to ${input.out}.`
		}
	})
})

process.exitCode = await cli.run()
