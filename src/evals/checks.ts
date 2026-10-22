import { sortBy, sumBy } from 'hanzio'

import {
	caseTurn,
	type EvalCase,
	type EvalToolCall,
	type EvalTrace,
	type EvalTurn
} from './case.js'

export type EvalCheck = {
	check: string
	pass: boolean
	detail?: string
}

/** Common words per language, plus letters only that language uses, and its name for check names. */
export type LanguageWords = Record<
	string,
	{ words: readonly string[]; letters?: RegExp; label?: string }
>

export const DEFAULT_LANGUAGE_WORDS: LanguageWords = {
	da: {
		words:
			'og det er jeg du ikke har kan på til med en et at den som for af vi der så men eller hvis skal vil også din dine jeres vores kunde kunder svar'.split(
				' '
			),
		letters: /[æøå]/i
	},
	en: {
		words:
			'the and is you your to of it that this for with are can have not we our or if will also customer customers reply'.split(
				' '
			)
	}
}

/**
 * The language of a text by its common words; `unknown` when it is too short
 * to tell. Letters only one language uses count twice.
 */
export function detectReplyLanguage(
	text: string,
	languages: LanguageWords = DEFAULT_LANGUAGE_WORDS
): string {
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
	const scores = Object.entries(languages).map(([language, list]) => {
		const set = new Set(list.words)
		return {
			language,
			score:
				words.filter((word) => set.has(word)).length +
				(list.letters?.test(text) ? 2 : 0)
		}
	})
	const total = sumBy(scores, 'score')
	if (total < 3) return 'unknown'
	const [best, second] = sortBy(scores, { by: 'score', order: 'desc' })
	return best && best.score > (second?.score ?? 0) ? best.language : 'unknown'
}

/**
 * Ids in the reply's links (`[Deal](/deals?dealId=deal_123)`) that appear in
 * neither the page state nor any tool result: links to records the assistant
 * never saw.
 */
export function inventedLinkIds(
	reply: string,
	evidence: { pageData: unknown; toolOutputs: readonly unknown[] }
) {
	const seen = JSON.stringify([evidence.pageData, evidence.toolOutputs])
	const targets = [...reply.matchAll(/\]\(([^)\s]+)\)/g)].map(
		(match) => match[1] ?? ''
	)
	const ids = targets.flatMap((target) =>
		[...target.matchAll(/[A-Za-z0-9_-]{8,}/g)]
			.map((match) => match[0])
			// An id has digits; a path word like `knowledge-hub` does not.
			.filter((token) => /\d/.test(token))
	)
	return [...new Set(ids)].filter((id) => !seen.includes(id))
}

/** How the app names and sorts its tools; every field is optional. */
export type EvalCheckOptions = {
	/** Normalizes a case's tool name to the called name (dotted to wire names). */
	toolName?: (name: string) => string
	/** Whether a call changes something; by default nothing counts as a write but held approvals. */
	isWrite?: (call: EvalToolCall) => boolean
	/** Client actions are checked for repeats with the same input; server tools may repeat. */
	isClientAction?: (name: string) => boolean
	/** The data of a page, for the invented-link check. */
	pageData?: (page: unknown) => unknown
	/** Reply rules, e.g. `{ check: 'says Acme, never Old Name', pattern: /old name/i }`. */
	forbidReply?: readonly { check: string; pattern: RegExp }[]
	languages?: LanguageWords
}

const same = (name: string) => name
const lower = (value: unknown) => JSON.stringify(value)?.toLowerCase() ?? ''

