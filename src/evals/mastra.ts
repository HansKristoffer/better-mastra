/**
 * The Mastra-native path: `runEvals`, datasets and experiments are Mastra's;
 * this is the glue both apps wrote around them. Reading a scorer run, the
 * hard checks as a scorer, datasets kept equal to a case file by
 * `externalId`, chat turns copied into a dataset with their tool results as
 * mocks, and replaying recorded tool reads with Mastra's mock matcher.
 */
import type { Agent, MastraDBMessage } from '@mastra/core/agent'
import type { Dataset } from '@mastra/core/datasets'
import {
	type ItemToolMock,
	type ToolMockResolution,
	ToolMockMatcher
} from '@mastra/core/datasets'
import {
	createScorer,
	type MastraScorer,
	notScorable,
	type ScorerRunInputForAgent
} from '@mastra/core/evals'
import type { Mastra } from '@mastra/core/mastra'
import type { RequestContext } from '@mastra/core/request-context'
import type {
	DatasetItem,
	DatasetItemPayload,
	DatasetItemToolMock
} from '@mastra/core/storage'
import { isRecord, mapValues, stableStringify, typedSwitch } from 'hanzio'
import type { EvalCase, EvalToolCall, EvalTrace } from './case.js'
import { checkTrace, type EvalCheckOptions } from './checks.js'

/** The scorer type `runEvals` and experiments take. */
// biome-ignore lint/suspicious/noExplicitAny: runEvals and experiments take MastraScorer<any, any, any, any>, which a narrower scorer type does not satisfy
export type EvalScorer = MastraScorer<string, any, any, any>

/** The part of a Mastra agent scorer run the helpers read. */
export type ScorerRun = {
	input?: ScorerRunInputForAgent
	output: readonly MastraDBMessage[]
	groundTruth?: unknown
	requestContext?: unknown
}

type MessagePart = MastraDBMessage['content']['parts'][number]
type ToolInvocationPart = Extract<MessagePart, { type: 'tool-invocation' }>

export type RunToolResult = {
	toolName: string
	input: unknown
	output: unknown
	/** The text the model saw (`providerMetadata.mastra.modelOutput`), else the output as JSON. */
	displayText: string
	/** The call failed: it threw, or the run ended before it had a result. A call that waits for the user is not one. */
	isError: boolean
	/**
	 * The call waits for the user's approval, or suspended its run until the
	 * user resumes it. An eval never answers, so the run ends on it: it is the
	 * answer's proposal, not a failure.
	 */
	isWaiting: boolean
}

/**
 * The run's messages, each once. A follow-up turn's output repeats the earlier
 * turns' messages; each keeps the place it first appeared, with its latest copy.
 */
function uniqueMessages(output: readonly MastraDBMessage[]) {
	return [...new Map(output.map((message) => [message.id, message])).values()]
}

/**
 * An answer's text as `@mastra/evals` reads it (`extractAgentResponseMessages`):
 * the stored text, else its last text part. Read here so the evals entry
 * loads without that optional peer.
 */
function answerText(message: MastraDBMessage): string {
	const { content } = message

	if (typeof content.content === 'string' && content.content !== '') {
		return content.content
	}

	const texts = content.parts.flatMap((part) =>
		part.type === 'text' ? [part.text] : []
	)

	return texts.at(-1) ?? ''
}

function textOf(value: unknown): string {
	if (typeof value === 'string') return value
	const text = isRecord(value) ? value.value : undefined
	return typeof text === 'string' ? text : JSON.stringify(value)
}

/**
 * The ids of the calls a message left waiting for the user: Mastra lists
 * them in the metadata of the message that made them.
 */
function waitingCallIds(message: MastraDBMessage): string[] {
	const { metadata } = message.content
	return [metadata?.pendingToolApprovals, metadata?.suspendedTools]
		.filter(isRecord)
		.flatMap((calls) => Object.values(calls))
		.flatMap((call) =>
			isRecord(call) && typeof call.toolCallId === 'string'
				? [call.toolCallId]
				: []
		)
}

function toolResultOf(
	part: ToolInvocationPart,
	waiting: ReadonlySet<string> = new Set()
): RunToolResult {
	const invocation = part.toolInvocation
	const modelOutput = part.providerMetadata?.mastra?.modelOutput
	const output = 'result' in invocation ? invocation.result : undefined
	const isWaiting =
		invocation.state === 'call' && waiting.has(invocation.toolCallId)
	return {
		toolName: invocation.toolName,
		input: invocation.args,
		output,
		displayText:
			modelOutput === undefined
				? (JSON.stringify(output) ?? '')
				: textOf(modelOutput),
		isError:
			!isWaiting &&
			(invocation.state !== 'result' ||
				('isError' in invocation && invocation.isError === true)),
		isWaiting
	}
}

