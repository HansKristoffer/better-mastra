import { RequestContext } from '@mastra/core/request-context'
import type { Tool } from '@mastra/core/tools'
import {
	getToolName,
	isTextUIPart,
	isToolUIPart,
	readUIMessageStream,
	type UIMessage,
	type UIMessageChunk
} from 'ai'
import { getErrorMessage, pMap, timeoutSignal } from 'hanzio'
import {
	caseTurn,
	type EvalCase,
	type EvalToolCall,
	type EvalTrace,
	type EvalTurn
} from './case.js'
import { DRY_RUN_KEY, dryRunResult } from '../tools/dryRun.js'

/**
 * Request-context key an eval run sets: write tools wrapped in
 * `withEvalDryRun`, and tools of `better-mastra/tools` (`isDryRun`), record
 * the call and return a marker instead of writing, so a case can run again
 * and again against the same seeded data. No route sets it.
 */
export const EVAL_DRY_RUN_KEY = DRY_RUN_KEY

export function isEvalDryRun(
	requestContext: { get(key: string): unknown } | undefined,
	key = EVAL_DRY_RUN_KEY
) {
	return requestContext?.get(key) === true
}

/** The tool, answering with a dry-run marker inside an eval run instead of writing. */
export function withEvalDryRun<T extends Pick<Tool, 'id' | 'execute'>>(
	tool: T,
	key = EVAL_DRY_RUN_KEY
): T {
	const execute = tool.execute
	if (!execute) return tool
	return {
		...tool,
		execute: ((input, context) =>
			isEvalDryRun(context?.requestContext, key)
				? Promise.resolve(dryRunResult(tool.id))
				: execute(input, context)) as typeof execute
	}
}

/** Token usage of one model call or one turn, as the turn reports it. */
export type EvalUsage = {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	modelId?: string
	/** The request's steps, for a route that prices a call from them (OpenRouter reports cost per step). */
	steps?: readonly unknown[]
}

export type EvalTurnInput<C> = {
	testCase: C
	threadId: string
	/**
	 * A new user turn sends only its message; a resume after client actions
	 * sends the whole thread, as the clients do.
	 */
	messages: UIMessage[]
	resuming: boolean
	page: C extends EvalCase<infer Page> ? Page | undefined : unknown
	/** Holds the dry-run key; pass it (or its entries) to the agent. */
	requestContext: RequestContext
	abortSignal: AbortSignal
	/** Call once per model call or once per turn with the tokens it used. */
	reportUsage: (usage: EvalUsage) => void
}

/** The app's production turn: anything that returns the turn's UI message stream. */
export type EvalTurnRunner<C> = (
	input: EvalTurnInput<C>
) => ReadableStream<UIMessageChunk> | Promise<ReadableStream<UIMessageChunk>>

export type RunEvalCaseOptions<C extends EvalCase<unknown>> = {
	case: C
	runTurn: EvalTurnRunner<C>
	modelId: string
	/**
	 * Answers a tool call the way the browser or app would (a page action),
	 * or returns `undefined` when the call is not a client action.
	 */
	answerClientAction?: (
		call: { name: string; input: unknown },
		testCase: C
	) => unknown
	dryRunKey?: string
	/** USD for the usage, or null when unknown. */
	cost?: (
		usage: EvalUsage,
		modelId: string
	) => number | null | Promise<number | null>
	/** Called after the last turn, e.g. to delete the thread. */
	cleanup?: (threadId: string) => unknown
	instructionFacts?: unknown
	/** Client-action round trips one turn may take, like the clients' 8. */
	maxResubmits?: number
	/** A request that has not finished by now is a failure, not a slow pass. */
	timeoutMs?: number
}

type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>

function toolParts(message: UIMessage | undefined): ToolPart[] {
	return (message?.parts ?? []).filter(isToolUIPart) as ToolPart[]
}

function replyText(message: UIMessage | undefined) {
	return (message?.parts ?? [])
		.flatMap((part) => (isTextUIPart(part) ? [part.text] : []))
		.join('')
		.trim()
}

export function toEvalToolCall(part: ToolPart): EvalToolCall {
	return {
		name: getToolName(part),
		state: part.state,
		input: part.input ?? null,
		output: 'output' in part ? (part.output ?? null) : null,
		errorText: 'errorText' in part ? (part.errorText ?? null) : null
	}
}

function userMessage(text: string): UIMessage {
	return {
		id: crypto.randomUUID(),
		role: 'user',
		parts: [{ type: 'text', text }]
	}
}

/** The assistant's latest snapshot as the thread's last message, never twice. */
function keepLatest(transcript: UIMessage[], assistant: UIMessage) {
	if (transcript.at(-1)?.role === 'assistant') transcript.pop()
	transcript.push(assistant)
}

