#!/usr/bin/env node
/**
 * `better-mastra-tool-manifest <module> <out> [export]`: imports the module,
 * reads its export (default `tools`, an array of `defineTool` results) and
 * writes the client manifest module to `out`. `--check` writes nothing and
 * fails when `out` is not what it would write, for CI.
 */

import { readFile, writeFile } from 'node:fs/promises'
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
				.describe('Export holding the defineTool array'),
			name: z
				.string()
				.default('toolManifest')
				.describe('Name of the generated export'),
			type: z
				.string()
				.regex(/^[A-Za-z_$][\w$]*:.+$/, 'Expected <Type>:<module>')
				.optional()
				.describe(
					'Annotate the export with <Type>:<module> instead of as const'
				),
			check: z
				.boolean()
				.describe('Write nothing; fail when <out> is out of date')
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
			const separator = input.type?.indexOf(':') ?? -1
			const source = renderToolManifestSource(
				buildToolManifest(definitions as DefinedTool[]),
				{
					exportName: input.name,
					...(input.type && {
						type: {
							name: input.type.slice(0, separator),
							from: input.type.slice(separator + 1)
						}
					})
				}
			)
			const out = resolve(input.out)
			if (input.check) {
				const current = await readFile(out, 'utf8').catch(() => undefined)
				if (current !== source)
					throw new CliError(
						`${input.out} is out of date: run better-mastra-tool-manifest without --check.`
					)
				return `${input.out} is up to date.`
			}
			await writeFile(out, source)
			return `Wrote ${definitions.length} tools to ${input.out}.`
		}
	})
})

process.exitCode = await cli.run()