/** Every tool call of the run's messages, in order. */
function toolCallsOf(messages: readonly MastraDBMessage[]) {
	const waiting = new Set(messages.flatMap(waitingCallIds))
	return messages.flatMap((message) =>
		message.content.parts.flatMap((part) =>
			part.type === 'tool-invocation'
				? [{ part, result: toolResultOf(part, waiting) }]
				: []
		)
	)
}

/**
 * What scorers read from a run: the answers in order, the tools called
 * (failed and waiting calls included), each successful tool result with the
 * text the model saw, the calls that failed, and the calls left waiting for
 * the user's approval or resume.
 */
export function readRunOutput(output: readonly MastraDBMessage[]) {
	const messages = uniqueMessages(output)
	const calls = toolCallsOf(messages).map(({ result }) => result)
	return {
		answers: messages
			.filter((message) => message.role === 'assistant')
			.map(answerText)
			.filter((answer) => answer.trim() !== ''),
		calledTools: calls.map((call) => call.toolName),
		toolResults: calls.filter((call) => !call.isError && !call.isWaiting),
		failedCalls: calls.filter((call) => call.isError),
		waitingCalls: calls.filter((call) => call.isWaiting)
	}
}

/** A scorer run as a one-turn trace, so the hard checks score Mastra runs too. */
export function traceOfRun(run: ScorerRun, modelId = 'unknown'): EvalTrace {
	const output = readRunOutput(run.output)
	const calls = toolCallsOf(uniqueMessages(run.output)).map(
		({ part, result }): EvalToolCall => ({
			name: result.toolName,
			state: part.toolInvocation.state,
			input: result.input,
			output: result.output ?? null,
			errorText: result.isError ? result.displayText : null
		})
	)
	return {
		caseId: '',
		modelId,
		turns: [
			{
				userText: '',
				replyText: output.answers.join('\n'),
				toolCalls: calls,
				heldForApproval: output.waitingCalls.map((call) => call.toolName),
				error: null,
				firstTextMs: null,
				durationMs: 0,
				steps: 0,
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
				costUsd: null
			}
		]
	}
}

/**
 * The hard checks as a Mastra scorer: 1 when every check passes, else 0 with
 * the failed checks as the reason. Mastra's `checks.calledTool()` scorers
 * share one id and overwrite each other, so this gives one clean 1 or 0.
 */
export function createChecksScorer<C extends EvalCase<unknown>>(options: {
	id?: string
	name?: string
	/** The case a run belongs to, usually by its ground truth; undefined is not scorable. */
	caseOf: (run: ScorerRun) => C | undefined
	checks?: EvalCheckOptions
}): EvalScorer {
	return createScorer({
		id: options.id ?? 'eval-checks',
		name: options.name ?? 'Hard checks',
		description: 'Whether the run passes every hard check of its case.',
		type: 'agent'
	})
		.preprocess(({ run }) => {
			const testCase = options.caseOf(run as ScorerRun)
			if (!testCase) return notScorable('The run has no eval case.')
			const failed = checkTrace(
				testCase,
				traceOfRun(run as ScorerRun),
				options.checks
			).filter((check) => !check.pass)
			return {
				score: failed.length === 0 ? 1 : 0,
				reason: failed.length
					? failed
							.map((check) =>
								check.detail ? `${check.check} (${check.detail})` : check.check
							)
							.join('; ')
					: 'Every check passes.'
			}
		})
		.generateScore(({ results }) => results.preprocessStepResult.score)
		.generateReason(({ results }) => results.preprocessStepResult.reason)
}

/**
 * 1 when no tool call of the run failed, else 0 with the failed tools as the
 * reason. Use it in place of `checks.noToolErrors()` from `@mastra/evals`,
 * which counts a call waiting for the user's approval as a failure: an eval
 * never approves, so that call is what the answer proposes.
 */
export function createNoToolErrorsScorer(
	options: { id?: string; name?: string } = {}
): EvalScorer {
	return createScorer({
		id: options.id ?? 'eval-no-tool-errors',
		name: options.name ?? 'No tool errors',
		description:
			'Whether every tool call of the run succeeded; a call waiting for approval is a proposal, not an error.',
		type: 'agent'
	})
		.preprocess(({ run }) => ({
			failed: readRunOutput((run as ScorerRun).output).failedCalls.map(
				(call) => call.toolName
			)
		}))
		.generateScore(({ results }) =>
			results.preprocessStepResult.failed.length === 0 ? 1 : 0
		)
		.generateReason(({ results }) => {
			const { failed } = results.preprocessStepResult
			return failed.length === 0
				? 'No tool call failed.'
				: `Failed tool calls: ${failed.join(', ')}.`
		})
}

