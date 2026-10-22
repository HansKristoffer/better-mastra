import type { EvalCase, EvalTrace } from './case.js'
import { checkTrace, type EvalCheck } from './checks.js'
import type { EvalCaseResult, EvalReport, EvalRun } from './report.js'
import { mapWithConcurrency } from './run.js'
import { getErrorMessage } from 'hanzio'

/** What `better-mastra-evals` loads from the app's `evals.config.ts` default export. */
export type EvalConfig<C extends EvalCase<unknown> = EvalCase<unknown>> = {
	cases: readonly C[] | (() => readonly C[] | Promise<readonly C[]>)
	defaultModel: string
	promptVersion: string
	/** Where JSON reports go; created with a `.gitignore` of `*`. Defaults to `.evals`. */
	outputDir?: string
	/** Before any model is called: check the seeded personas, the local database. */
	setup?: () => unknown
	/** After the last run: close pools so the process can exit. */
	teardown?: () => unknown
	/** One run of a case, usually `runEvalCase` with the app's production turn. */
	run: (testCase: C, options: { modelId: string }) => Promise<EvalTrace>
	/** Defaults to `checkTrace(testCase, trace)`. */
	check?: (testCase: C, trace: EvalTrace) => EvalCheck[]
	judge?: {
		version: string
		judge: (testCase: C, trace: EvalTrace) => Promise<unknown>
	}
	/**
	 * Suites that run one case at a time, such as prompt-cache probes:
	 * requests in flight together cannot read each other's cache writes.
	 */
	sequentialSuites?: readonly string[]
}

export function defineEvalConfig<C extends EvalCase<unknown>>(
	config: EvalConfig<C>
) {
	return config
}

/**
 * Runs every case `repeats` times on one model, checks and judges each run,
 * and returns the report. The CLI's `run`; callable from a script too.
 */
export async function runEvalSuite<C extends EvalCase<unknown>>(
	config: EvalConfig<C>,
	options: {
		cases: readonly C[]
		suite: string
		modelId?: string
		repeats?: number
		concurrency?: number
		judge?: boolean
		onRun?: (testCase: C, run: EvalRun) => void
	}
): Promise<EvalReport> {
	const repeats = options.repeats ?? 3
	const modelId = options.modelId ?? config.defaultModel
	const judge = options.judge === false ? undefined : config.judge
	const sequential = options.cases.some((testCase) =>
		testCase.suites.some((suite) => config.sequentialSuites?.includes(suite))
	)
	const jobs = options.cases.flatMap((testCase) =>
		Array.from({ length: repeats }, () => testCase)
	)
	const startedAt = new Date().toISOString()

	const runs = await mapWithConcurrency(
		jobs,
		sequential ? 1 : (options.concurrency ?? 3),
		async (testCase): Promise<EvalRun> => {
			const trace = await config.run(testCase, { modelId })
			const checks = (config.check ?? checkTrace)(testCase, trace)
			const pass = checks.every((check) => check.pass)
			let verdict: unknown = null
			let judgeError: string | null = null
			if (judge) {
				try {
					verdict = await judge.judge(testCase, trace)
				} catch (error) {
					judgeError = getErrorMessage(error)
				}
			}
			const run = { trace, checks, pass, verdict, judgeError }
			options.onRun?.(testCase, run)
			return run
		}
	)

	const results: EvalCaseResult[] = options.cases.map((testCase, index) => ({
		caseId: testCase.id,
		bucket: testCase.bucket,
		suites: testCase.suites,
		runs: runs.slice(index * repeats, (index + 1) * repeats)
	}))
	return {
		version: 1,
		startedAt,
		modelId,
		promptVersion: config.promptVersion,
		judgeVersion: judge?.version ?? null,
		suite: options.suite,
		repeats,
		results
	}
}

/** The cases a suite holds, or those whose id starts with one of the prefixes; throws when none match. */
export function selectCases<C extends EvalCase<unknown>>(
	cases: readonly C[],
	filter: { suite?: string; prefixes?: readonly string[]; tag?: string }
) {
	const prefixes = filter.prefixes ?? []
	const selected = cases.filter((testCase) =>
		prefixes.length
			? prefixes.some((prefix) => testCase.id.startsWith(prefix))
			: (filter.suite === undefined ||
					testCase.suites.includes(filter.suite)) &&
				(filter.tag === undefined || (testCase.tags ?? []).includes(filter.tag))
	)
	if (selected.length === 0) throw new Error('No eval case matches')
	return selected
}
