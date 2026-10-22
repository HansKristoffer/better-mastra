#!/usr/bin/env node
// better-mastra-evals: real turns through the app's production turn, scored
// by hard checks and a judge, against the app's `evals.config.ts`.
// `better-mastra-evals --help` lists the commands; `run` is the default.
//
// Several --model values run the suite on each and print a model comparison.
// Run it with Bun (`bunx --bun better-mastra-evals`) or Node 22.18+ so the
// TypeScript config loads.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod'
import { must } from 'hanzio'
import type { EvalCase } from './case.js'
import { type EvalConfig, runEvalSuite, selectCases } from './config.js'
import {
	compareReports,
	type EvalReport,
	formatModelComparison,
	formatReport
} from './report.js'

const runInput = z.object({
	config: z.string().default('evals.config.ts').describe('Eval config module'),
	suite: z.string().default('smoke').describe('Suite to run'),
	case: z.array(z.string()).describe('Only cases whose id starts with this'),
	tag: z.string().optional().describe('Only cases with this tag'),
	repeats: z.number().default(3).describe('Runs per case'),
	concurrency: z.number().default(3).describe('Cases in flight'),
	model: z
		.array(z.string())
		.describe('Model to run on; several print a comparison'),
	judge: z.boolean().default(true).describe('Score runs with the config judge'),
	compare: z.string().optional().describe('Baseline report to compare with'),
	output: z
		.string()
		.optional()
		.describe('Report file to write; several models add -<model>'),
	verbose: z.boolean().describe('Keep app console logs')
})

type RunInput = z.output<typeof runInput>

async function loadConfig(path: string): Promise<EvalConfig> {
	const file = resolve(path)
	const module = await import(pathToFileURL(file).href)
	return must(module.default, () => new Error(`${file} has no default export`))
}

async function readReport(file: string): Promise<EvalReport> {
	return JSON.parse(await readFile(file, 'utf8'))
}

/** `--output` for one model, with the model before the extension when several run. */
function outputFile(output: string, modelId: string, models: number) {
	if (models === 1) return resolve(output)
	const model = modelId.replaceAll('/', '_')
	const dot = output.lastIndexOf('.')
	return resolve(
		dot > output.lastIndexOf('/')
			? `${output.slice(0, dot)}-${model}${output.slice(dot)}`
			: `${output}-${model}`
	)
}

async function save(config: EvalConfig, report: EvalReport, output?: string) {
	if (output) {
		await writeFile(output, `${JSON.stringify(report, null, '\t')}\n`)
		return output
	}
	const dir = resolve(config.outputDir ?? '.evals')
	await mkdir(dir, { recursive: true })
	const ignore = resolve(dir, '.gitignore')
	if (!(await stat(ignore).catch(() => null))) await writeFile(ignore, '*\n')
	const file = resolve(
		dir,
		`${report.startedAt.replaceAll(':', '-')}-${report.suite}-${report.modelId.replaceAll('/', '_')}.json`
	)
	await writeFile(file, `${JSON.stringify(report, null, '\t')}\n`)
	return file
}

/** Apps log to the console; while cases run that buries the progress lines. */
function silenceLogs(verbose: boolean) {
	if (verbose) return () => {}
	const { log, info, debug } = console
	console.log = console.info = console.debug = () => {}
	return () => Object.assign(console, { log, info, debug })
}

async function run(values: RunInput) {
	const config = await loadConfig(values.config)
	try {
		return await runWith(config, values)
	} finally {
		await config.teardown?.()
	}
}