/**
 * 1 when the run called the tool, else 0. Its id holds the tool's name
 * (`eval-called-<tool>`), so several of them score one run side by side:
 * `checks.calledTool()` from `@mastra/evals` gives every one the same id, and
 * each overwrites the one before it.
 */
export function createCalledToolScorer(
	toolName: string,
	options: { id?: string; name?: string } = {}
): EvalScorer {
	return createScorer({
		id: options.id ?? `eval-called-${toolName}`,
		name: options.name ?? `Called ${toolName}`,
		description: `Whether the run called ${toolName}.`,
		type: 'agent'
	})
		.preprocess(({ run }) => ({
			called: readRunOutput((run as ScorerRun).output).calledTools
		}))
		.generateScore(({ results }) =>
			results.preprocessStepResult.called.includes(toolName) ? 1 : 0
		)
		.generateReason(({ results }) => {
			const { called } = results.preprocessStepResult
			return called.includes(toolName)
				? `The run called ${toolName}.`
				: `The run did not call ${toolName}; it called ${called.join(', ') || 'no tool'}.`
		})
}

export type DatasetDefinition = {
	id: string
	name: string
	description: string
}
export type DatasetItemWithId = DatasetItemPayload & { externalId: string }

/**
 * A case as a dataset item: its turns as input, its id and expectation as
 * ground truth, and who it runs as as metadata.
 */
export function toDatasetItem(
	testCase: EvalCase<unknown>,
	metadata: Record<string, unknown> = {}
): DatasetItemWithId {
	return {
		externalId: testCase.id,
		input: testCase.turns,
		groundTruth: { caseId: testCase.id, expect: testCase.expect },
		metadata: {
			persona: testCase.persona,
			language: testCase.language,
			bucket: testCase.bucket,
			suites: testCase.suites,
			tags: testCase.tags ?? [],
			...metadata
		}
	}
}

/**
 * The case a run belongs to, by its ground truth's `caseId`, read from the
 * case file so a stale dataset is scored by the reviewed cases.
 */
export function caseOfRun<C extends EvalCase<unknown>>(
	run: Pick<ScorerRun, 'groundTruth'>,
	cases: readonly C[]
): C | undefined {
	const truth = run.groundTruth as { caseId?: unknown } | undefined
	if (typeof truth?.caseId !== 'string') return undefined
	return cases.find((testCase) => testCase.id === truth.caseId)
}

/** The dataset with the definition's id, created when it does not exist yet. */
export async function findOrCreateDataset(
	mastra: Mastra,
	definition: DatasetDefinition
): Promise<Dataset> {
	try {
		return await mastra.datasets.get({ id: definition.id })
	} catch (error) {
		const notFound = isRecord(error) && error.id === 'DATASET_NOT_FOUND'
		if (!notFound) throw error
		return mastra.datasets.create({ ...definition, targetType: 'agent' })
	}
}

/** Every item of the dataset's latest version. */
export async function listDatasetItems(dataset: Dataset) {
	const { version } = await dataset.getDetails()
	const items = await dataset.listItems({ version })
	return Array.isArray(items) ? items : items.items
}

/** Keys sorted, because Postgres hands JSON back reordered. */
const comparable = (
	item: Pick<DatasetItem, 'input' | 'groundTruth' | 'metadata'>
) => stableStringify([item.input, item.groundTruth, item.metadata ?? null])

/** The changes that make the stored items match: new ones added, changed ones updated, the rest deleted. */
export function planDatasetSync(
	items: readonly DatasetItemWithId[],
	stored: readonly DatasetItem[]
) {
	const byExternalId = new Map(
		stored.flatMap((item) =>
			item.externalId ? [[item.externalId, item] as const] : []
		)
	)
	const ids = new Set(items.map((item) => item.externalId))
	return {
		add: items.filter((item) => !byExternalId.has(item.externalId)),
		update: items.flatMap((item) => {
			const old = byExternalId.get(item.externalId)
			return old && comparable(old) !== comparable(item)
				? [{ itemId: old.id, item }]
				: []
		}),
		remove: stored
			.filter((item) => !item.externalId || !ids.has(item.externalId))
			.map((item) => item.id)
	}
}

/**
 * Keeps a Mastra dataset equal to the case file: datasets cannot live in
 * files, so the file is the source and each item is keyed by `externalId`.
 */
