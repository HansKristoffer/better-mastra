import type { EvalTrace } from './case.js'
import type { EvalCheck } from './checks.js'

export type EvalRun<Verdict = unknown> = {
	trace: EvalTrace
	checks: EvalCheck[]
	pass: boolean
	verdict: Verdict | null
	judgeError: string | null
}

export type EvalCaseResult<Verdict = unknown> = {
	caseId: string
	bucket: string
	suites: readonly string[]
	runs: EvalRun<Verdict>[]
}

export type EvalReport<Verdict = unknown> = {
	version: 1
	startedAt: string
	modelId: string
	promptVersion: string
	judgeVersion: string | null
	suite: string
	repeats: number
	results: EvalCaseResult<Verdict>[]
}

/** The nearest-rank percentile; null without values. */
export function percentile(values: readonly number[], rank: number) {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	return (
		sorted[Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)] ?? null
	)
}

function share(part: number, whole: number) {
	return whole === 0 ? null : part / whole
}

/**
 * The judge's shares: every boolean field's share of true, and `outcome`'s
 * share of `done` (as `done`), whatever the verdict schema.
 */
function judgeShares(verdicts: readonly unknown[]) {
	const objects = verdicts.filter(
		(verdict): verdict is Record<string, unknown> =>
			typeof verdict === 'object' && verdict !== null
	)
	const keys = new Set(objects.flatMap((verdict) => Object.keys(verdict)))
	const shares: Record<string, number | null> = {}
	for (const key of keys) {
		const values = objects.map((verdict) => verdict[key])
		if (key === 'outcome') {
			shares.done = share(
				values.filter((value) => value === 'done').length,
				values.length
			)
		} else if (values.every((value) => typeof value === 'boolean')) {
			shares[key] = share(values.filter(Boolean).length, values.length)
		}
	}
	return shares
}

/** The numbers a report and a comparison print: rates with their counts, and what it cost in time and money. */
export function summarize(results: readonly EvalCaseResult[]) {
	const runs = results.flatMap((result) => result.runs)
	const turns = runs.flatMap((run) => run.trace.turns)
	const verdicts = runs.flatMap((run) => (run.verdict ? [run.verdict] : []))
	const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0)
	const costs = turns.map((turn) => turn.costUsd)
	const firstTexts = turns.flatMap((turn) =>
		turn.firstTextMs === null ? [] : [turn.firstTextMs]
	)
	const passed = runs.filter((run) => run.pass).length

	return {
		runs: runs.length,
		passed,
		passRate: share(passed, runs.length),
		byBucket: Object.fromEntries(
			[...new Set(results.map((result) => result.bucket))].map((bucket) => {
				const bucketRuns = results
					.filter((result) => result.bucket === bucket)
					.flatMap((result) => result.runs)
				return [
					bucket,
					{
						passed: bucketRuns.filter((run) => run.pass).length,
						runs: bucketRuns.length
					}
				]
			})
		),
		judged: verdicts.length,
		judge: judgeShares(verdicts),
		firstTextMsP50: percentile(firstTexts, 50),
		firstTextMsP90: percentile(firstTexts, 90),
		firstTextMsP95: percentile(firstTexts, 95),
		durationMsP50: percentile(
			turns.map((turn) => turn.durationMs),
			50
		),
		stepsPerTurn: share(
			turns.reduce((sum, turn) => sum + turn.steps, 0),
			turns.length
		),
		cacheReadShare: share(
			turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0),
			inputTokens
		),
		cacheWriteShare: share(
			turns.reduce((sum, turn) => sum + turn.cacheWriteTokens, 0),
			inputTokens
		),
		costUsd: costs.includes(null)
			? null
			: Number(
					costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0).toFixed(4)
				),
		costPerTurnP50: costs.includes(null)
			? null
			: percentile(costs as number[], 50)
	}
}

export type EvalSummary = ReturnType<typeof summarize>

const percent = (value: number | null | undefined) =>
	value === null || value === undefined ? '-' : `${Math.round(value * 100)}%`
const seconds = (value: number | null) =>
	value === null ? '-' : `${(value / 1000).toFixed(1)} s`
const dollars = (value: number | null) =>
	value === null ? '-' : `$${value.toFixed(4)}`

/** PASS when every repeat passed, FAIL when none did, FLAKY between. */
export function caseMark(result: EvalCaseResult) {
	const passed = result.runs.filter((run) => run.pass).length
	return passed === result.runs.length
		? 'PASS'
		: passed === 0
			? 'FAIL'
			: 'FLAKY'
}

function caseLine(result: EvalCaseResult) {
	const passed = result.runs.filter((run) => run.pass).length
	const failures = [
		...new Set(
			result.runs.flatMap((run) =>
				run.checks
					.filter((check) => !check.pass)
					.map((check) =>
						check.detail ? `${check.check} (${check.detail})` : check.check
					)
			)
		)
	]
	return [
		`${caseMark(result).padEnd(5)} ${passed}/${result.runs.length}  ${result.caseId}`,
		...failures.map((failure) => `        - ${failure}`)
	].join('\n')
}

