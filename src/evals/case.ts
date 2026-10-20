/**
 * An eval case: one conversation the assistant must handle, sent turn by turn
 * as a persona the app seeds, with what a good answer does. Every bucket
 * should hold cases, so "always acts" and "always asks" both score badly.
 */
export type EvalCase<
	Page = unknown,
	Persona extends string = string,
	Bucket extends string = string,
	Suite extends string = string
> = {
	id: string
	suites: readonly Suite[]
	bucket: Bucket
	/** Who asks: a key into the app's seeded personas. */
	persona: Persona
	/** The language the user writes in, which the reply must follow. */
	language: string
	/** Where the conversation starts; the app's turn reads it. */
	page?: Page
	/**
	 * The user's messages, one per turn, in order. A turn with its own page
	 * was sent from there: the user moved, or the page's data changed.
	 */
	turns: readonly (string | { text: string; page: Page })[]
	expect: EvalExpectation
	tags?: readonly string[]
}

/** Tool names are matched after the checks' `toolName` normalizer. */
export type EvalExpectation = {
	/** Every one of these is called. */
	tools?: readonly string[]
	/** At least one of these is called. */
	anyTool?: readonly string[]
	/** None of these is called. */
	forbidTools?: readonly string[]
	/** No write and no approval card at all. */
	noWrites?: true
	/** The reply names at least one of these (case-insensitive). */
	replyMentionsAny?: readonly string[]
	/** A call to `tool` whose input holds at least one of `anyOf` (case-insensitive). */
	toolInputMentions?: { tool: string; anyOf: readonly string[] }
	/** What a good answer does, in words, for the judge. */
	expectations?: readonly string[]
}

/** Identity function that keeps the case's literal types. */
export function defineEvalCase<const C extends EvalCase<unknown>>(
	testCase: C
): C {
	return testCase
}

/** The text and page of one case turn; a plain string keeps the case's page. */
export function caseTurn<Page>(
	testCase: Pick<EvalCase<Page>, 'page'>,
	turn: EvalCase<Page>['turns'][number]
): { text: string; page: Page | undefined } {
	return typeof turn === 'string'
		? { text: turn, page: testCase.page }
		: { text: turn.text, page: turn.page }
}

export type EvalToolCall = {
	name: string
	state: string
	input: unknown
	output: unknown
	errorText: string | null
}

export type EvalTurn = {
	userText: string
	replyText: string
	toolCalls: EvalToolCall[]
	/** The turn stopped on a card waiting for the user's Confirm. */
	heldForApproval: string[]
	error: string | null
	/** Wait until the first word of the first answer, as the user feels it. */
	firstTextMs: number | null
	durationMs: number
	steps: number
	inputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	outputTokens: number
	costUsd: number | null
}

export type EvalTrace = {
	caseId: string
	modelId: string
	/** Facts the turn's instructions held (profile, status line), so the judge does not call them invented. */
	instructionFacts?: unknown
	turns: EvalTurn[]
}
