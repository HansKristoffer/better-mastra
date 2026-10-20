#!/usr/bin/env node
// better-mastra-evals: real turns through the app's production turn, scored
// by hard checks and a judge, against the app's `evals.config.ts`.
//
//   better-mastra-evals run [--suite smoke] [--case <id-prefix>]... [--tag <tag>]
//                       [--repeats 3] [--concurrency 3] [--model <id>]...
//                       [--no-judge] [--compare <baseline.json>] [--verbose]
//   better-mastra-evals inspect <report.json> [--case <id-prefix>]...
//   better-mastra-evals compare <baseline.json> <candidate.json>
//
// Several --model values run the suite on each and print a model comparison.
// Run it with Bun (`bunx --bun better-mastra-evals`) or Node 22.18+ so the
// TypeScript config loads.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { EvalCase } from './case.js'
import { type EvalConfig, runEvalSuite, selectCases } from './config.js'
import {
	compareReports,
	type EvalReport,
	formatModelComparison,
	formatReport
} from './report.js'

const { positionals, values } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		config: { type: 'string', default: 'evals.config.ts' },
		suite: { type: 'string', default: 'smoke' },
		case: { type: 'string', multiple: true },
		tag: { type: 'string' },
		repeats: { type: 'string', default: '3' },
		concurrency: { type: 'string', default: '3' },
		model: { type: 'string', multiple: true },
		'no-judge': { type: 'boolean', default: false },
		compare: { type: 'string' },
		verbose: { type: 'boolean', default: false }
	}
})

async function loadConfig(): Promise<EvalConfig> {
	const file = resolve(values.config)
	const module = await import(pathToFileURL(file).href)
	if (!module.default) throw new Error(`${file} has no default export`)
	return module.default
}

async function readReport(file: string): Promise<EvalReport> {
	return JSON.parse(await readFile(file, 'utf8'))
}

async function save(config: EvalConfig, report: EvalReport) {
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
function silenceLogs() {
	if (values.verbose) return () => {}
	const { log, info, debug } = console
	console.log = console.info = console.debug = () => {}
	return () => Object.assign(console, { log, info, debug })
}

async function run() {
	const config = await loadConfig()
	try {
		await runWith(config)
	} finally {
		await config.teardown?.()
	}
}

async function runWith(config: EvalConfig) {
	await config.setup?.()
	const all =
		typeof config.cases === 'function' ? await config.cases() : config.cases
	const prefixes = values.case ?? []
	const cases: readonly EvalCase<unknown>[] = selectCases(all, {
		suite: values.suite,
		prefixes,
		...(values.tag ? { tag: values.tag } : {})
	})
	const models = values.model?.length ? values.model : [config.defaultModel]
	const reports: EvalReport[] = []
	for (const modelId of models) {
		console.error(
			`Running ${cases.length} cases x${values.repeats} on ${modelId}${config.judge && !values['no-judge'] ? ', judged' : ''}`
		)
		const restore = silenceLogs()
		const report = await runEvalSuite(config, {
			cases,
			suite: prefixes.length ? 'selected' : values.suite,
			modelId,
			repeats: Number(values.repeats),
			concurrency: Number(values.concurrency),
			judge: !values['no-judge'],
			onRun: (testCase, result) =>
				console.error(`${result.pass ? 'pass' : 'FAIL'} ${testCase.id}`)
		}).finally(restore)
		console.log(formatReport(report))
		console.log(`\n${await save(config, report)}\n`)
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
	if (failed) process.exitCode = 1
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

const command = positionals[0] ?? 'run'
switch (command) {
	case 'run':
		await run()
		break
	case 'inspect': {
		const file = positionals[1]
		if (!file) throw new Error('inspect needs a report file')
		inspect(await readReport(file), values.case ?? [])
		break
	}
	case 'compare': {
		const [, baseline, candidate] = positionals
		if (!baseline || !candidate)
			throw new Error('compare needs two report files')
		console.log(
			compareReports(await readReport(baseline), await readReport(candidate))
		)
		break
	}
	default:
		throw new Error(`Unknown command ${command}: run, inspect or compare`)
}

// App pools (database, Redis) keep the event loop alive after the last run.
process.exit()
