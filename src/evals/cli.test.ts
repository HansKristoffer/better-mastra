import { afterAll, describe, expect, test } from 'bun:test'
import {
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cliPath = join(import.meta.dir, 'cli.ts')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evals-cli-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

writeFileSync(
	join(dir, 'evals.config.ts'),
	`export default {
	defaultModel: 'test/model',
	promptVersion: 'v1',
	outputDir: 'reports',
	cases: [{ id: 'cli/ok', suites: ['smoke'], bucket: 'answer', persona: 'p', language: 'en', turns: ['Hi'], expect: {} }],
	run: async (testCase, { modelId }) => ({
		caseId: testCase.id,
		modelId,
		turns: [{ userText: 'Hi', replyText: 'Hello, how can I help you today?', toolCalls: [], heldForApproval: [], error: null, firstTextMs: 100, durationMs: 200, steps: 1, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, costUsd: 0 }]
	})
}
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

const summary = `Eval: smoke suite, test/model, prompt v1, 1x

PASS  1/1  cli/ok

Passed 1/1 runs (100%)
By bucket: answer 1/1
Not judged
First text p50 0.1 s, p90 0.1 s; turn p50 0.2 s; 1.0 steps a turn
Input from cache 0%, written to cache 0%; cost $0`

describe('better-mastra-evals', () => {
	test('help', () => {
		expect(cli('--help')).toEqual({
			exitCode: 0,
			stdout: `better-mastra-evals
Real turns through the app's production turn, scored by checks and a judge

Usage: better-mastra-evals <command> [options]

Commands:
  run                    Run a suite and save its report
  inspect                Print a report's failed checks and transcripts
  compare                Compare a candidate report with a baseline
  completion <bash|zsh>  Print a shell completion script

Options:
  -h, --help  Show help

Run "better-mastra-evals <command> --help" for a command's options.
`,
			stderr: ''
		})
	})

	test('run help', () => {
		expect(cli('run', '--help').stdout)
			.toBe(`Usage: better-mastra-evals run [options]

Run a suite and save its report

Options:
  --config <string>       Eval config module (default: "evals.config.ts")
  --suite <string>        Suite to run (default: "smoke")
  --case <string>...      Only cases whose id starts with this
  --tag <string>          Only cases with this tag
  --repeats <number>      Runs per case (default: 3)
  --concurrency <number>  Cases in flight (default: 3)
  --model <string>...     Model to run on; several print a comparison
  --[no-]judge            Score runs with the config judge (default: true)
  --compare <string>      Baseline report to compare with
  --output <string>       Report file to write; several models add -<model>
  --verbose               Keep app console logs
  -h, --help              Show help
`)
	})

	test('inspect help', () => {
		expect(cli('inspect', '--help').stdout)
			.toBe(`Usage: better-mastra-evals inspect <report> [options]

Print a report's failed checks and transcripts

Arguments:
  <report>  Report file

Options:
  --case <string>...  Only cases whose id starts with this
  -h, --help          Show help
`)
	})

	test('compare help', () => {
		expect(cli('compare', '--help').stdout)
			.toBe(`Usage: better-mastra-evals compare <baseline> <candidate> [options]

Compare a candidate report with a baseline

Arguments:
  <baseline>   Baseline report file
  <candidate>  Candidate report file

Options:
  -h, --help  Show help
`)
	})

	// One run writes the report the inspect and compare tests read.
	let report = ''

	test('run is the default command', () => {
		const result = cli('--repeats', '1', '--no-judge')
		const [file] = readdirSync(join(dir, 'reports')).filter((name) =>
			name.endsWith('.json')
		)
		report = join(dir, 'reports', file ?? '')
		expect(result).toEqual({
			exitCode: 0,
			stdout: `${summary}\n\n${report}\n\n`,
			stderr: 'Running 1 cases x1 on test/model\npass cli/ok\n'
		})
	})

	test('inspect', () => {
		expect(cli('inspect', report, '--case', 'cli')).toEqual({
			exitCode: 0,
			stdout: `
=== cli/ok #1 pass

  User: Hi
  Assistant (0.1s, 1 steps): Hello, how can I help you today?
`,
			stderr: ''
		})
	})

	test('compare', () => {
		expect(cli('compare', report, report)).toEqual({
			exitCode: 0,
			stdout: `| | v1 (test/model) | v1 (test/model) |
| --- | --- | --- |
| Passed runs | 1/1 (100%) | 1/1 (100%) |
| First text p50 / p90 | 0.1 s / 0.1 s | 0.1 s / 0.1 s |
| Steps a turn | 1.0 | 1.0 |
| Input from cache | 0% | 0% |
| Cost | $0.0000 | $0.0000 |

No case changed its pass count.
`,
			stderr: ''
		})
	})
})