function emptyTurn(userText: string): EvalTurn {
	return {
		userText,
		replyText: '',
		toolCalls: [],
		heldForApproval: [],
		error: null,
		firstTextMs: null,
		durationMs: 0,
		steps: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		costUsd: 0
	}
}

/**
 * Runs one case through the app's production turn on a fresh thread. A stub
 * client answers client actions and resubmits; an approval card ends the turn
 * unanswered. Per turn it records the reply, tool calls, held approvals, time
 * to first text, duration, steps, tokens and cost.
 */
export async function runEvalCase<C extends EvalCase<unknown>>(
	options: RunEvalCaseOptions<C>
): Promise<EvalTrace> {
	const testCase = options.case
	const maxResubmits = options.maxResubmits ?? 8
	const timeoutMs = options.timeoutMs ?? 120_000
	const threadId = crypto.randomUUID()
	const requestContext = new RequestContext()
	requestContext.set(options.dryRunKey ?? EVAL_DRY_RUN_KEY, true)
	const turns: EvalTurn[] = []
	const transcript: UIMessage[] = []

	try {
		for (const raw of testCase.turns) {
			const { text, page } = caseTurn(testCase, raw)
			const turn = emptyTurn(text)
			turns.push(turn)
			transcript.push(userMessage(text))
			let assistant: UIMessage | undefined

			for (let round = 0; round <= maxResubmits; round += 1) {
				const usage: EvalUsage[] = []
				const abortSignal = timeoutSignal(timeoutMs)
				const resuming = round > 0
				const startedAt = performance.now()
				let firstTextAt: number | null = null
				try {
					const stream = await options.runTurn({
						testCase,
						threadId,
						messages: resuming ? [...transcript] : transcript.slice(-1),
						resuming,
						page: page as EvalTurnInput<C>['page'],
						requestContext,
						abortSignal,
						reportUsage: (record) => usage.push(record)
					})
					const observed = stream.pipeThrough(
						new TransformStream<UIMessageChunk, UIMessageChunk>({
							transform(chunk, controller) {
								if (chunk.type === 'start-step') turn.steps += 1
								if (chunk.type === 'text-delta' && firstTextAt === null) {
									firstTextAt = performance.now()
								}
								controller.enqueue(chunk)
							}
						})
					)
					for await (const snapshot of readUIMessageStream({
						stream: observed,
						...(resuming && assistant ? { message: assistant } : {})
					})) {
						assistant = snapshot
					}
				} catch (error) {
					turn.error = abortSignal.aborted
						? `timed out after ${timeoutMs / 1000}s`
						: getErrorMessage(error)
				}

				// A turn that opens with a client action shows its first words in a
				// later round: count the rounds the user already waited through.
				if (turn.firstTextMs === null && firstTextAt !== null) {
					turn.firstTextMs = turn.durationMs + (firstTextAt - startedAt)
				}
				turn.durationMs += performance.now() - startedAt
				for (const record of usage) {
					turn.inputTokens += record.inputTokens ?? 0
					turn.outputTokens += record.outputTokens ?? 0
					turn.cacheReadTokens += record.cacheReadTokens ?? 0
					turn.cacheWriteTokens += record.cacheWriteTokens ?? 0
					const cost = options.cost
						? await options.cost(record, record.modelId ?? options.modelId)
						: null
					turn.costUsd =
						cost === null || turn.costUsd === null ? null : turn.costUsd + cost
				}
				if (turn.error || !assistant) break

				const parts = toolParts(assistant)
				turn.heldForApproval = parts
					.filter((part) => part.state === 'approval-requested')
					.map((part) => getToolName(part))
				const answered = parts.flatMap((part) => {
					if (part.state !== 'input-available') return []
					const output = options.answerClientAction?.(
						{ name: getToolName(part), input: part.input },
						testCase
					)
					return output === undefined ? [] : [{ part, output }]
				})
				if (turn.heldForApproval.length > 0 || answered.length === 0) break

				// Answer the client actions the way the client does, then resubmit.
				for (const { part, output } of answered) {
					Object.assign(part, { state: 'output-available', output })
				}
				keepLatest(transcript, assistant)
			}

			if (assistant) keepLatest(transcript, assistant)
			turn.replyText = replyText(assistant)
			turn.toolCalls = toolParts(assistant).map(toEvalToolCall)
			if (turn.error) break
		}
	} finally {
		await options.cleanup?.(threadId)
	}

	return {
		caseId: testCase.id,
		modelId: options.modelId,
		...(options.instructionFacts === undefined
			? {}
			: { instructionFacts: options.instructionFacts }),
		turns
	}
}

/** Maps the items with at most `limit` in flight, keeping their order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	return pMap(items, work, { concurrency: Math.max(1, limit) })
}