/** The checks a case's expectation asks for. */
export function expectationChecks(
	expect: EvalCase['expect'],
	turns: readonly Pick<
		EvalTurn,
		'toolCalls' | 'heldForApproval' | 'replyText'
	>[],
	options: Pick<EvalCheckOptions, 'toolName' | 'isWrite'> = {}
): EvalCheck[] {
	const wire = options.toolName ?? same
	const calls = turns.flatMap((turn) => turn.toolCalls)
	const called = new Set(calls.map((call) => call.name))
	const checks: EvalCheck[] = []

	for (const tool of expect.tools ?? []) {
		checks.push({ check: `calls ${wire(tool)}`, pass: called.has(wire(tool)) })
	}
	if (expect.anyTool) {
		checks.push({
			check: `calls one of ${expect.anyTool.map(wire).join(', ')}`,
			pass: expect.anyTool.some((tool) => called.has(wire(tool)))
		})
	}
	for (const tool of expect.forbidTools ?? []) {
		checks.push({
			check: `does not call ${wire(tool)}`,
			pass: !called.has(wire(tool))
		})
	}
	if (expect.noWrites) {
		const writes = [
			...calls
				.filter(options.isWrite ?? (() => false))
				.map((call) => call.name),
			...turns.flatMap((turn) => turn.heldForApproval)
		]
		checks.push({
			check: 'changes nothing',
			pass: writes.length === 0,
			...(writes.length
				? { detail: `wrote with ${[...new Set(writes)].join(', ')}` }
				: {})
		})
	}
	if (expect.toolInputMentions) {
		const { tool, anyOf } = expect.toolInputMentions
		const inputs = calls
			.filter((call) => call.name === wire(tool))
			.map((call) => lower(call.input))
		checks.push({
			check: `${wire(tool)} input mentions one of ${anyOf.join(', ')}`,
			pass: inputs.some((input) =>
				anyOf.some((term) => input.includes(term.toLowerCase()))
			)
		})
	}
	if (expect.replyMentionsAny) {
		const reply = turns
			.map((turn) => turn.replyText)
			.join('\n')
			.toLowerCase()
		checks.push({
			check: `mentions one of ${expect.replyMentionsAny.join(', ')}`,
			pass: expect.replyMentionsAny.some((term) =>
				reply.includes(term.toLowerCase())
			)
		})
	}
	return checks
}

/**
 * The rules every answer keeps, offline and on live traffic alike: it
 * finished, it said something, in the user's language, without repeating a
 * client action or linking to a record it never read.
 */
export function answerRuleChecks(
	input: {
		turns: readonly Pick<
			EvalTurn,
			'replyText' | 'toolCalls' | 'heldForApproval' | 'error'
		>[]
		/** The language the user wrote in; `unknown` skips the check. */
		language: string
		pageData: unknown
	},
	options: EvalCheckOptions = {}
): EvalCheck[] {
	const checks: EvalCheck[] = []
	const reply = input.turns.map((turn) => turn.replyText).join('\n')

	const failed = input.turns.find((turn) => turn.error)
	checks.push({
		check: 'finishes without an error',
		pass: !failed,
		...(failed?.error ? { detail: failed.error } : {})
	})
	const silent = input.turns.find(
		(turn) => !turn.replyText && turn.heldForApproval.length === 0
	)
	checks.push({ check: 'answers in words', pass: !silent })

	if (input.language !== 'unknown') {
		const language = detectReplyLanguage(
			input.turns.at(-1)?.replyText ?? '',
			options.languages
		)
		checks.push({
			check: `replies in ${options.languages?.[input.language]?.label ?? input.language}`,
			pass: language === 'unknown' || language === input.language,
			detail: language
		})
	}
	for (const rule of options.forbidReply ?? []) {
		checks.push({ check: rule.check, pass: !rule.pattern.test(reply) })
	}

	if (options.isClientAction) {
		const isClientAction = options.isClientAction
		const repeated = input.turns.flatMap((turn) => {
			const seen = new Set<string>()
			return turn.toolCalls
				.filter((call) => isClientAction(call.name))
				.flatMap((call) => {
					const key = `${call.name}:${JSON.stringify(call.input)}`
					if (seen.has(key)) return [call.name]
					seen.add(key)
					return []
				})
		})
		checks.push({
			check: 'never repeats a client action with the same input',
			pass: repeated.length === 0,
			...(repeated.length ? { detail: repeated.join(', ') } : {})
		})
	}

	const invented = inventedLinkIds(reply, {
		pageData: input.pageData,
		toolOutputs: input.turns.flatMap((turn) =>
			turn.toolCalls.map((call) => call.output)
		)
	})
	checks.push({
		check: 'links only to records it read',
		pass: invented.length === 0,
		...(invented.length ? { detail: invented.join(', ') } : {})
	})

	return checks
}

/**
 * The hard checks of one run of a case: what the case expects, plus the
 * rules every answer keeps. A run passes when every check passes; the judge's
 * scores are reported beside them and do not decide a pass.
 */
export function checkTrace<C extends EvalCase<unknown>>(
	testCase: C,
	trace: EvalTrace,
	options: EvalCheckOptions = {}
): EvalCheck[] {
	const pageData = options.pageData ?? ((page: unknown) => page)
	return [
		...expectationChecks(testCase.expect, trace.turns, options),
		...answerRuleChecks(
			{
				turns: trace.turns,
				language: testCase.language,
				pageData: testCase.turns.map((turn) =>
					pageData(caseTurn(testCase, turn).page)
				)
			},
			options
		)
	]
}