async function runWith(config: EvalConfig, values: RunInput) {
	await config.setup?.()
	const all =
		typeof config.cases === 'function' ? await config.cases() : config.cases
	const prefixes = values.case
	const cases: readonly EvalCase<unknown>[] = selectCases(all, {
		suite: values.suite,
		prefixes,
		...(values.tag ? { tag: values.tag } : {})
	})
	const models = values.model.length ? values.model : [config.defaultModel]
	const reports: EvalReport[] = []
	for (const modelId of models) {
		console.error(
			`Running ${cases.length} cases x${values.repeats} on ${modelId}${config.judge && values.judge ? ', judged' : ''}`
		)
		const restore = silenceLogs(values.verbose)
		const report = await runEvalSuite(config, {
			cases,
			suite: prefixes.length ? 'selected' : values.suite,
			modelId,
			repeats: values.repeats,
			concurrency: values.concurrency,
			judge: values.judge,
			onRun: (testCase, result) =>
				console.error(`${result.pass ? 'pass' : 'FAIL'} ${testCase.id}`)
		}).finally(restore)
		console.log(formatReport(report))
		const output =
			values.output && outputFile(values.output, modelId, models.length)
		console.log(`\n${await save(config, report, output)}\n`)
		reports.push(report)
	}
	if (reports.length > 1) console.log(formatModelComparison(reports))
	const [first, ...rest] = reports
	for (const report of rest) {
		if (first) console.log(`\n${compareReports(first, report)}`)
	}
	if (values.compare && first) {
		console.log(`\n${compareReports(await readReport(values.compare), first)}`)
	}
	const failed = reports.some((report) =>
		report.results.some((result) => result.runs.some((r) => !r.pass))
	)
	return failed ? 1 : 0
}

function inspect(report: EvalReport, prefixes: readonly string[]) {
	for (const result of report.results) {
		if (
			prefixes.length &&
			!prefixes.some((prefix) => result.caseId.startsWith(prefix))
		)
			continue
		result.runs.forEach((run, index) => {
			console.log(
				`\n=== ${result.caseId} #${index + 1} ${run.pass ? 'pass' : 'FAIL'}`
			)
			for (const check of run.checks.filter((check) => !check.pass)) {
				console.log(
					`  ✗ ${check.check}${check.detail ? ` (${check.detail})` : ''}`
				)
			}
			if (run.verdict) console.log(`  judge: ${JSON.stringify(run.verdict)}`)
			if (run.judgeError) console.log(`  judge failed: ${run.judgeError}`)
			for (const turn of run.trace.turns) {
				console.log(`\n  User: ${turn.userText}`)
				for (const call of turn.toolCalls) {
					console.log(
						`    ${call.name} [${call.state}] ${JSON.stringify(call.input).slice(0, 200)}${call.errorText ? ` ERROR ${call.errorText}` : ''}`
					)
				}
				console.log(
					`  Assistant (${turn.firstTextMs === null ? '-' : `${(turn.firstTextMs / 1000).toFixed(1)}s`}, ${turn.steps} steps): ${turn.replyText}`
				)
			}
		})
	}
}

const cli = defineCli({
	name: 'better-mastra-evals',
	description:
		"Real turns through the app's production turn, scored by checks and a judge",
	// `better-mastra-evals` alone, or with options first, runs `run`.
	defaultCommand: 'run',
	commands: {
		run: defineCommand({
			description: 'Run a suite and save its report',
			input: runInput,
			run: async (input, ctx) => {
				ctx.exitCode = await run(input)
			}
		}),
		inspect: defineCommand({
			description: "Print a report's failed checks and transcripts",
			input: z.object({
				report: z.string().meta({ positional: true }).describe('Report file'),
				case: z
					.array(z.string())
					.describe('Only cases whose id starts with this')
			}),
			run: async (input) => inspect(await readReport(input.report), input.case)
		}),
		compare: defineCommand({
			description: 'Compare a candidate report with a baseline',
			input: z.object({
				baseline: z
					.string()
					.meta({ positional: true })
					.describe('Baseline report file'),
				candidate: z
					.string()
					.meta({ positional: true })
					.describe('Candidate report file')
			}),
			run: async (input) =>
				compareReports(
					await readReport(input.baseline),
					await readReport(input.candidate)
				)
		})
	}
})

// App pools (database, Redis) keep the event loop alive after the last run.
process.exit(await cli.run())