/** The terminal report of one run. */
export function formatReport(report: EvalReport) {
	const summary = summarize(report.results)
	return [
		`Eval: ${report.suite} suite, ${report.modelId}, prompt ${report.promptVersion}, ${report.repeats}x`,
		'',
		...report.results.map(caseLine),
		'',
		`Passed ${summary.passed}/${summary.runs} runs (${percent(summary.passRate)})`,
		`By bucket: ${Object.entries(summary.byBucket)
			.map(([bucket, { passed, runs }]) => `${bucket} ${passed}/${runs}`)
			.join(', ')}`,
		summary.judged
			? `Judged ${summary.judged}: ${Object.entries(summary.judge)
					.map(([key, value]) => `${key} ${percent(value)}`)
					.join(', ')}`
			: 'Not judged',
		`First text p50 ${seconds(summary.firstTextMsP50)}, p90 ${seconds(summary.firstTextMsP90)}; turn p50 ${seconds(summary.durationMsP50)}; ${summary.stepsPerTurn?.toFixed(1) ?? '-'} steps a turn`,
		`Input from cache ${percent(summary.cacheReadShare)}, written to cache ${percent(summary.cacheWriteShare)}; cost ${summary.costUsd === null ? 'unknown' : `$${summary.costUsd}`}`
	].join('\n')
}

const passCount = (result: EvalCaseResult | undefined) =>
	result
		? `${result.runs.filter((run) => run.pass).length}/${result.runs.length}`
		: '-'

/**
 * The before/after table a PR carries: the summary rows, then every case
 * whose pass count moved. Markdown, so it pastes into the PR body.
 */
export function compareReports(baseline: EvalReport, candidate: EvalReport) {
	const before = summarize(baseline.results)
	const after = summarize(candidate.results)
	const baselineById = new Map(
		baseline.results.map((result) => [result.caseId, result])
	)
	const moved = candidate.results.filter(
		(result) => passCount(baselineById.get(result.caseId)) !== passCount(result)
	)
	const judgeKeys = [
		...new Set([...Object.keys(before.judge), ...Object.keys(after.judge)])
	]

	return [
		`| | ${baseline.promptVersion} (${baseline.modelId}) | ${candidate.promptVersion} (${candidate.modelId}) |`,
		'| --- | --- | --- |',
		`| Passed runs | ${before.passed}/${before.runs} (${percent(before.passRate)}) | ${after.passed}/${after.runs} (${percent(after.passRate)}) |`,
		...judgeKeys.map(
			(key) =>
				`| ${key} (judge) | ${percent(before.judge[key])} | ${percent(after.judge[key])} |`
		),
		`| First text p50 / p90 | ${seconds(before.firstTextMsP50)} / ${seconds(before.firstTextMsP90)} | ${seconds(after.firstTextMsP50)} / ${seconds(after.firstTextMsP90)} |`,
		`| Steps a turn | ${before.stepsPerTurn?.toFixed(1) ?? '-'} | ${after.stepsPerTurn?.toFixed(1) ?? '-'} |`,
		`| Input from cache | ${percent(before.cacheReadShare)} | ${percent(after.cacheReadShare)} |`,
		`| Cost | ${dollars(before.costUsd)} | ${dollars(after.costUsd)} |`,
		'',
		moved.length
			? [
					'| Case | Before | After |',
					'| --- | --- | --- |',
					...moved.map(
						(result) =>
							`| ${result.caseId} | ${passCount(baselineById.get(result.caseId))} | ${passCount(result)} |`
					)
				].join('\n')
			: 'No case changed its pass count.'
	].join('\n')
}

/** One row per model: pass rate, time to first text, cost per turn, cache share. */
export function formatModelComparison(reports: readonly EvalReport[]) {
	const rows = reports.map((report) => {
		const summary = summarize(report.results)
		return [
			report.modelId,
			percent(summary.passRate),
			percent(summary.judge.done),
			seconds(summary.firstTextMsP50),
			seconds(summary.firstTextMsP95),
			dollars(summary.costPerTurnP50),
			dollars(summary.costUsd),
			percent(summary.cacheReadShare)
		]
	})
	return [
		[
			'model',
			'passed',
			'done (judge)',
			'first text p50',
			'p95',
			'cost/turn p50',
			'cost',
			'cache read'
		],
		['---', '---', '---', '---', '---', '---', '---', '---'],
		...rows
	]
		.map((cells) => `| ${cells.join(' | ')} |`)
		.join('\n')
}

/**
 * Precision and recall per label of labelled runs (what a memory extractor
 * kept against what it should keep), plus how often the kept set agrees.
 */
export function scoreLabels<L extends string>(
	labels: readonly L[],
	runs: readonly { id: string; expected: readonly L[]; kept: readonly L[] }[]
) {
	const agrees = (run: (typeof runs)[number]) =>
		run.kept.length === run.expected.length &&
		run.kept.every((label) => run.expected.includes(label))
	const shareOr0 = (part: number, whole: number) => share(part, whole) ?? 0
	return {
		runs: runs.length,
		keepRate: shareOr0(
			runs.filter((run) => run.kept.length > 0).length,
			runs.length
		),
		agreement: shareOr0(runs.filter(agrees).length, runs.length),
		labels: Object.fromEntries(
			labels.map((label) => {
				const kept = runs.filter((run) => run.kept.includes(label))
				const shouldKeep = runs.filter((run) => run.expected.includes(label))
				const correct = kept.filter((run) => run.expected.includes(label))
				return [
					label,
					{
						kept: kept.length,
						shouldKeep: shouldKeep.length,
						keptCorrectly: correct.length,
						precision: share(correct.length, kept.length),
						recall: share(correct.length, shouldKeep.length)
					}
				]
			})
		) as Record<
			L,
			{
				kept: number
				shouldKeep: number
				keptCorrectly: number
				precision: number | null
				recall: number | null
			}
		>,
		failures: runs.filter((run) => !agrees(run))
	}
}