export async function syncDataset(
	mastra: Mastra,
	definition: DatasetDefinition,
	items: readonly DatasetItemWithId[]
) {
	const dataset = await findOrCreateDataset(mastra, definition)
	const plan = planDatasetSync(items, await listDatasetItems(dataset))
	if (plan.add.length) await dataset.addItems({ items: [...plan.add] })
	for (const { itemId, item } of plan.update) {
		await dataset.updateItem({
			itemId,
			input: item.input,
			groundTruth: item.groundTruth,
			...(item.metadata ? { metadata: item.metadata } : {})
		})
	}
	if (plan.remove.length) await dataset.deleteItems({ itemIds: plan.remove })
	return {
		dataset,
		added: plan.add.length,
		updated: plan.update.length,
		removed: plan.remove.length
	}
}

function messageText(message: MastraDBMessage) {
	return message.content.parts
		.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join('\n')
}

/**
 * Chosen user turns of a stored thread as dataset items: the user's message
 * as input, that turn's tool results as tool mocks matched by name in the
 * recorded order (a replay asks for dates relative to its own run), every
 * other tool denied, and ground truth for a person to fill in.
 */
export function threadTurnsToDatasetItems(input: {
	messages: readonly MastraDBMessage[]
	messageIds: readonly string[]
	externalIdPrefix?: string
	groundTruth?: (externalId: string) => unknown
	metadata?: (userMessage: MastraDBMessage) => Record<string, unknown>
}): DatasetItemWithId[] {
	return input.messageIds.map((messageId) => {
		const index = input.messages.findIndex(({ id }) => id === messageId)
		const user = input.messages[index]
		if (user?.role !== 'user') {
			throw new Error(
				`Message ${messageId} is not a user message of the thread.`
			)
		}
		const rest = input.messages.slice(index + 1)
		const next = rest.findIndex(({ role }) => role === 'user')
		const answer = next === -1 ? rest : rest.slice(0, next)
		const externalId = `${input.externalIdPrefix ?? 'thread-turn:'}${messageId}`
		const metadata = input.metadata?.(user)
		return {
			externalId,
			input: [messageText(user)],
			groundTruth: input.groundTruth?.(externalId) ?? { caseId: externalId },
			toolMocks: answer.flatMap((message) =>
				message.content.parts.flatMap((part): DatasetItemToolMock[] => {
					if (part.type !== 'tool-invocation') return []
					const result = toolResultOf(part)
					if (result.isError) return []
					return [
						{
							toolName: result.toolName,
							args: (result.input ?? {}) as Record<string, unknown>,
							output: result.output,
							matchArgs: 'ignore'
						}
					]
				})
			),
			unmockedToolPolicy: 'deny',
			...(metadata ? { metadata } : {})
		}
	})
}

/**
 * Agent `generate`/`stream` options that serve an item's tool mocks with
 * Mastra's matcher: one call at a time, so mocks are used in order.
 */
export function toolMockOptions(matcher: ToolMockMatcher) {
	if (!matcher.hasMocks && matcher.unmockedToolPolicy !== 'deny') return {}
	return {
		toolCallConcurrency: 1,
		hooks: {
			beforeToolCall: ({
				toolName,
				input
			}: {
				toolName: string
				input: unknown
			}) => hookResult(matcher.resolve(toolName, input))
		}
	}
}

function hookResult(resolution: ToolMockResolution) {
	return typedSwitch(resolution, 'kind', {
		serve: (serve) => ({ proceed: false as const, output: serve.output }),
		fail: (fail) => ({
			proceed: false as const,
			output: { error: fail.code }
		}),
		live: () => undefined
	})
}

/** What an experiment hands its task for one item. */
export type ExperimentTaskArgs = {
	input: unknown
	groundTruth?: unknown
	metadata?: Record<string, unknown>
	signal?: AbortSignal
}

/** One item's run as the app prepared it. */
export type PreparedExperimentRun = {
	/** The run's request context, with whatever the app keeps beside it (a turn plan, a caller). */
	// biome-ignore lint/suspicious/noExplicitAny: a typed and an untyped RequestContext are both assignable only to this
	requestContext: RequestContext<any>
	/** The thread the item's turns share. Without it each turn runs without memory. */
	memory?: { thread: string; resource: string }
	/** Messages put first in the output, for scorers that read what the model was told (a per-request signal). */
	outputPrefix?: readonly MastraDBMessage[]
	/** The item's tool mocks; calls are then served one at a time, in order. */
	toolMocks?: {
		mocks?: readonly DatasetItemToolMock[] | null
		unmockedToolPolicy?: 'allow' | 'deny' | null
	}
}

