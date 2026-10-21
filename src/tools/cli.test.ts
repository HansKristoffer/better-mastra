import { afterAll, describe, expect, test } from 'bun:test'
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool } from './defineTool.js'
import { buildToolManifest, renderToolManifestSource } from './manifest.js'

const cliPath = join(import.meta.dir, 'cli.ts')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tool-manifest-cli-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const toolSource = `{
	tool: {
		id: 'budget_get',
		description: 'Gets the budget.',
		inputSchema: z.object({ month: z.string() }),
		execute: async () => ({ ok: true })
	},
	tier: 'read'
}`
writeFileSync(
	join(dir, 'tools.ts'),
	`import { z } from 'zod'
import { defineTool } from ${JSON.stringify(join(import.meta.dir, 'defineTool.ts'))}
export const assistantTools = [defineTool(${toolSource})]
`
)

function cli(...args: string[]) {
	const result = Bun.spawnSync(['bun', cliPath, ...args], { cwd: dir })
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString()
	}
}

describe('better-mastra-tool-manifest', () => {
	test('help', () => {
		expect(cli('--help')).toEqual({
			exitCode: 0,
			stdout: `Usage: better-mastra-tool-manifest <module> <out> [export] [options]

Write the client tool manifest module for a tools export

Arguments:
  <module>  Module that exports the tools
  <out>     File to write
  [export]  Export holding the defineTool array (default: "tools")

Options:
  -h, --help  Show help
`,
			stderr: ''
		})
	})

	test('writes the manifest for the named export', () => {
		expect(cli('tools.ts', 'manifest.ts', 'assistantTools')).toEqual({
			exitCode: 0,
			stdout: 'Wrote 1 tools to manifest.ts.\n',
			stderr: ''
		})
		const tool = defineTool({
			tool: {
				id: 'budget_get',
				description: 'Gets the budget.',
				inputSchema: z.object({ month: z.string() }),
				execute: async () => ({ ok: true })
			},
			tier: 'read'
		})
		expect(readFileSync(join(dir, 'manifest.ts'), 'utf8')).toBe(
			renderToolManifestSource(buildToolManifest([tool]))
		)
	})

	test('fails on a missing export', () => {
		expect(cli('tools.ts', 'manifest.ts')).toEqual({
			exitCode: 1,
			stdout: '',
			stderr: 'tools.ts has no array export named tools.\n'
		})
	})
})
