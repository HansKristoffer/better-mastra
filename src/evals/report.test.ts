import { describe, expect, test } from 'bun:test'
import type { EvalCase, EvalTurn } from './case.js'
import { runEvalSuite } from './config.js'
import {
	caseMark,
	compareReports,
	type EvalCaseResult,
	type EvalReport,
	formatModelComparison,
	formatReport,
	percentile,
	scoreLabels,
	summarize
} from './report.js'

function turn(overrides: Partial<EvalTurn> = {}): EvalTurn {
	return {
		userText: 'q',
		replyText: 'a',
		toolCalls: [],
		heldForApproval: [],
		error: null,
		firstTextMs: 1000,
		durationMs: 2000,
		steps: 2,
		inputTokens: 1000,
		cacheReadTokens: 250,
		cacheWriteTokens: 100,
		outputTokens: 50,
		costUsd: 0.01,
		...overrides
	}
}

function result(
	caseId: string,
	bucket: string,
	passes: boolean[],
	verdict: unknown = null
): EvalCaseResult {
	return {
		caseId,
		bucket,
		suites: ['smoke'],
		runs: passes.map((pass) => ({
			trace: { caseId, modelId: 'm', turns: [turn()] },
			checks: pass ? [] : [{ check: 'calls deal_get', pass: false }],
			pass,
			verdict,
			judgeError: null
		}))
	}
}

const report = (
	results: EvalCaseResult[],
	modelId = 'model/a'
): EvalReport => ({
	version: 1,
	startedAt: '2026-10-20T10:00:00.000Z',
	modelId,
	promptVersion: 'p1',
	judgeVersion: 'j1',
	suite: 'smoke',
	repeats: 2,
	results
})

test('a percentile is the nearest-ranked value, and null without values', () => {
	const times = [900, 100, 800, 200, 700, 300, 600, 400, 500, 1000]
	expect([
		percentile(times, 50),
		percentile(times, 95),
		percentile([], 50)
	]).toEqual([500, 1000, null])
})

describe('a summary', () => {
	test('counts pass rates per bucket, judge shares, latency, cache and cost', () => {
		const summary = summarize([
			result('a', 'answer', [true, true], {
				outcome: 'done',
				grounded: true,
				frictions: []
			}),
			result('b', 'act', [true, false], {
				outcome: 'partly',
				grounded: false,
				frictions: []
			})
		])
		expect(summary).toEqual(
			expect.objectContaining({
				runs: 4,
				passed: 3,
				passRate: 0.75,
				byBucket: {
					answer: { passed: 2, runs: 2 },
					act: { passed: 1, runs: 2 }
				},
				judged: 4,
				judge: { done: 0.5, grounded: 0.5 },
				firstTextMsP50: 1000,
				stepsPerTurn: 2,
				cacheReadShare: 0.25,
				cacheWriteShare: 0.1,
				costUsd: 0.04,
				costPerTurnP50: 0.01
			})
		)
	})

	test('an unknown cost makes the total unknown', () => {
		const unknown = result('a', 'answer', [true])
		unknown.runs[0]!.trace.turns.push(
			turn({ costUsd: null, firstTextMs: null })
		)
		expect(summarize([unknown]).costUsd).toBeNull()
	})
})

test('a case is PASS, FLAKY or FAIL by its repeats', () => {
	expect(
		[
			[true, true],
			[true, false],
			[false, false]
		].map((passes) => caseMark(result('c', 'answer', passes)))
	).toEqual(['PASS', 'FLAKY', 'FAIL'])
})

test('the report lists failures and the summary lines', () => {
	const text = formatReport(
		report([result('deals/open', 'answer', [true, false])])
	)
	expect(text).toContain('FLAKY 1/2  deals/open')
	expect(text).toContain('        - calls deal_get')
	expect(text).toContain('Passed 1/2 runs (50%)')
})

test('a comparison lists the cases whose pass count moved', () => {
	const before = report([
		result('a', 'answer', [true, true]),
		result('b', 'act', [false, false])
	])
	const after = report(
		[result('a', 'answer', [true, true]), result('b', 'act', [true, false])],
		'model/b'
	)
	const table = compareReports(before, after)
	expect(table).toContain('| Passed runs | 2/4 (50%) | 3/4 (75%) |')
	expect(table).toContain('| b | 0/2 | 1/2 |')
	expect(table).not.toContain('| a |')
})

test('a model comparison has one row per model', () => {
	const table = formatModelComparison([
		report([result('a', 'answer', [true])], 'model/a'),
		report([result('a', 'answer', [false])], 'model/b')
	])
	expect(table.split('\n')).toEqual([
		'| model | passed | done (judge) | first text p50 | p95 | cost/turn p50 | cost | cache read |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |',
		'| model/a | 100% | - | 1.0 s | 1.0 s | $0.0100 | $0.0100 | 25% |',
		'| model/b | 0% | - | 1.0 s | 1.0 s | $0.0100 | $0.0100 | 25% |'
	])
})

test('labelled runs score an eager extractor as keeping often and agreeing rarely', () => {
	const score = scoreLabels(
		['openIssues', 'userGoals', 'contactPreferences'] as const,
		[
			{ id: 'goal', expected: ['userGoals'], kept: ['userGoals'] },
			{ id: 'balance', expected: [], kept: ['userGoals', 'openIssues'] }
		]
	)
	expect(score).toEqual(
		expect.objectContaining({
			runs: 2,
			keepRate: 1,
			agreement: 0.5,
			failures: [expect.objectContaining({ id: 'balance' })]
		})
	)
	expect(score.labels).toEqual({
		openIssues: {
			kept: 1,
			shouldKeep: 0,
			keptCorrectly: 0,
			precision: 0,
			recall: null
		},
		userGoals: {
			kept: 2,
			shouldKeep: 1,
			keptCorrectly: 1,
			precision: 0.5,
			recall: 1
		},
		contactPreferences: {
			kept: 0,
			shouldKeep: 0,
			keptCorrectly: 0,
			precision: null,
			recall: null
		}
	})
})

test('a suite runs each case per repeat, checks it, judges it and runs cache probes one at a time', async () => {
	const cases: EvalCase[] = [
		{
			id: 'a',
			suites: ['cache'],
			bucket: 'answer',
			persona: 'p',
			language: 'en',
			turns: ['Hi'],
			expect: {}
		},
		{
			id: 'b',
			suites: ['cache'],
			bucket: 'act',
			persona: 'p',
			language: 'en',
			turns: ['Hi'],
			expect: { tools: ['x'] }
		}
	]
	let inFlight = 0
	let peak = 0
	const suite = await runEvalSuite(
		{
			cases,
			defaultModel: 'model/a',
			promptVersion: 'p1',
			sequentialSuites: ['cache'],
			judge: { version: 'j1', judge: async () => ({ outcome: 'done' }) },
			run: async (testCase, { modelId }) => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await Bun.sleep(1)
				inFlight -= 1
				return {
					caseId: testCase.id,
					modelId,
					turns: [
						turn({
							replyText: 'You have two open deals and that is it for the week.'
						})
					]
				}
			}
		},
		{ cases, suite: 'cache', repeats: 2, concurrency: 4 }
	)
	expect(peak).toBe(1)
	expect(
		suite.results.map((r) => [r.caseId, r.runs.map((run) => run.pass)])
	).toEqual([
		['a', [true, true]],
		['b', [false, false]]
	])
	expect(suite.judgeVersion).toBe('j1')
	expect(suite.results[0]?.runs[0]?.verdict).toEqual({ outcome: 'done' })
})