/**
 * An experiment task that runs each item through the agent with a request
 * context the app prepared. An experiment's agent target builds the request
 * context from plain values, so what a production turn keeps beside it (the
 * turn plan `runChatTurn` remembers, a caller in a holder) is missing and the
 * agent cannot run. This task prepares the item as your production turn does,
 * sends the item's turns (a string, or a list of strings as `toDatasetItem`
 * writes them) on one thread, and returns the output messages scorers read.
 * A call that matches none of the item's mocks, under policy `deny`, fails
 * the item.
 *
 * `dataset.startExperiment({ task: createExperimentTask({ agent, prepare }), scorers })`
 */
export function createExperimentTask(options: {
	agent: Pick<Agent, 'generate'>
	prepare: (
		args: ExperimentTaskArgs
	) => PreparedExperimentRun | Promise<PreparedExperimentRun>
}): (args: ExperimentTaskArgs) => Promise<MastraDBMessage[]> {
	return async (args) => {
		const prepared = await options.prepare(args)
		const matcher = new ToolMockMatcher(
			prepared.toolMocks?.mocks ? [...prepared.toolMocks.mocks] : undefined,
			prepared.toolMocks?.unmockedToolPolicy ?? 'allow'
		)
		const output = [...(prepared.outputPrefix ?? [])]

		for (const turn of turnsOfInput(args.input)) {
			const result = await options.agent.generate(turn, {
				requestContext: prepared.requestContext,
				...(prepared.memory && { memory: prepared.memory }),
				...(args.signal && { abortSignal: args.signal }),
				returnScorerData: true,
				...toolMockOptions(matcher)
			})

			output.push(...(result.scoringData?.output ?? []))
		}

		const { failure } = matcher.report()
		if (failure) {
			throw new Error(
				`The run called ${failure.toolName} without a matching mock (${failure.code}).`
			)
		}

		return output
	}
}

function turnsOfInput(input: unknown): string[] {
	const turns = Array.isArray(input) ? input : [input]
	const texts = turns.map((turn) =>
		isRecord(turn) && typeof turn.text === 'string' ? turn.text : turn
	)
	if (texts.length === 0 || !texts.every((text) => typeof text === 'string')) {
		throw new Error(
			"An experiment item's input must be a message or a list of messages."
		)
	}
	return texts
}

export type RecordedToolRead = {
	toolName: string
	input: unknown
	output: unknown
}

type Executable = { execute?: (input: never, context: never) => unknown }

/**
 * The tools with every execute served from recorded reads: each keeps its
 * name, description and schemas, so the model sees the tools it decided
 * with. A call that matches no read (strict arguments) gets an error back
 * and is recorded, as `unmockedToolPolicy: 'deny'` would.
 */
export function replayRecordedTools<T extends Record<string, Executable>>(
	tools: T,
	reads: readonly RecordedToolRead[],
	matchArgs: ItemToolMock['matchArgs'] = 'strict'
) {
	const matcher = new ToolMockMatcher(
		reads.map((read) => ({
			toolName: read.toolName,
			args: isRecord(read.input) ? read.input : {},
			output: read.output,
			matchArgs
		})),
		'deny'
	)
	const unmatched: { toolName: string; input: unknown; code: string }[] = []
	const serve = (toolName: string) => async (input: unknown) => {
		const unmatchedRead = (code: string) => {
			unmatched.push({ toolName, input, code })
			return { error: `No recorded read matches this call (${code}).` }
		}
		return typedSwitch(matcher.resolve(toolName, input), 'kind', {
			serve: (serve) => serve.output,
			fail: (fail) => unmatchedRead(fail.code),
			live: () => unmatchedRead('TOOL_MOCK_NOT_DECLARED')
		})
	}
	return {
		// A copy with the same prototype and fields, so the real tool stays as it was.
		tools: mapValues(tools, (tool, name) =>
			Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
				execute: serve(name)
			})
		) as T,
		unmatchedCalls: () => [...unmatched]
	}
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Throws unless the app runs in development against a database on this
 * machine: datasets, experiments and copied chats hold message text.
 */
export function assertLocalDatabase(
	env: Readonly<Record<string, string | undefined>>,
	options: { databaseUrl?: string; appEnv?: string; development?: string } = {}
) {
	const appEnv = options.appEnv ?? 'APP_ENV'
	const development = options.development ?? 'development'
	if (env[appEnv] !== development) {
		throw new Error(`This script runs only with ${appEnv}=${development}.`)
	}
	const url = env[options.databaseUrl ?? 'DATABASE_URL']
	const host = url && URL.canParse(url) ? new URL(url).hostname : undefined
	if (!host || !LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			'This script runs only against a database on this machine; the database URL names another host.'
		)
	}
}
